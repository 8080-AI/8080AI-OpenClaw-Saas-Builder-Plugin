import { getResumeDesignPhase } from "./suggested-agents.ts";
import { waitForProjectResponse } from "./workflow-response.ts";
import { Type } from "@sinclair/typebox";
import { AuthError, requireAuthenticatedClient, isPauseForReviewText, type ProjectStatus } from "./api-client.ts";
import { isContinueActionAgent } from "./review-continue.ts";
import { readActiveModel } from "./model-state.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { readLatestSuggestionsForProject, writeLatestSuggestions } from "./suggestions-state.ts";
import { silentToolResult } from "./exact-response.ts";
import { formatStartBuildingTasks } from "./task-summary.ts";
import { getInsufficientCreditsMessageFromError, precheckStartBuildingCredits } from "./start-building-credits.ts";
import { getArtifactShareText } from "./artifact-shares.ts";
import { buildTasksUnavailableMessage, getBuildTasksReadiness } from "./build-readiness.ts";
import { log } from "../logger.ts";

function statusHasReviewCheckpoint(status: ProjectStatus): boolean {
  const messages = Array.isArray(status.messages) ? status.messages : [];
  return messages.some((message) => isPauseForReviewText(message.content));
}

function statusHasBackendContinue(status: ProjectStatus): boolean {
  return extractPendingSuggestion(status.pending_suggested_agents).agents.some(isContinueActionAgent);
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

export async function waitForReviewActions(
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

  while (extractPendingSuggestion(latestStatus.pending_suggested_agents).agents.length === 0 && Date.now() < deadline) {
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
  siteUrl?: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_trigger_agents",
    description:
      "When the result supplies nextTool, call it automatically to continue observation without submitting work. Do not ask the user to refresh. " +
      "Trigger specific AI agents on 8080.ai. " +
      "If the user sends a raw button payload like '8080_trigger_agents_<projectId>_<agentsJsonArray>', you MUST use this tool. Extract the projectId and parse the JSON array of agents to pass as arguments. This starts the suggested agents working on the project. " +
      "After Start is triggered for the plan-all action, do not summarize, announce, or confirm that agents started. If this tool returns no visible content, remain silent. Only show the user the returned Continue/Review actions when the tool returns visible content. " +
      "This call observes the same run until the next checkpoint; await its native wait handle and never resubmit generation to poll. " +
      "For long-running 8080.ai actions, always pass timeoutMs=600000 so OpenClaw allows the tool call to wait for agent completion. A running result is not final: immediately call its nextTool with observeOnly=true until actual suggested actions are returned. If exec yields a pending cell, keep waiting for that same cell; do not end the turn or recreate the project.",
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
      const actionStartedAt = Date.now();
      const stateDir = deps.stateDir();
      const { apiBaseUrl, sessionId } = deps;

      try {
        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        const activeModel = await readActiveModel(stateDir);
        if (params.agents.some((agent) => agent === "start_building" || agent === "start_build")) {
          log.info("trigger_agents received start_building", {
            projectId: params.projectId,
            agents: params.agents,
            activeModel,
          });
          const [tasksForBuild, buildReadiness] = await Promise.all([
            client.getTasks(params.projectId).catch(() => null),
            getBuildTasksReadiness(client, params.projectId, activeModel),
          ]);
          log.info("start_building selected readiness decision", {
            projectId: params.projectId,
            canStartBuilding: buildReadiness.canStart,
            phaseId: buildReadiness.phaseId,
            blockingReason: buildReadiness.state.blocking_reason,
            runnableTaskCount: buildReadiness.state.runnable_tasks?.length ?? 0,
          });
          if (!buildReadiness.canStart) {
            return {
              content: [{ type: "text", text: buildTasksUnavailableMessage(buildReadiness) }],
              details: { projectId: params.projectId, action: "build", blocked: true, reason: buildReadiness.state.blocking_reason },
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
            await client.startBuilding(params.projectId, activeModel, buildReadiness.phaseId);
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
          const artifactLinks = await getArtifactShareText(client, params.projectId, deps.siteUrl);
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
                (artifactLinks ? `\n\n${artifactLinks}` : ""),
            }],
            details: { projectId: params.projectId, action: "build", status: "started" },
          };
        }

        const latestSuggestions = await readLatestSuggestionsForProject(stateDir, sessionId, params.projectId).catch(() => null);
        let messageId = latestSuggestions?.messageId ?? "";
        if (params.agents.some(isContinueActionAgent)) {
          if (!latestSuggestions?.agents.some(isContinueActionAgent)) {
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
          await client.resumeDesign(params.projectId, getResumeDesignPhase(latestSuggestions?.buttons));
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

        return await waitForProjectResponse(client, {
          siteUrl: deps.siteUrl,
          onUpdate,
          stateDir, sessionId, projectId: params.projectId, modelTier: activeModel,
          signal: _signal, timeoutMs: params.timeoutMs,
          toolDeadlineAt: actionStartedAt + Math.min(params.timeoutMs ?? 600_000, 600_000),
          consumed: { agents: params.agents, buttons: latestSuggestions?.buttons, messageId, sessionId: "" },
          startedAt: actionStartedAt,
        });
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
