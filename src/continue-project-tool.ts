import { Type } from "@sinclair/typebox";
import { AuthError, isPauseForReviewText, isReviewArchitectureStartBuildingChatMessage, requireAuthenticatedClient, determineContinueButtonLabel, getDesignPageRecords, hasCompletedDesignPages } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { readLatestSuggestionsForProject, writeLatestSuggestions } from "./suggestions-state.ts";
import { silentToolResult } from "./exact-response.ts";
import { log } from "../logger.ts";
import { readActiveModel } from "./model-state.ts";
import { formatStartBuildingTasks } from "./task-summary.ts";
import { getInsufficientCreditsMessageFromError, precheckStartBuildingCredits } from "./start-building-credits.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { getDesignPreviewText } from "./design-preview.ts";

export function createContinueProjectTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_continue_project",
    description:
      "Signal 8080.ai to resume design/planning after a requirement-review checkpoint. " +
      "Use only when the user chooses Continue, Resume, Proceed with planning, or Approve requirements. " +
      "Do not use for Start or Start Building; those must trigger the suggested agents or build action. " +
      "If this tool returns no visible content, do not summarize, announce, or confirm the action; remain silent until the plugin returns visible next-step actions. " +
      "For long-running 8080.ai actions, always pass timeoutMs=600000 so OpenClaw allows the tool call to wait for agent completion.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String({
        description: "The 8080.ai project ID. Optional if a project is already active.",
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
      params: { projectId?: string; timeoutMs?: number },
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[] }) => void
    ) {
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
        if (!latestSuggestions || !latestSuggestions.messageId) {
          try {
            const status = await client.getProjectStatus(activeProjectId);
            const pending = extractPendingSuggestion(status.pending_suggested_agents);
            if (pending.agents.length > 0) {
              latestSuggestions = {
                projectId: activeProjectId,
                agents: pending.agents,
                messageId: pending.messageId,
              };
              await writeLatestSuggestions(stateDir, sessionId, latestSuggestions);
              log.info("continue_project hydrated suggestions from project status", {
                projectId: activeProjectId,
                agents: pending.agents,
                messageId: pending.messageId,
              });
            }
          } catch (err) {
            log.info("continue_project failed to hydrate suggestions from project status", err);
          }
        }
        const suggestedAgents = latestSuggestions?.agents ?? [];
        const hasContinueSuggestion = suggestedAgents.includes("continue");
        let reattachRunningLog: BasicAgentLog | undefined;
        const hasPlanAllSuggestion = suggestedAgents.some((agent) =>
          agent === "plan_all" || (agent.startsWith("GROUP:") && agent.slice(6).split("|").includes("plan_all"))
        );
        if (hasPlanAllSuggestion && !hasContinueSuggestion) {
          const [existingDesignPages, latestAgentComplete] = await Promise.all([
            client.getDesignPages(activeProjectId).catch(() => null),
            client.hasLatestCompletedAgentLog(activeProjectId),
          ]);
          if (hasGeneratedData(existingDesignPages) && latestAgentComplete) {
            const recoveredSuggestions = ["continue", "review"];
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: recoveredSuggestions,
              messageId: latestSuggestions?.messageId ?? "",
              buttons: latestSuggestions?.buttons,
            });
            log.info("continue_project recovered review actions from generated design pages", {
              projectId: activeProjectId,
              source: "continue_project_tool",
              staleSuggestions: suggestedAgents,
              recoveredSuggestions,
              latestAgentComplete,
            });
            const continueButtonLabel = recoveredSuggestions.includes("continue") ? await determineContinueButtonLabel(client, activeProjectId) : undefined;
            const text = buildSuggestedAgentsText(activeProjectId, recoveredSuggestions, "", continueButtonLabel, latestSuggestions?.buttons);
            const presentation = buildSuggestedAgentsPresentation(activeProjectId, recoveredSuggestions, "", continueButtonLabel, latestSuggestions?.buttons);
            return {
              content: [{ type: "text", text }],
              details: {
                status: "checkpoint",
                suggestions: recoveredSuggestions,
              },
              presentation,
            };
          }
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
                buildSuggestedAgentsText(activeProjectId, suggestedAgents, "", false, latestSuggestions?.buttons),
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

          await client.triggerAgents(activeProjectId, agentsToTrigger, latestSuggestions?.messageId ?? "", activeModel);

          let pausedForReview = false;
          let streamError: string | null = null;
          const suggestedAgentsFromEvents: string[] = [];
          let suggestedAgentsMessageId = "";

          const emitFallbackProgress = createProgressEmitter(onUpdate, activeProjectId, "planning");

          try {
            await client.streamProjectEvents(activeProjectId, {
              onRaw: (raw) => {
                try {
                  const data = JSON.parse(raw);
                  emitFallbackProgress(data);
                  if (data.type === "error") {
                    streamError = data.message || data.content || JSON.stringify(data);
                  }
                  const agents = data.agents || data.suggested_agents || data.suggestedAgents || data.pending_suggested_agents;
                  if (agents) {
                    let agentList: string[] = [];
                    if (Array.isArray(agents)) agentList = agents;
                    else if (typeof agents === "object" && agents !== null) {
                      for (const [key, value] of Object.entries(agents)) {
                        if (typeof value === "string") agentList.push(value);
                        else if (value === true) agentList.push(key);
                      }
                    }
                    if (agentList.length > 0) {
                      for (const a of agentList) {
                        if (!suggestedAgentsFromEvents.includes(a)) {
                          suggestedAgentsFromEvents.push(a);
                        }
                      }
                      if (data.message_id || data.messageId) {
                        suggestedAgentsMessageId = String(data.message_id || data.messageId);
                      }
                    }
                  }
                } catch (err) {
                  // ignore
                }
              },
              onAgentLog: (agentLog) => {
                log.info("continue_project fallback event agent_log", {
                  projectId: activeProjectId,
                  action: agentLog.action,
                  agentType: agentLog.agent_type,
                  summary: agentLog.summary,
                });
                if (agentLog.action === "failed" || agentLog.action === "error") {
                  streamError = `Agent ${agentLog.agent_type} failed: ${agentLog.summary}`;
                }
              },
              onChatMessage: (msg) => {
                if (isPauseForReviewText(msg.content)) {
                  pausedForReview = true;
                }
                log.info("continue_project fallback event chat_message", {
                  projectId: activeProjectId,
                  isPauseForReview: isPauseForReviewText(msg.content),
                });
              },
              onPlanningComplete: (data) => {
                if (data.status === "paused_for_review") {
                  pausedForReview = true;
                }
              },
              idleTimeoutMs: 60_000,
              progressTimeoutMs: 120_000,
              maxTimeoutMs: 180_000,
              signal: toolAbortController.signal,
            });
          } catch (err) {
            log.info("continue_project fallback event stream failed; continuing with project polling", {
              projectId: activeProjectId,
              error: err instanceof Error ? err.message : String(err),
              aborted: toolAbortController.signal.aborted,
            });
          }

          if (toolAbortController.signal.aborted) {
            if (_signal?.aborted) {
              return {
                content: [{ type: "text", text: "Operation aborted by client." }],
                details: { status: "aborted", projectId: activeProjectId }
              };
            }
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: [],
              messageId: suggestedAgentsMessageId || latestSuggestions?.messageId || "",
            });
            return silentToolResult({
              status: "running",
              suggestions: [],
              projectId: activeProjectId,
            });
          }

          if (streamError) {
            throw new Error(streamError);
          }

          log.info("suggested agents continue_project fallback stream finished", {
            projectId: activeProjectId,
            agentsToTrigger,
            pausedForReview,
          });

          if (pausedForReview) {
            let suggestions = suggestedAgentsFromEvents.length > 0
              ? suggestedAgentsFromEvents
              : ["continue", "review"];
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: suggestions,
              messageId: suggestedAgentsMessageId || latestSuggestions?.messageId || "",
              buttons: latestSuggestions?.buttons,
            });
            const continueButtonLabel = suggestions.includes("continue") ? await determineContinueButtonLabel(client, activeProjectId) : undefined;
            const text = buildSuggestedAgentsText(activeProjectId, suggestions, "", continueButtonLabel, latestSuggestions?.buttons);
            return {
              content: [{ type: "text", text }],
              details: { status: "paused_for_review", suggestions },
              presentation: buildSuggestedAgentsPresentation(activeProjectId, suggestions, "", continueButtonLabel, latestSuggestions?.buttons),
            };
          }

          return silentToolResult({
            status: "agents_running",
            agents: agentsToTrigger,
            projectId: activeProjectId,
          });
        }

        if (shouldStartBuilding) {
          const activeModel = await readActiveModel(stateDir);
          const [tasksForBuild, archForBuild] = await Promise.all([
            client.getTasks(activeProjectId).catch(() => null),
            client.getArchitecture(activeProjectId).catch(() => null),
          ]);

          function hasGeneratedData(data: unknown): boolean {
            if (!data) return false;
            if (Array.isArray(data)) return data.length > 0;
            if (typeof data === "object") {
              return Object.values(data).some((val) => Array.isArray(val) && val.length > 0);
            }
            return false;
          }

          const canStartBuilding = hasGeneratedData(tasksForBuild) && hasGeneratedData(archForBuild);
          log.info("start_building selected via continue_project fallback", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            suggestions: latestSuggestions.agents,
            hasTasks: hasGeneratedData(tasksForBuild),
            hasArchitecture: hasGeneratedData(archForBuild),
            canStartBuilding,
          });
          if (!canStartBuilding) {
            return {
              content: [{ type: "text", text: "Start Building is not available yet. Architecture and tasks must be generated first." }],
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
            await client.startBuilding(activeProjectId, activeModel);
          } catch (err) {
            const insufficientCreditsText = getInsufficientCreditsMessageFromError(err);
            if (insufficientCreditsText) {
              return {
                content: [{ type: "text", text: insufficientCreditsText }],
              };
            }
            throw err;
          }
          const designPreviewText = await getDesignPreviewText(client, activeProjectId);
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
                designPreviewText,
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

        if (hasContinueSuggestion) {
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: [],
            messageId: latestSuggestions?.messageId ?? "",
          });
          log.info("continue_project consuming continue suggestion", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            messageId: latestSuggestions?.messageId ?? "",
          });
          await client.resumeDesign(activeProjectId);
        } else {
          log.info("continue_project continuing already-running design job without resume call", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            action: reattachRunningLog?.action,
            agentType: reattachRunningLog?.agent_type,
            summary: reattachRunningLog?.summary,
          });
        }

        const logs: string[] = [];
        
        let logCount = 0;
        let pausedForReview = false;
        let lastProjectEvent: Record<string, unknown> | null = null;
        let sawStartBuildingReviewMessage = false;
        let rawEventCount = 0;
        let streamError: string | null = null;
        const suggestedAgentsFromEvents: string[] = [];
        let suggestedAgentsMessageId = "";
        let suggestedAgentsButtons: any[] | undefined = undefined;

        const emitProgress = createProgressEmitter(onUpdate, activeProjectId, "design");

        try {
          await client.streamProjectEvents(activeProjectId, {
            onRaw: (raw) => {
              rawEventCount++;
              try {
                lastProjectEvent = JSON.parse(raw) as Record<string, unknown>;
                emitProgress(lastProjectEvent);
                
                if (lastProjectEvent.type === "error") {
                  streamError = String(lastProjectEvent.message || lastProjectEvent.content || JSON.stringify(lastProjectEvent));
                }

                const agents = lastProjectEvent.agents || lastProjectEvent.suggested_agents || lastProjectEvent.suggestedAgents || lastProjectEvent.pending_suggested_agents;
                if (agents) {
                  let agentList: string[] = [];
                  if (Array.isArray(agents)) agentList = agents;
                  else if (typeof agents === "object" && agents !== null) {
                    for (const [key, value] of Object.entries(agents)) {
                      if (typeof value === "string") agentList.push(value);
                      else if (value === true) agentList.push(key);
                    }
                  }
                  if (agentList.length > 0) {
                    for (const a of agentList) {
                      if (!suggestedAgentsFromEvents.includes(a)) {
                        suggestedAgentsFromEvents.push(a);
                      }
                    }
                    if (lastProjectEvent.message_id || lastProjectEvent.messageId) {
                      suggestedAgentsMessageId = String(lastProjectEvent.message_id || lastProjectEvent.messageId);
                    }
                  }
                }

                const buttons = lastProjectEvent.buttons || lastProjectEvent.pending_suggested_buttons || lastProjectEvent.suggested_buttons;
                if (buttons && Array.isArray(buttons)) {
                  suggestedAgentsButtons = buttons;
                }

                const matchesStartBuildingReviewMessage = isReviewArchitectureStartBuildingChatMessage(lastProjectEvent);
                log.info("continue_project /events raw event for regex", {
                  projectId: activeProjectId,
                  source: "continue_project_tool",
                  eventIndex: rawEventCount,
                  raw,
                  type: lastProjectEvent.type,
                  status: lastProjectEvent.status,
                  action: lastProjectEvent.action,
                  content: lastProjectEvent.content,
                  message: lastProjectEvent.message,
                  summary: lastProjectEvent.summary,
                  matchesStartBuildingReviewMessage,
                });
                if (matchesStartBuildingReviewMessage) {
                  sawStartBuildingReviewMessage = true;
                }
              } catch (err) {
                log.info("continue_project /events raw parse failed for regex", {
                  projectId: activeProjectId,
                  source: "continue_project_tool",
                  eventIndex: rawEventCount,
                  raw,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            },
            onAgentLog: (agentLog) => {
              logCount++;
              const entry = `[${agentLog.agent_type}] ${agentLog.summary}`;
              logs.push(entry);
              log.info("continue_project event agent_log", {
                projectId: activeProjectId,
                action: agentLog.action,
                agentType: agentLog.agent_type,
                summary: agentLog.summary,
              });
              if (agentLog.action === "failed" || agentLog.action === "error") {
                streamError = `Agent ${agentLog.agent_type} failed: ${agentLog.summary}`;
              }
            },
            onChatMessage: (msg) => {
              logCount++;
              if (isPauseForReviewText(msg.content)) {
                pausedForReview = true;
              }
              const entry = `[System] ${msg.content}`;
              logs.push(entry);
              log.info("continue_project event chat_message", {
                projectId: activeProjectId,
                isPauseForReview: isPauseForReviewText(msg.content),
              });
              if (isReviewArchitectureStartBuildingChatMessage(msg)) {
                sawStartBuildingReviewMessage = true;
              }
              if (msg.status === "paused_for_review") {
                pausedForReview = true;
              }
              const agents = msg.agents || msg.suggested_agents || msg.suggestedAgents || msg.pending_suggested_agents;
              if (agents) {
                let agentList: string[] = [];
                if (Array.isArray(agents)) agentList = agents;
                else if (typeof agents === "object" && agents !== null) {
                  for (const [key, value] of Object.entries(agents)) {
                    if (typeof value === "string") agentList.push(value);
                    else if (value === true) agentList.push(key);
                  }
                }
                if (agentList.length > 0) {
                  for (const a of agentList) {
                    if (!suggestedAgentsFromEvents.includes(a)) {
                      suggestedAgentsFromEvents.push(a);
                    }
                  }
                  if (msg.message_id || msg.messageId) {
                    suggestedAgentsMessageId = String(msg.message_id || msg.messageId);
                  }
                }
              }
              const buttons = msg.buttons || msg.pending_suggested_buttons || msg.suggested_buttons;
              if (buttons && Array.isArray(buttons)) {
                suggestedAgentsButtons = buttons;
              }
            },
            onPlanningComplete: (data) => {
              if (data.status === "paused_for_review") {
                pausedForReview = true;
              }
            },
            idleTimeoutMs: 120_000,
            progressTimeoutMs: 120_000,
            maxTimeoutMs: 180_000,
            signal: toolAbortController.signal,
          });
        } catch (err) {
          log.info("continue_project event stream failed; continuing with project polling", {
            projectId: activeProjectId,
            error: err instanceof Error ? err.message : String(err),
            aborted: toolAbortController.signal.aborted,
          });
        }

        if (toolAbortController.signal.aborted) {
          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Operation aborted by client." }],
              details: { status: "aborted", projectId: activeProjectId }
            };
          }
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: [],
            messageId: suggestedAgentsMessageId || latestSuggestions?.messageId || "",
          });
          return silentToolResult({
            status: "running",
            suggestions: [],
            projectId: activeProjectId,
          });
        }

        if (streamError) {
          throw new Error(streamError);
        }

        // If we got no logs after a while, or the stream closed, proceed to fetch results
        if (logCount === 0) {
          await new Promise(r => setTimeout(r, 2000)); // Brief pause to ensure backend processed resume
        }
        log.info("start_building condition-check 1 in continue_project_tool", {
          projectId: activeProjectId,
          source: "continue_project_tool",
          step: "fetch_outputs_start",
        });
        const [designPages, tasks, arch, hasReviewBuildSystemMessage] = await Promise.all([
          client.getDesignPages(activeProjectId).catch(() => null),
          client.getTasks(activeProjectId).catch(() => null),
          client.getArchitecture(activeProjectId).catch(() => null),
          client.hasReviewBuildSystemMessage(activeProjectId).catch(() => false),
        ]);
        const eventEndedWithStartBuildingMessage =
          sawStartBuildingReviewMessage ||
          isReviewArchitectureStartBuildingChatMessage(lastProjectEvent) ||
          hasReviewBuildSystemMessage;
        const eventEndedAtReviewCheckpoint =
          eventEndedWithStartBuildingMessage ||
          (lastProjectEvent?.type === "chat_message" && isPauseForReviewText(lastProjectEvent.content));
        log.info("continue_project review_build phase decision", {
          projectId: activeProjectId,
          lastEventType: lastProjectEvent?.type,
          lastEventContent: previewLogText(lastProjectEvent?.content),
          rawEventCount,
          sawStartBuildingReviewMessage,
          hasReviewBuildSystemMessage,
          eventEndedWithStartBuildingMessage,
          eventEndedAtReviewCheckpoint,
        });

        function hasGeneratedData(data: unknown): boolean {
          if (!data) return false;
          if (Array.isArray(data)) return data.length > 0;
          if (typeof data === 'object') {
            for (const val of Object.values(data)) {
              if (Array.isArray(val) && val.length > 0) return true;
            }
          }
          return false;
        }

        const designPagesReady = hasCompletedDesignPages(designPages);
        const isGenerated = hasGeneratedData(designPages) || hasGeneratedData(tasks) || hasGeneratedData(arch);
        const hasTasks = hasGeneratedData(tasks);
        const hasArchitecture = hasGeneratedData(arch);
        const hasDesignPages = hasGeneratedData(designPages);
        log.info("start_building condition-check 2 in continue_project_tool", {
          projectId: activeProjectId,
          source: "continue_project_tool",
          step: "fetch_outputs_done",
          hasDesignPages,
          hasTasks,
          hasArchitecture,
          designPagesReady,
          designPagesSummary: summarizeDesignPages(designPages),
          isGenerated,
        });
        const logsText = "";

        if (pausedForReview) {
          const statusAfterPause = await client.getProjectStatus(activeProjectId).catch(() => null);
          const pendingAfterPause = extractPendingSuggestion(statusAfterPause?.pending_suggested_agents);
          
          let rawSuggestions = suggestedAgentsFromEvents.length > 0
            ? suggestedAgentsFromEvents
            : pendingAfterPause.agents;
            
          let rawButtons = suggestedAgentsButtons !== undefined
            ? suggestedAgentsButtons
            : pendingAfterPause.buttons;

          let rawMessageId = suggestedAgentsMessageId || pendingAfterPause.messageId || latestSuggestions?.messageId || "";

          const backendSuggestions = rawSuggestions.filter((agent) =>
            agent === "continue" ||
            agent === "review" ||
            agent === "generate_first_page" ||
            agent === "generate_all_pages" ||
            agent === "generate_architecture" ||
            agent === "start_building"
          );
          const hasBackendContinue = backendSuggestions.some((agent) =>
            agent === "continue" ||
            agent === "generate_first_page" ||
            agent === "generate_all_pages" ||
            agent === "generate_architecture" ||
            agent === "start_building"
          );
          const suggestions = hasBackendContinue ? backendSuggestions : ["continue", "review"];
          const hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(activeProjectId);
          log.info("continue_project paused_for_review backend suggestion gate", {
            projectId: activeProjectId,
            pendingSuggestions: rawSuggestions,
            backendSuggestions,
            filteredSuggestions: suggestions,
            hasBackendContinue,
            hasLatestCompletedAgentLog,
            eventEndedAtReviewCheckpoint,
          });
          if (!eventEndedAtReviewCheckpoint && !hasLatestCompletedAgentLog) {
            pausedForReview = false;
          } else {
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: suggestions,
              messageId: rawMessageId,
              buttons: rawButtons,
            });
            const continueButtonLabel = suggestions.includes("continue") ? await determineContinueButtonLabel(client, activeProjectId) : undefined;
            const finalResult = buildSuggestedAgentsText(activeProjectId, suggestions, "", continueButtonLabel, rawButtons);
            const presentation = buildSuggestedAgentsPresentation(activeProjectId, suggestions, "", continueButtonLabel, rawButtons);
            onUpdate?.({ content: [{ type: "text", text: finalResult }] });
            return {
              content: [{ type: "text", text: finalResult }],
              details: {
                status: "paused_for_review",
                suggestions,
              },
              presentation,
            };
          }
        }

        log.info("start_building readiness decision ", {
          projectId: activeProjectId,
          source: "continue_project_tool",
          hasTasks,
          hasArchitecture,
          willShow: hasTasks && hasArchitecture,
        });

        if (hasTasks && hasArchitecture) {
          if (!eventEndedWithStartBuildingMessage) {
            const statusAfterReadiness = await client.getProjectStatus(activeProjectId).catch(() => null);
            const pendingAfterReadiness = extractPendingSuggestion(statusAfterReadiness?.pending_suggested_agents);
            const backendResumeSuggestions = pendingAfterReadiness.agents.filter((agent) =>
              agent === "continue" || agent === "review"
            );
            const suggestions = backendResumeSuggestions.includes("continue")
              ? backendResumeSuggestions
              : ["continue", "review"];
            log.info("start_building final message gated by events regex", {
              projectId: activeProjectId,
              source: "continue_project_tool",
              hasTasks,
              hasArchitecture,
              eventEndedWithStartBuildingMessage,
              pendingSuggestions: pendingAfterReadiness.agents,
              backendResumeSuggestions,
              suggestions,
              reason: "waiting_for_review_design_architecture_start_building_event",
            });
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: suggestions,
              messageId: pendingAfterReadiness.messageId || latestSuggestions?.messageId || "",
              buttons: pendingAfterReadiness.buttons,
            });
            const continueButtonLabel = suggestions.includes("continue") ? await determineContinueButtonLabel(client, activeProjectId) : undefined;
            const finalResult =
              "8080.ai has generated the design, tasks, and architecture, but the final review/start-building event has not appeared in `/events` yet.\n\n" +
              buildSuggestedAgentsText(activeProjectId, suggestions, "", continueButtonLabel, pendingAfterReadiness.buttons);
            const presentation = buildSuggestedAgentsPresentation(activeProjectId, suggestions, "", continueButtonLabel, pendingAfterReadiness.buttons);
            onUpdate?.({ content: [{ type: "text", text: finalResult }] });
            return {
              content: [{ type: "text", text: finalResult }],
              details: {
                status: "waiting_for_start_building_review_event",
                suggestions,
                projectId: activeProjectId,
                hasTasks,
                hasArchitecture,
              },
              presentation,
            };
          }

          const canBuildForPlan = true;
          log.info("start_building show decision", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            canBuildForPlan,
          });
          const canShowStartBuilding = canBuildForPlan && eventEndedWithStartBuildingMessage;
          const statusAfterReadiness = await client.getProjectStatus(activeProjectId).catch(() => null);
          const pendingAfterReadiness = extractPendingSuggestion(statusAfterReadiness?.pending_suggested_agents);
          const backendResumeSuggestions = pendingAfterReadiness.agents.filter((agent) =>
            agent === "continue" || agent === "review"
          );
          const hasBackendContinue = backendResumeSuggestions.includes("continue");
          log.info("agent_logs continue override decision", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            eventEndedWithStartBuildingMessage,
            backendResumeSuggestions,
            hasBackendContinue,
            hasTasks,
            hasArchitecture,
            canBuildForPlan,
            willShowStartBuilding: canShowStartBuilding,
            reason: canShowStartBuilding
              ? "tasks_architecture_and_review_build_signal_ready"
              : !eventEndedWithStartBuildingMessage
                ? "waiting_for_events_review_start_building_message"
                : "waiting_for_start_building_signal",
          });
          const canShowReviewActions =
            hasBackendContinue &&
            eventEndedAtReviewCheckpoint;
          const suggestions = canShowStartBuilding
            ? ["start_building"]
            : canBuildForPlan && canShowReviewActions
              ? backendResumeSuggestions
              : [];
          log.info("suggestions final decision before write", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            suggestions,
            writeSuggestions: suggestions.length > 0,
            eventEndedWithStartBuildingMessage,
            backendResumeSuggestions,
            hasBackendContinue,
            canShowReviewActions,
            hasTasks,
            hasArchitecture,
            canBuildForPlan,
          });
          log.info("start_building shown", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            shown: canShowStartBuilding,
            reason: canShowStartBuilding
              ? "resume_completed_with_architecture_tasks_and_review_build_signal"
              : canBuildForPlan
                ? "waiting_for_events_review_start_building_message"
                : "waiting_for_start_building_signal",
          });
          if (suggestions.length > 0) {
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: suggestions,
              messageId: latestSuggestions?.messageId ?? "",
              buttons: pendingAfterReadiness.buttons,
            });
          }
          const continueButtonLabel = suggestions.includes("continue") ? await determineContinueButtonLabel(client, activeProjectId) : undefined;
          const finalResult =
            `✅ **Generation complete!**${logsText}\n\n` +
            (canShowStartBuilding
              ? `Review the design and architecture and start building.\n\n${buildSuggestedAgentsText(activeProjectId, suggestions, "", continueButtonLabel, pendingAfterReadiness.buttons)}`
              : canBuildForPlan
                ? `The design, tasks, and architecture are available.${suggestions.length > 0 ? `\n\n${buildSuggestedAgentsText(activeProjectId, suggestions, "", continueButtonLabel, pendingAfterReadiness.buttons)}` : ""}`
                : `The design, tasks, and architecture are available.`);
          onUpdate?.({ content: [{ type: "text", text: finalResult }] });
          return {
            content: [{ type: "text", text: finalResult }],
            details: {
              status: canShowStartBuilding ? "complete" : "running",
              suggestions,
            },
            presentation: suggestions.length > 0
              ? buildSuggestedAgentsPresentation(activeProjectId, suggestions, "", continueButtonLabel, pendingAfterReadiness.buttons)
              : undefined,
          };
        } else {
          // Poll for design completion if the SSE stream ends before the
          // backend exposes the next action. Keep waiting until 8080.ai is ready
          // or the user/client cancels the tool call.
          const POLL_INTERVAL_MS = 10_000;
          const MAX_POLL_WAIT_MS = 90_000;
          const pollStartedAt = Date.now();
          let pollAttempt = 0;
          let canShowReviewActions = false;
          let backendSuggestions: string[] = [];
          let pending = extractPendingSuggestion(null);
          let hasBackendContinue = false;
          let hasLatestCompletedAgentLog = false;
          let latestDesignPagesReady = designPagesReady;
          let latestHasDesignPages = hasGeneratedData(designPages);

          while (!toolAbortController.signal.aborted) {
            if (toolAbortController.signal.aborted) {
              break;
            }
            const statusAfter = await client.getProjectStatus(activeProjectId).catch(() => null);
            
            // Check for failed agent logs or error status
            const logsList = await client.getAgentLogs(activeProjectId).catch(() => []);
            const failedLog = logsList.find(l => l.action === "failed" || l.action === "error" || (typeof l.summary === "string" && /failed|error/i.test(l.summary)));
            if (failedLog) {
              throw new Error(`Agent ${failedLog.agent_type} failed: ${failedLog.summary}`);
            }
            if (statusAfter?.error) {
              throw new Error(statusAfter.error);
            }

            pending = extractPendingSuggestion(statusAfter?.pending_suggested_agents);
            
            let rawSuggestions = suggestedAgentsFromEvents.length > 0
              ? suggestedAgentsFromEvents
              : pending.agents;

            backendSuggestions = rawSuggestions.filter((agent) =>
              agent === "continue" ||
              agent === "review" ||
              agent === "generate_first_page" ||
              agent === "generate_all_pages" ||
              agent === "generate_architecture" ||
              agent === "start_building"
            );
            hasBackendContinue = backendSuggestions.some((agent) =>
              agent === "continue" ||
              agent === "generate_first_page" ||
              agent === "generate_all_pages" ||
              agent === "generate_architecture" ||
              agent === "start_building"
            );
            hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(activeProjectId);

            // Re-check design pages in case they finished since the SSE stream ended
            if (!latestDesignPagesReady) {
              const freshDesignPages = await client.getDesignPages(activeProjectId).catch(() => null);
              latestDesignPagesReady = hasCompletedDesignPages(freshDesignPages);
              latestHasDesignPages = hasGeneratedData(freshDesignPages);
            }

            canShowReviewActions =
              (hasBackendContinue && (hasLatestCompletedAgentLog || pausedForReview || eventEndedAtReviewCheckpoint)) ||
              (latestHasDesignPages && hasLatestCompletedAgentLog) ||
              latestDesignPagesReady;

            log.info("continue_project backend suggestion gate", {
              projectId: activeProjectId,
              source: "continue_project_tool",
              pollAttempt,
              pendingSuggestions: rawSuggestions,
              backendSuggestions,
              messageId: pending.messageId,
              hasBackendContinue,
              hasLatestCompletedAgentLog,
              pausedForReview,
              eventEndedAtReviewCheckpoint,
              canShowReviewActions,
              hasTasks,
              hasArchitecture,
              hasDesignPages: latestHasDesignPages,
              designPagesReady: latestDesignPagesReady,
              lastEventType: lastProjectEvent?.type,
              eventEndedWithStartBuildingMessage,
              reason: hasBackendContinue
                ? "backend_pending_suggested_agents_contains_continue"
                : latestHasDesignPages && hasLatestCompletedAgentLog
                  ? "design_pages_generated_and_latest_agent_log_completed"
                : latestDesignPagesReady
                  ? "design_pages_generation_completed"
                : canShowReviewActions
                  ? "completed_agent_log_or_events_review_checkpoint"
                  : "waiting_for_completed_agent_log_or_events_review_checkpoint",
            });

            if (canShowReviewActions) break;

            if (Date.now() - pollStartedAt >= MAX_POLL_WAIT_MS) {
              const stillProcessingText = buildStillProcessingText(activeProjectId, latestDesignPagesReady, latestHasDesignPages);
              log.info("continue_project returning still-processing checkpoint before OpenClaw watchdog", {
                projectId: activeProjectId,
                source: "continue_project_tool",
                pollAttempt,
                elapsedMs: Date.now() - pollStartedAt,
                hasDesignPages: latestHasDesignPages,
                designPagesReady: latestDesignPagesReady,
              });
              onUpdate?.({ content: [{ type: "text", text: stillProcessingText }] });
              return {
                content: [{ type: "text", text: stillProcessingText }],
                details: {
                  status: "running",
                  projectId: activeProjectId,
                  suggestions: [],
                  reason: "still_processing",
                },
              };
            }

            pollAttempt++;
            log.info("continue_project polling for design completion", {
              projectId: activeProjectId,
              pollAttempt,
              nextPollInMs: POLL_INTERVAL_MS,
            });
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          }

          if (toolAbortController.signal.aborted) {
            return {
              content: [{ type: "text", text: "Operation aborted by client." }],
              details: { status: "aborted", projectId: activeProjectId }
            };
          }

          const suggestions = backendSuggestions.length > 0 ? backendSuggestions : ["continue", "review"];
            
          let finalButtons = suggestedAgentsButtons !== undefined
            ? suggestedAgentsButtons
            : pending.buttons;

          let finalMessageId = suggestedAgentsMessageId || pending.messageId || latestSuggestions?.messageId || "";

          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: suggestions,
            messageId: finalMessageId,
            buttons: finalButtons,
          });
          const continueButtonLabel = suggestions.includes("continue") ? await determineContinueButtonLabel(client, activeProjectId) : undefined;
          const finalResult = buildSuggestedAgentsText(activeProjectId, suggestions, "", continueButtonLabel, finalButtons);
          const presentation = canShowReviewActions
            ? buildSuggestedAgentsPresentation(activeProjectId, suggestions, "", continueButtonLabel, finalButtons)
            : undefined;
          onUpdate?.({ content: [{ type: "text", text: finalResult }], details: null, presentation });
          return {
            content: [{ type: "text", text: finalResult }],
            details: {
              status: canShowReviewActions ? "checkpoint" : "running",
              suggestions,
            },
            presentation,
          };
        }
      } catch (err) {
        if (err instanceof AuthError) {
          if (activeProjectId) {
            const suggestions = ["continue", "review"];
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

function previewLogText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function buildStillProcessingText(projectId: string, designPagesReady = false, hasDesignPages = false): string {
  const statusLine = designPagesReady
    ? "8080.ai has generated design output and is preparing the next review action."
    : hasDesignPages
      ? "8080.ai is still processing design output."
      : "8080.ai is still processing this project.";

  return [
    "⏳ **8080.ai is still processing**",
    statusLine,
    "I stopped waiting in OpenClaw so the chat does not get stuck. The work is still running on 8080.ai.",
    `Try **Continue** again shortly or check project status for \`${projectId}\`.`,
  ].join("\n\n");
}

function summarizeProgressEvent(event: Record<string, unknown>, fallbackPhase: string): string {
  if (event.type === "design_pages" && Array.isArray(event.design_pages)) {
    const page = event.design_pages.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    if (page) {
      const pageName = typeof page.page_name === "string" ? page.page_name : "page";
      const done = typeof page.sections_done === "number" ? page.sections_done : undefined;
      const total = typeof page.sections_total === "number" ? page.sections_total : undefined;
      const phase = typeof page.generation_phase === "string" ? page.generation_phase : fallbackPhase;
      const sectionText = done !== undefined && total !== undefined ? ` (${done}/${total} sections)` : "";
      return `8080.ai is ${phase} ${pageName}${sectionText}...`;
    }
  }

  const agentType = typeof event.agent_type === "string" ? event.agent_type : undefined;
  const content = previewLogText(event.content, 120) ?? previewLogText(event.summary, 120) ?? previewLogText(event.message, 120);
  if (agentType && content) return `${agentType}: ${content}`;
  if (content) return content;
  return `8080.ai is still processing ${fallbackPhase}...`;
}

function createProgressEmitter(
  onUpdate: ((partial: { content: { type: "text"; text: string }[] }) => void) | undefined,
  projectId: string,
  fallbackPhase: string
) {
  let lastProgressUpdateAt = 0;
  return (event: Record<string, unknown>) => {
    const now = Date.now();
    if (now - lastProgressUpdateAt < 25_000) return;
    lastProgressUpdateAt = now;
    const progressText = [
      "⏳ **8080.ai is processing...**",
      summarizeProgressEvent(event, fallbackPhase),
      `Project: \`${projectId}\``,
    ].join("\n\n");
    onUpdate?.({ content: [{ type: "text", text: progressText }] });
  };
}

type BasicAgentLog = {
  action?: string | null;
  agent_type?: string | null;
  summary?: string | null;
  message_id?: string | null;
  created_at?: string | null;
};

function findLatestRunningDesignLog(logs: BasicAgentLog[]): BasicAgentLog | undefined {
  return [...logs]
    .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
    .find((entry) => {
      const action = String(entry.action ?? "").toLowerCase();
      if (action !== "started" && action !== "running") return false;

      const agentType = String(entry.agent_type ?? "").toLowerCase();
      const summary = String(entry.summary ?? "").toLowerCase();
      const messageId = String(entry.message_id ?? "").toLowerCase();
      const text = `${agentType} ${summary}`;

      return (
        messageId === "resume-design" ||
        agentType.includes("design") ||
        text.includes("designing") ||
        text.includes("starting design") ||
        text.includes("resuming pipeline")
      );
    });
}

function summarizeDesignPages(data: unknown) {
  return getDesignPageRecords(data).slice(0, 5).map((page) => ({
    page_name: page.page_name,
    generation_in_progress: page.generation_in_progress,
    generation_failed: page.generation_failed,
    sections_done: page.sections_done,
    sections_total: page.sections_total,
    generation_phase: page.generation_phase,
    has_screenshot: Boolean(page.screenshot_url || page.screenshot_thumb_url),
  }));
}
