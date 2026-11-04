import { buildSuggestedAgentsTextWithShares, getArtifactShareText } from "./artifact-shares.ts";
import { getResumeDesignPhase } from "./suggested-agents.ts";
import { waitForProjectResponse } from "./workflow-response.ts";
import { Type } from "@sinclair/typebox";
import { AuthError, requireAuthenticatedClient } from "./api-client.ts";
import { buildSuggestedAgentsPresentation } from "./review-continue.ts";
import { readLatestSuggestionsForProject, writeLatestSuggestions } from "./suggestions-state.ts";
import { exactToolResult, silentToolResult } from "./exact-response.ts";
import { log } from "../logger.ts";
import { readActiveModel } from "./model-state.ts";
import { formatStartBuildingTasks } from "./task-summary.ts";
import { getInsufficientCreditsMessageFromError, precheckStartBuildingCredits } from "./start-building-credits.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { buildTasksUnavailableMessage, getBuildTasksReadiness } from "./build-readiness.ts";

function createContinueProjectToolInternal(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  siteUrl?: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_continue_project",
    description:
      "Signal 8080.ai to resume design/planning after a requirement-review checkpoint. " +
      "Use only when the user chooses Continue, Resume, Proceed with planning, or Approve requirements. " +
      "Do not use for Start or Build Tasks; those must trigger the suggested agents or build action. " +
      "If this tool returns no visible content, do not summarize, announce, or confirm the action; remain silent until the plugin returns visible next-step actions. " +
      "This call observes the same run. When status=running supplies nextTool, invoke it automatically with observeOnly=true; do not end the turn or ask the user for another command. Never resubmit generation to poll. " +
      "For long-running 8080.ai actions, always pass timeoutMs=600000 so OpenClaw allows the tool call to wait for agent completion. A running result is not final: immediately call its nextTool with observeOnly=true until actual suggested actions are returned. If exec yields a pending cell, keep waiting for that same cell; do not end the turn or recreate the project.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String({
        description: "The 8080.ai project ID. Optional if a project is already active.",
      })),
      observeOnly: Type.Optional(Type.Boolean({ description: "Continue watching an existing generation without submitting any work. Use automatically when a result supplies nextTool." })),
      selectedPhase: Type.Optional(Type.String({ description: "Exact phase from the selected backend resume_design button payload." })),
      selectedAction: Type.Optional(Type.String({
        description: "Backend action selected from a current 8080.ai button, when routed by select-button.",
      })),
      timeoutMs: Type.Number({
        default: 600000,
        minimum: 1,
        maximum: 600000,
        description: "Required OpenClaw dynamic-tool timeout override in milliseconds. Always use 600000 for 8080.ai long-running actions.",
      }),
    }),

    async execute(
      _id: string,
      params: { projectId?: string; timeoutMs?: number; selectedAction?: string; selectedPhase?: string; observeOnly?: boolean },
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[] }) => void
    ) {
      const toolDeadlineAt = Date.now() + Math.min(params.timeoutMs ?? 600_000, 600_000);
      const stateDir = deps.stateDir();
      const { apiBaseUrl, sessionId } = deps;
      let activeProjectId = params.projectId;
      let latestSuggestions: Awaited<ReturnType<typeof readLatestSuggestionsForProject>> = null;

      const toolAbortController = new AbortController();
      if (_signal) {
        if (_signal.aborted) {
          toolAbortController.abort();
        } else {
          _signal.addEventListener("abort", () => toolAbortController.abort());
        }
      }

      try {
        const { readActiveProject } = await import("./project-state.ts");
        activeProjectId = activeProjectId || await readActiveProject(stateDir, sessionId) || undefined;

        if (!activeProjectId) {
          return {
            content: [{ type: "text", text: "No active project found. Please select a project first." }],
          };
        }

        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        latestSuggestions = await readLatestSuggestionsForProject(stateDir, sessionId, activeProjectId);
        if (params.observeOnly) {
          return await waitForProjectResponse(client, {
            siteUrl: deps.siteUrl,
            stateDir, sessionId, projectId: activeProjectId,
            modelTier: await readActiveModel(stateDir), signal: toolAbortController.signal,
            timeoutMs: params.timeoutMs, toolDeadlineAt, onUpdate,
            startedAt: latestSuggestions?.observation?.startedAt ?? 0,
            consumed: latestSuggestions?.observation?.consumed,
            progressState: latestSuggestions?.observation?.progress,
          });
        }
        const selectedResumeDesign = params.selectedAction === "resume_design";
        if (!selectedResumeDesign) {
          try {
            const status = await client.getProjectStatus(activeProjectId);
            const pending = extractPendingSuggestion(status.pending_suggested_agents);
            if (pending.agents.length > 0 || latestSuggestions) {
              latestSuggestions = {
                projectId: activeProjectId,
                agents: pending.agents,
                messageId: pending.messageId,
                buttons: pending.buttons,
              };
              await writeLatestSuggestions(stateDir, sessionId, latestSuggestions);
              log.info("continue_project refreshed suggestions from project status", {
                projectId: activeProjectId,
                agents: latestSuggestions.agents,
                messageId: latestSuggestions.messageId,
                hasButtons: Boolean(latestSuggestions.buttons?.length),
              });
            }
          } catch (err) {
            latestSuggestions = null;
            log.info("continue_project failed to hydrate suggestions from project status", err);
          }
        }
        const suggestedAgents = latestSuggestions?.agents ?? [];
        const hasContinueSuggestion = params.selectedAction === "resume_design" || suggestedAgents.some((agent) =>
          agent === "continue" ||
          agent === "generate_first_page" ||
          agent === "generate_all_pages" ||
          agent === "generate_architecture"
        );
        let reattachRunningLog: BasicAgentLog | undefined;
        const hasPlanAllSuggestion = suggestedAgents.some((agent) =>
          agent === "plan_all" || (agent.startsWith("GROUP:") && agent.slice(6).split("|").includes("plan_all"))
        );
        if (hasPlanAllSuggestion && !hasContinueSuggestion) {
          log.info("continue_project received plan_all suggestion; showing Start instead of auto-triggering", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            suggestions: suggestedAgents,
            messageId: latestSuggestions?.messageId ?? "",
          });
          return {
            content: [{
              type: "text",
              text:
                "8080.ai is ready to run the planning agents.\n\n" +
                await buildSuggestedAgentsTextWithShares(client, deps.siteUrl, activeProjectId, suggestedAgents, "", false, latestSuggestions?.buttons),
            }],
            details: {
              status: "waiting_for_run_plan_all",
              suggestions: suggestedAgents,
            },
            presentation: buildSuggestedAgentsPresentation(activeProjectId, suggestedAgents, "", false, latestSuggestions?.buttons),
          };
        }
        const shouldTriggerSuggestedAgents =
          hasPlanAllSuggestion &&
          suggestedAgents.length > 0 &&
          !suggestedAgents.includes("continue") &&
          !suggestedAgents.some((agent) => agent === "start_building" || agent === "start_build");
        const shouldStartBuilding =
          suggestedAgents.some((agent) => agent === "start_building" || agent === "start_build") &&
          !suggestedAgents.includes("continue");

        if (shouldTriggerSuggestedAgents) {
          const activeModel = await readActiveModel(stateDir);
          const agentsToTrigger = suggestedAgents.flatMap((agent) =>
            agent.startsWith("GROUP:") ? agent.slice(6).split("|") : [agent]
          );
          log.info("suggested agents selected via continue_project fallback", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            suggestions: suggestedAgents,
            agentsToTrigger,
            activeModel,
            messageId: latestSuggestions?.messageId ?? "",
          });

          const startedAt = Date.now();
          await client.triggerAgents(activeProjectId, agentsToTrigger, latestSuggestions?.messageId ?? "", activeModel);
          return await waitForProjectResponse(client, {
            siteUrl: deps.siteUrl,
            stateDir, sessionId, projectId: activeProjectId, modelTier: activeModel,
            signal: toolAbortController.signal, timeoutMs: params.timeoutMs, toolDeadlineAt, onUpdate, startedAt,
            consumed: { agents: suggestedAgents, buttons: latestSuggestions?.buttons,
              messageId: latestSuggestions?.messageId ?? "", sessionId: "" },
          });
        }

        if (shouldStartBuilding) {
          const activeModel = await readActiveModel(stateDir);
          const [tasksForBuild, buildReadiness] = await Promise.all([
            client.getTasks(activeProjectId).catch(() => null),
            getBuildTasksReadiness(client, activeProjectId, activeModel),
          ]);

          function hasGeneratedData(data: unknown): boolean {
            if (!data) return false;
            if (Array.isArray(data)) return data.length > 0;
            if (typeof data === "object") {
              return Object.values(data).some((val) => Array.isArray(val) && val.length > 0);
            }
            return false;
          }

          log.info("start_building selected via continue_project fallback", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            suggestions: latestSuggestions.agents,
            canStartBuilding: buildReadiness.canStart,
            phaseId: buildReadiness.phaseId,
            blockingReason: buildReadiness.state.blocking_reason,
            runnableTaskCount: buildReadiness.state.runnable_tasks?.length ?? 0,
          });
          if (!buildReadiness.canStart) {
            return {
              content: [{ type: "text", text: buildTasksUnavailableMessage(buildReadiness) }],
            };
          }

          const creditCheck = await precheckStartBuildingCredits(client, activeProjectId, tasksForBuild, activeModel);
          if (!creditCheck.allowed) {
            return {
              content: [{ type: "text", text: creditCheck.message ?? "Add Credits" }],
            };
          }

          const taskSummaryText = formatStartBuildingTasks(tasksForBuild, activeProjectId);
          onUpdate?.({
            content: [{
              type: "text",
              text:
                `🚀 Triggering **Building Phase** for project \`${activeProjectId}\`...\n\n` +
                (taskSummaryText ? `${taskSummaryText}\n\n` : ""),
            }],
          });
          log.info("start_building selected build api about to call", {
            projectId: activeProjectId,
            source: "continue_project_tool_fallback",
            activeModel,
          });
          try {
            await client.startBuilding(activeProjectId, activeModel, buildReadiness.phaseId);
          } catch (err) {
            const insufficientCreditsText = getInsufficientCreditsMessageFromError(err);
            if (insufficientCreditsText) {
              return {
                content: [{ type: "text", text: insufficientCreditsText }],
              };
            }
            throw err;
          }
          const artifactLinks = await getArtifactShareText(client, activeProjectId, deps.siteUrl);
          log.info("start_building selected build api completed", {
            projectId: activeProjectId,
            source: "continue_project_tool_fallback",
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
            details: {
              status: "building_started",
            },
          };
        }

        if (!hasContinueSuggestion) {
          const recentLogs = await client.getAgentLogs(activeProjectId).catch(() => []);
          reattachRunningLog = findLatestRunningDesignLog(recentLogs);
          if (reattachRunningLog) {
            log.info("continue_project reattaching to running design job", {
              projectId: activeProjectId,
              source: "continue_project_tool",
              suggestions: suggestedAgents,
              action: reattachRunningLog.action,
              agentType: reattachRunningLog.agent_type,
              summary: reattachRunningLog.summary,
              messageId: reattachRunningLog.message_id,
              createdAt: reattachRunningLog.created_at,
            });
          }
        }

        if (!hasContinueSuggestion && !reattachRunningLog) {
          log.info("continue_project blocked without continue suggestion", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            suggestions: suggestedAgents,
          });
          return silentToolResult({
            status: "blocked_without_continue_suggestion",
            suggestions: suggestedAgents,
            projectId: activeProjectId,
          });
        }

        const actionStartedAtMs = Date.now();
        if (hasContinueSuggestion) {
          log.info("continue_project consuming continue suggestion", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            messageId: latestSuggestions?.messageId ?? "",
            explicitSelectedAction: params.selectedAction,
          });
          await client.resumeDesign(activeProjectId, params.selectedPhase ?? getResumeDesignPhase(latestSuggestions?.buttons));
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: [],
            messageId: latestSuggestions?.messageId ?? "",
          });
        } else {
          log.info("continue_project continuing already-running design job without resume call", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            action: reattachRunningLog?.action,
            agentType: reattachRunningLog?.agent_type,
            summary: reattachRunningLog?.summary,
          });
        }

        return await waitForProjectResponse(client, {
          siteUrl: deps.siteUrl,
          onUpdate,
          stateDir, sessionId, projectId: activeProjectId,
          modelTier: await readActiveModel(stateDir), signal: toolAbortController.signal,
          timeoutMs: params.timeoutMs, toolDeadlineAt,
          startedAt: reattachRunningLog ? 0 : actionStartedAtMs,
          consumed: hasContinueSuggestion ? {
            agents: latestSuggestions?.agents ?? [], buttons: latestSuggestions?.buttons,
            messageId: latestSuggestions?.messageId ?? "", sessionId: "",
          } : undefined,
        });
      } catch (err) {
        if (err instanceof AuthError) {
          if (activeProjectId) {
            const suggestions = latestSuggestions?.agents ?? [];
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: suggestions,
              messageId: latestSuggestions?.messageId ?? "",
              buttons: latestSuggestions?.buttons,
            });
            const text =
              `${(err as Error).message}\n\n` +
              `Your project checkpoint is still saved. After logging in, choose Continue again to resume.`;
            return {
              content: [{ type: "text", text }],
              details: {
                status: "auth_expired",
                suggestions,
              },
              presentation: buildSuggestedAgentsPresentation(activeProjectId, suggestions, "", false, latestSuggestions?.buttons),
            };
          }
          return { content: [{ type: "text", text: (err as Error).message }] };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `8080.ai error: ${msg}` }] };
      }
    },
  };
}

// Keep normal assistant delivery so exact-response hooks can publish text and
// buttons. Protect the result against an automatic follow-up status lookup.
export function createContinueProjectTool(deps: Parameters<typeof createContinueProjectToolInternal>[0]) {
  const tool = createContinueProjectToolInternal(deps);
  const execute = tool.execute;
  return {
    ...tool,
    async execute(...args: Parameters<typeof execute>) {
      const result = await execute(...args);
      const text = result.content.map(block => block.text).join("\n");
      const details = "details" in result ? result.details : {};
      const visibleText = typeof details?.exactUserResponse === "string" ? details.exactUserResponse : text;
      const wrapped = exactToolResult(visibleText, { ...details, protectFromStatusLookup: true },
        "presentation" in result ? result.presentation : undefined);
      // Preserve model-only continuation instructions without displaying them.
      wrapped.content = result.content;
      return wrapped;
    },
  };
}

type BasicAgentLog = {
  action?: string | null;
  agent_type?: string | null;
  summary?: string | null;
  message_id?: string | null;
  created_at?: string | null;
};

export function findFailedAgentLogSince(
  logs: BasicAgentLog[],
  actionStartedAtMs: number
): BasicAgentLog | undefined {
  return logs.find((entry) => {
    const isFailure =
      entry.action === "failed" ||
      entry.action === "error" ||
      (typeof entry.summary === "string" && /failed|error/i.test(entry.summary));
    const rawCreatedAt = entry.created_at ?? "";
    const normalizedCreatedAt = rawCreatedAt && !/(?:z|[+-]\d{2}:?\d{2})$/i.test(rawCreatedAt)
      ? `${rawCreatedAt}Z`
      : rawCreatedAt;
    const createdAtMs = Date.parse(normalizedCreatedAt);
    return isFailure && Number.isFinite(createdAtMs) && createdAtMs >= actionStartedAtMs - 5_000;
  });
}

export function findLatestRunningDesignLog(logs: BasicAgentLog[]): BasicAgentLog | undefined {
  const timestamp = (entry: BasicAgentLog) => {
    const raw = entry.created_at ?? "";
    return Date.parse(raw && !/(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) ? `${raw}Z` : raw);
  };
  const ordered = logs.filter((entry) => Number.isFinite(timestamp(entry)))
    .sort((a, b) => timestamp(b) - timestamp(a));
  return ordered.find((entry) => {
    const action = String(entry.action ?? "").toLowerCase();
    if (action !== "started" && action !== "running") return false;
    const agent = String(entry.agent_type ?? "").toLowerCase();
    // A planner describing screen flows is not a running design generator.
    if (agent.includes("flow") || agent.includes("planner")) return false;
    if (entry.message_id !== "resume-design" && !agent.includes("design")) return false;
    return !ordered.some((newer) =>
      timestamp(newer) >= timestamp(entry) &&
      newer.agent_type === entry.agent_type &&
      newer.message_id === entry.message_id &&
      ["completed", "failed", "error", "cancelled", "canceled"].includes(String(newer.action).toLowerCase())
    );
  });
}
