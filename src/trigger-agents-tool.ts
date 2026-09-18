import { Type } from "@sinclair/typebox";
import { AuthError, requireAuthenticatedClient, isPauseForReviewText, type ProjectStatus, determineContinueButtonLabel } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { groupAgents, hasGeneratedData } from "./command.ts";
import { readActiveModel } from "./model-state.ts";
import { extractPendingSuggestion, type PendingSuggestion } from "./suggested-agents.ts";
import { readLatestSuggestionsForProject, writeLatestSuggestions } from "./suggestions-state.ts";
import { silentToolResult } from "./exact-response.ts";
import { formatStartBuildingTasks } from "./task-summary.ts";
import { getInsufficientCreditsMessageFromError, precheckStartBuildingCredits } from "./start-building-credits.ts";
import { getDesignPreviewText } from "./design-preview.ts";
import { log } from "../logger.ts";

function statusHasReviewCheckpoint(status: ProjectStatus): boolean {
  const messages = Array.isArray(status.messages) ? status.messages : [];
  return messages.some((message) => isPauseForReviewText(message.content));
}

function statusHasBackendContinue(status: ProjectStatus): boolean {
  return extractPendingSuggestion(status.pending_suggested_agents).agents.includes("continue");
}

function hasSameAgents(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((agent) => right.includes(agent));
}

function isPlanningActivityLog(entry: { action?: string | null; agent_type?: string | null; summary?: string | null }): boolean {
  const action = String(entry.action ?? "").toLowerCase();
  const agentType = String(entry.agent_type ?? "").toLowerCase();
  const summary = String(entry.summary ?? "").toLowerCase();

  if (action !== "started" && action !== "running" && action !== "completed") return false;
  return (
    agentType.includes("requirements") ||
    agentType.includes("user flow") ||
    agentType.includes("planner") ||
    summary.includes("generating updates") ||
    summary.includes("designing screen flows") ||
    summary.includes("generated")
  );
}

async function waitForReviewCheckpoint(
  client: Awaited<ReturnType<typeof requireAuthenticatedClient>>,
  projectId: string,
  options: { timeoutMs: number; intervalMs: number }
): Promise<ProjectStatus> {
  const deadline = Date.now() + options.timeoutMs;
  let latestStatus = await client.getProjectStatus(projectId);

  while (!statusHasReviewCheckpoint(latestStatus) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    latestStatus = await client.getProjectStatus(projectId);
  }

  return latestStatus;
}

async function waitForReviewActions(
  client: Awaited<ReturnType<typeof requireAuthenticatedClient>>,
  projectId: string,
  options: { pausedForReview: boolean; timeoutMs: number; intervalMs: number }
): Promise<{
  status: ProjectStatus;
  pausedForReview: boolean;
  hasReviewCheckpoint: boolean;
  backendHasContinue: boolean;
  hasLatestCompletedAgentLog: boolean;
}> {
  const deadline = Date.now() + options.timeoutMs;
  let latestStatus = await client.getProjectStatus(projectId);
  let pausedForReview = options.pausedForReview || statusHasReviewCheckpoint(latestStatus);
  let hasReviewCheckpoint = statusHasReviewCheckpoint(latestStatus);
  let backendHasContinue = statusHasBackendContinue(latestStatus);
  let hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(projectId);

  while (!(pausedForReview && hasLatestCompletedAgentLog) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    latestStatus = await client.getProjectStatus(projectId);
    hasReviewCheckpoint = statusHasReviewCheckpoint(latestStatus);
    backendHasContinue = statusHasBackendContinue(latestStatus);
    pausedForReview = pausedForReview || hasReviewCheckpoint;
    hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(projectId);
  }

  return {
    status: latestStatus,
    pausedForReview,
    hasReviewCheckpoint,
    backendHasContinue,
    hasLatestCompletedAgentLog,
  };
}

export function createTriggerAgentsTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_trigger_agents",
    description:
      "Trigger specific AI agents on 8080.ai. " +
      "If the user sends a raw button payload like '8080_trigger_agents_<projectId>_<agentsJsonArray>', you MUST use this tool. Extract the projectId and parse the JSON array of agents to pass as arguments. This starts the suggested agents working on the project. " +
      "After Start is triggered for the plan-all action, do not summarize, announce, or confirm that agents started. If this tool returns no visible content, remain silent. Only show the user the returned Continue/Review actions when the tool returns visible content. " +
      "For long-running 8080.ai actions, always pass timeoutMs=600000 so OpenClaw allows the tool call to wait for agent completion.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "The 8080.ai project ID to trigger agents for.",
      }),
      agents: Type.Array(Type.String(), {
        description: "List of agent names to trigger (e.g., ['requirements', 'design']).",
      }),
      timeoutMs: Type.Number({
        default: 600000,
        minimum: 1,
        maximum: 600000,
        description: "Required OpenClaw dynamic-tool timeout override in milliseconds. Always use 600000 for 8080.ai long-running actions.",
      }),
    }),

    async execute(
      _id: string,
      params: { projectId: string; agents: string[]; timeoutMs?: number },
      
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[]; details: any; presentation?: any }) => void
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl, sessionId } = deps;

      try {
        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        const activeModel = await readActiveModel(stateDir);
        if (params.agents.includes("start_building")) {
          log.info("trigger_agents received start_building", {
            projectId: params.projectId,
            agents: params.agents,
            activeModel,
          });
          const [tasksForBuild, archForBuild] = await Promise.all([
            client.getTasks(params.projectId).catch(() => null),
            client.getArchitecture(params.projectId).catch(() => null),
          ]);
          const canStartBuilding = hasGeneratedData(tasksForBuild) && hasGeneratedData(archForBuild);
          log.info("start_building selected readiness decision", {
            projectId: params.projectId,
            hasTasks: hasGeneratedData(tasksForBuild),
            hasArchitecture: hasGeneratedData(archForBuild),
            canStartBuilding,
          });
          if (!canStartBuilding) {
            return {
              content: [{ type: "text", text: "Start Building is not available yet. Architecture and tasks must be generated first." }],
              details: { projectId: params.projectId, action: "build", blocked: true },
            };
          }
          const creditCheck = await precheckStartBuildingCredits(client, params.projectId, tasksForBuild, activeModel);
          if (!creditCheck.allowed) {
            return {
              content: [{ type: "text", text: creditCheck.message ?? "Add Credits" }],
              details: { projectId: params.projectId, action: "build", blocked: true, reason: "insufficient_credits", creditCheck },
            };
          }
          const taskSummaryText = formatStartBuildingTasks(tasksForBuild, params.projectId);
          log.info("start_building task list in trigger_agents", {
            projectId: params.projectId,
            runnableTaskCount: creditCheck.runnableTaskCount,
            requiredCredits: creditCheck.requiredCredits,
            availableCredits: creditCheck.availableCredits,
            taskSummaryText,
            shown: Boolean(taskSummaryText),
          });
          onUpdate?.({
            content: [{
              type: "text",
              text:
                `🚀 Triggering **Building Phase** for project \`${params.projectId}\`...\n\n` +
                (taskSummaryText ? `${taskSummaryText}\n\n` : ""),
            }],
            details: { projectId: params.projectId, action: "build" },
          });
          log.info("start_building selected build api about to call", {
            projectId: params.projectId,
            activeModel,
          });
          try {
            await client.startBuilding(params.projectId, activeModel);
          } catch (err) {
            const insufficientCreditsText = getInsufficientCreditsMessageFromError(err);
            if (insufficientCreditsText) {
              return {
                content: [{ type: "text", text: insufficientCreditsText }],
                details: { projectId: params.projectId, action: "build", blocked: true, reason: "insufficient_credits" },
              };
            }
            throw err;
          }
          const designPreviewText = await getDesignPreviewText(client, params.projectId);
          log.info("start_building selected build api completed", {
            projectId: params.projectId,
            activeModel,
            taskSummaryShown: Boolean(taskSummaryText),
          });
          return {
            content: [{
              type: "text",
              text:
                `✅ **Building Started!** Agents are now writing your software.` +
                (taskSummaryText ? `\n\n${taskSummaryText}` : "") +
                designPreviewText,
            }],
            details: { projectId: params.projectId, action: "build", status: "started" },
          };
        }

        const latestSuggestions = await readLatestSuggestionsForProject(stateDir, sessionId, params.projectId).catch(() => null);
        let messageId = latestSuggestions?.messageId ?? "";
        if (params.agents.includes('continue')) {
          if (!latestSuggestions?.agents.includes("continue")) {
            log.info("trigger_agents blocked continue without continue suggestion", {
              projectId: params.projectId,
              agents: params.agents,
              suggestions: latestSuggestions?.agents ?? [],
            });
            return silentToolResult({
              status: "blocked_without_continue_suggestion",
              suggestions: latestSuggestions?.agents ?? [],
              projectId: params.projectId,
            });
          }
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: params.projectId,
            agents: [],
            messageId: latestSuggestions.messageId,
          });
          log.info("trigger_agents consuming continue suggestion", {
            projectId: params.projectId,
            messageId: latestSuggestions.messageId,
          });
          await client.resumeDesign(params.projectId);
        } else {
          try {
            const status = await client.getProjectStatus(params.projectId);
            const pending = extractPendingSuggestion(status.pending_suggested_agents);
            messageId = pending.messageId || messageId;
            log.info("trigger_agents hydrated message id", {
              projectId: params.projectId,
              agents: params.agents,
              pendingAgents: pending.agents,
              messageId,
              fallbackMessageId: latestSuggestions?.messageId ?? "",
            });
          } catch (err) {
            log.info("trigger_agents failed to hydrate message id", err);
          }
          try {
            await client.triggerAgents(params.projectId, params.agents, messageId, activeModel);
          } catch (err) {
            const logs = await client.getAgentLogs(params.projectId).catch(() => []);
            const hasPlanningActivity = logs.some((entry) => isPlanningActivityLog(entry));
            log.info("trigger_agents api failed; checking whether agents are already running", {
              projectId: params.projectId,
              agents: params.agents,
              messageId,
              error: err instanceof Error ? err.message : String(err),
              hasPlanningActivity,
            });
            if (!hasPlanningActivity) throw err;
          }
        }
        
        log.info("trigger_agents started polling for review gate", {
          projectId: params.projectId,
          agents: params.agents,
        });

        // Stream events live to the dashboard until the planning checkpoint or idle timeout.
        const eventIdleTimeoutMs = 120_000;
        const eventProgressTimeoutMs = 300_000;
        const eventMaxTimeoutMs = 480_000;
        let pausedForReview = false;
        let hasCompletedAgent = false;
        const suggestedAgentsFromEvents: string[] = [];
        let suggestedAgentsMessageId = "";
        let suggestedAgentsButtons: any[] | undefined;

        const captureEventSuggestions = (suggestion: PendingSuggestion) => {
          for (const agent of suggestion.agents) {
            if (!suggestedAgentsFromEvents.includes(agent)) {
              suggestedAgentsFromEvents.push(agent);
            }
          }
          if (suggestion.messageId) suggestedAgentsMessageId = suggestion.messageId;
          if (suggestion.buttons) suggestedAgentsButtons = suggestion.buttons;
          log.info("trigger_agents event suggested_agents", {
            projectId: params.projectId,
            agents: suggestion.agents,
            messageId: suggestion.messageId,
            hasButtons: Boolean(suggestion.buttons?.length),
          });
        };

        try {
          await client.streamProjectEvents(params.projectId, {
            onSuggestedAgents: captureEventSuggestions,
            onAgentLog: (agentLog) => {
              if (agentLog.action === "completed") {
                hasCompletedAgent = true;
              }
              log.info("trigger_agents event agent_log", {
                projectId: params.projectId,
                action: agentLog.action,
                agentType: agentLog.agent_type,
                summary: agentLog.summary,
              });
            },
            onChatMessage: (msg) => {
              if (isPauseForReviewText(msg.content)) {
                pausedForReview = true;
              }
              log.info("trigger_agents event chat_message", {
                projectId: params.projectId,
                isPauseForReview: isPauseForReviewText(msg.content),
              });
            },
            onSrdChunk: undefined,
            onPlanningComplete: (data) => {
              if (data.status === "paused_for_review") {
                pausedForReview = true;
              }
            },
            idleTimeoutMs: eventIdleTimeoutMs,
            progressTimeoutMs: eventProgressTimeoutMs,
            maxTimeoutMs: eventMaxTimeoutMs,
          });
        } catch (err) {
          log.info("trigger_agents event stream failed; continuing with project polling", {
            projectId: params.projectId,
            agents: params.agents,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (
          suggestedAgentsFromEvents.length > 0 &&
          !hasSameAgents(suggestedAgentsFromEvents, params.agents)
        ) {
          const eventAgents = groupAgents(suggestedAgentsFromEvents);
          const eventMessageId = suggestedAgentsMessageId || messageId;
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: params.projectId,
            agents: eventAgents,
            messageId: eventMessageId,
            buttons: suggestedAgentsButtons,
          });
          log.info("trigger_agents showing event suggested agents", {
            projectId: params.projectId,
            triggeredAgents: params.agents,
            eventAgents,
            messageId: eventMessageId,
            hasButtons: Boolean(suggestedAgentsButtons?.length),
          });
          const continueButtonLabel = eventAgents.some((agent) =>
            agent === "continue" ||
            agent === "generate_first_page" ||
            agent === "generate_all_pages" ||
            agent === "generate_architecture"
          )
            ? await determineContinueButtonLabel(client, params.projectId)
            : undefined;
          const text = buildSuggestedAgentsText(params.projectId, eventAgents, "", continueButtonLabel, suggestedAgentsButtons);
          const presentation = buildSuggestedAgentsPresentation(params.projectId, eventAgents, "", continueButtonLabel, suggestedAgentsButtons);
          onUpdate?.({ content: [{ type: "text", text }], details: null, presentation });
          return {
            content: [{ type: "text", text }],
            details: {
              status: "suggested_agents",
              suggestions: eventAgents,
            },
            presentation,
          };
        }

        let projectStatusAfter = await waitForReviewCheckpoint(client, params.projectId, {
          timeoutMs: params.agents.includes("plan_all") ? 30_000 : 20_000,
          intervalMs: 5_000,
        });
        const reviewGate = await waitForReviewActions(client, params.projectId, {
          pausedForReview: pausedForReview || statusHasReviewCheckpoint(projectStatusAfter),
          timeoutMs: params.agents.includes("plan_all") ? 60_000 : 45_000,
          intervalMs: 5_000,
        });
        projectStatusAfter = reviewGate.status;
        pausedForReview = reviewGate.pausedForReview;
        const { hasReviewCheckpoint, backendHasContinue, hasLatestCompletedAgentLog } = reviewGate;
        const reviewReady = pausedForReview && hasLatestCompletedAgentLog;
        if (reviewReady) {
          log.info("trigger_agents detected review checkpoint from project status", {
            projectId: params.projectId,
            agents: params.agents,
            hasReviewCheckpoint,
            pausedForReview,
            hasCompletedAgent,
            backendHasContinue,
            hasLatestCompletedAgentLog,
          });
        } else {
          log.info("trigger_agents review checkpoint not ready in backend suggestions", {
            projectId: params.projectId,
            agents: params.agents,
            hasReviewText: hasReviewCheckpoint,
            backendHasContinue,
            hasLatestCompletedAgentLog,
            pendingSuggestions: extractPendingSuggestion(projectStatusAfter.pending_suggested_agents).agents,
          });
        }

        if (!reviewReady) {
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: params.projectId,
            agents: [],
            messageId,
          });
          return silentToolResult({
            status: "waiting_for_review_actions",
            suggestions: [],
            projectId: params.projectId,
          });
        }

        const reviewAgents = groupAgents(["continue", "review"]);
        const pending = extractPendingSuggestion(projectStatusAfter.pending_suggested_agents);
        if (pending.messageId) messageId = pending.messageId;
        log.info("trigger_agents showing review actions", {
          projectId: params.projectId,
          agents: reviewAgents,
          messageId,
          backendSessionId: pending.sessionId,
        });
        await writeLatestSuggestions(stateDir, sessionId, {
          projectId: params.projectId,
          agents: reviewAgents,
          messageId,
          buttons: pending.buttons,
        });
        const continueButtonLabel = reviewAgents.includes("continue") ? await determineContinueButtonLabel(client, params.projectId) : undefined;
        const reviewText = buildSuggestedAgentsText(params.projectId, reviewAgents, "", continueButtonLabel, pending.buttons);
        const presentation = buildSuggestedAgentsPresentation(params.projectId, reviewAgents, "", continueButtonLabel, pending.buttons);
        onUpdate?.({ content: [{ type: "text", text: reviewText }], details: null, presentation });
        return {
          content: [{ type: "text", text: reviewText }],
          details: {
            status: "paused_for_review",
            suggestions: reviewAgents,
          },
          presentation,
        };
      } catch (err) {
        if (err instanceof AuthError) {
          return { content: [{ type: "text", text: (err as Error).message }], details: null };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `8080.ai error: ${msg}` }], details: null };
      }
    },
  };
}
