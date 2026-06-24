import { Type } from "@sinclair/typebox";
import { AuthError, requireAuthenticatedClient, isPauseForReviewText, type ProjectStatus } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { groupAgents, hasGeneratedData } from "./command.ts";
import { readActiveModel } from "./model-state.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { readLatestSuggestionsForProject, writeLatestSuggestions } from "./suggestions-state.ts";
import { silentToolResult } from "./exact-response.ts";
import { canShowStartBuildingTasks, canUseStartBuilding, detectSubscriptionTier, formatStartBuildingTasks, getUpgradeToBuildText } from "./task-summary.ts";
import { getDesignPreviewText } from "./design-preview.ts";
import { log } from "../logger.ts";

function statusHasReviewCheckpoint(status: ProjectStatus): boolean {
  const messages = Array.isArray(status.messages) ? status.messages : [];
  return messages.some((message) => isPauseForReviewText(message.content));
}

function statusHasBackendContinue(status: ProjectStatus): boolean {
  return extractPendingSuggestion(status.pending_suggested_agents).agents.includes("continue");
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
      "After Run Plan All is triggered, do not summarize, announce, or confirm that agents started. If this tool returns no visible content, remain silent. Only show the user the returned Continue/Review actions when the tool returns visible content.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "The 8080.ai project ID to trigger agents for.",
      }),
      agents: Type.Array(Type.String(), {
        description: "List of agent names to trigger (e.g., ['requirements', 'design']).",
      }),
    }),

    async execute(
      _id: string,
      params: { projectId: string; agents: string[] },
      
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
          const [subscription, plans, profile] = await Promise.all([
            client.getSubscription().catch(() => null),
            client.getSubscriptionPlans().catch(() => []),
            client.getProfile().catch(() => null),
          ]);
          const subscriptionTier = detectSubscriptionTier(subscription, profile, plans);
          const canBuildForPlan = canUseStartBuilding(subscriptionTier);
          log.info("start_building selected plan decision", {
            projectId: params.projectId,
            subscriptionTier,
            canBuildForPlan,
            plansCount: plans.length,
          });
          if (!canBuildForPlan) {
            return {
              content: [{ type: "text", text: getUpgradeToBuildText("https://8080.ai") }],
              details: { projectId: params.projectId, action: "build", blocked: true, subscriptionTier },
            };
          }
          const taskSummaryText = canShowStartBuildingTasks(subscriptionTier)
            ? formatStartBuildingTasks(tasksForBuild, params.projectId)
            : "";
          log.info("start_building task list in trigger_agents", {
            projectId: params.projectId,
            tier: subscriptionTier,
            tasks: tasksForBuild,
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
          await client.startBuilding(params.projectId, activeModel);
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

        let messageId = "";
        if (params.agents.includes('continue')) {
          const latestSuggestions = await readLatestSuggestionsForProject(stateDir, sessionId, params.projectId);
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
            messageId = pending.messageId;
            log.info("trigger_agents hydrated message id", {
              projectId: params.projectId,
              agents: params.agents,
              pendingAgents: pending.agents,
              messageId,
            });
          } catch (err) {
            log.info("trigger_agents failed to hydrate message id", err);
          }
          await client.triggerAgents(params.projectId, params.agents, messageId, activeModel);
        }
        
        log.info("trigger_agents started polling for review gate", {
          projectId: params.projectId,
          agents: params.agents,
        });

        // Stream events live to the dashboard until the planning checkpoint or idle timeout.
        let pausedForReview = false;
        let hasCompletedAgent = false;
        await client.streamProjectEvents(params.projectId, {
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
          idleTimeoutMs: 60_000,
          progressTimeoutMs: 45_000,
          maxTimeoutMs: 180_000,
        });

        let projectStatusAfter = await waitForReviewCheckpoint(client, params.projectId, {
          timeoutMs: params.agents.includes("plan_all") ? 15_000 : 10_000,
          intervalMs: 5_000,
        });
        const reviewGate = await waitForReviewActions(client, params.projectId, {
          pausedForReview: pausedForReview || statusHasReviewCheckpoint(projectStatusAfter),
          timeoutMs: params.agents.includes("plan_all") ? 180_000 : 60_000,
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
        });
        const reviewText = buildSuggestedAgentsText(params.projectId, reviewAgents);
        const presentation = buildSuggestedAgentsPresentation(params.projectId, reviewAgents);
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
