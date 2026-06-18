import { Type } from "@sinclair/typebox";
import { AuthError, isPauseForReviewText, isReviewArchitectureStartBuildingChatMessage, requireAuthenticatedClient } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { readLatestSuggestionsForProject, writeLatestSuggestions } from "./suggestions-state.ts";
import { silentToolResult } from "./exact-response.ts";
import { log } from "../logger.ts";
import { readActiveModel } from "./model-state.ts";
import { canShowStartBuildingTasks, canUseStartBuilding, detectSubscriptionTier, formatStartBuildingTasks, getUpgradeToBuildText } from "./task-summary.ts";
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
      "Do not use for Run Plan All or Start Building; those must trigger the suggested agents or build action. " +
      "If this tool returns no visible content, do not summarize, announce, or confirm the action; remain silent until the plugin returns visible next-step actions.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String({
        description: "The 8080.ai project ID. Optional if a project is already active.",
      })),
    }),

    async execute(
      _id: string,
      params: { projectId?: string },
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[] }) => void
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl, sessionId } = deps;
      let activeProjectId = params.projectId;

      try {
        const { readActiveProject } = await import("./project-state.ts");
        activeProjectId = activeProjectId || await readActiveProject(stateDir, sessionId) || undefined;
        
        if (!activeProjectId) {
          return {
            content: [{ type: "text", text: "No active project found. Please select a project first." }],
          };
        }

        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        let latestSuggestions = await readLatestSuggestionsForProject(stateDir, sessionId, activeProjectId);
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
            });
            log.info("continue_project recovered review actions from generated design pages", {
              projectId: activeProjectId,
              source: "continue_project_tool",
              staleSuggestions: suggestedAgents,
              recoveredSuggestions,
              latestAgentComplete,
            });
            const text = buildSuggestedAgentsText(activeProjectId, recoveredSuggestions);
            const presentation = buildSuggestedAgentsPresentation(activeProjectId, recoveredSuggestions);
            return {
              content: [{ type: "text", text }],
              details: {
                status: "checkpoint",
                suggestions: recoveredSuggestions,
              },
              presentation,
            };
          }
          log.info("continue_project received plan_all suggestion; showing Run Plan All instead of auto-triggering", {
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
                buildSuggestedAgentsText(activeProjectId, suggestedAgents),
            }],
            details: {
              status: "waiting_for_run_plan_all",
              suggestions: suggestedAgents,
            },
            presentation: buildSuggestedAgentsPresentation(activeProjectId, suggestedAgents),
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
          await client.streamProjectEvents(activeProjectId, {
            onAgentLog: (agentLog) => {
              log.info("continue_project fallback event agent_log", {
                projectId: activeProjectId,
                action: agentLog.action,
                agentType: agentLog.agent_type,
                summary: agentLog.summary,
              });
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
            progressTimeoutMs: 45_000,
            maxTimeoutMs: 180_000,
          });

          log.info("suggested agents continue_project fallback stream finished", {
            projectId: activeProjectId,
            agentsToTrigger,
            pausedForReview,
          });

          if (pausedForReview) {
            const suggestions = ["continue", "review"];
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: suggestions,
              messageId: latestSuggestions?.messageId ?? "",
            });
            const text = buildSuggestedAgentsText(activeProjectId, suggestions);
            return {
              content: [{ type: "text", text }],
              details: { status: "paused_for_review", suggestions },
              presentation: buildSuggestedAgentsPresentation(activeProjectId, suggestions),
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

          const [subscription, plans, profile] = await Promise.all([
            client.getSubscription().catch(() => null),
            client.getSubscriptionPlans().catch(() => []),
            client.getProfile().catch(() => null),
          ]);
          const subscriptionTier = detectSubscriptionTier(subscription, profile, plans);
          const canBuildForPlan = canUseStartBuilding(subscriptionTier);
          log.info("start_building selected plan decision", {
            projectId: activeProjectId,
            source: "continue_project_tool_fallback",
            subscriptionTier,
            canBuildForPlan,
            plansCount: plans.length,
          });
          if (!canBuildForPlan) {
            return {
              content: [{ type: "text", text: getUpgradeToBuildText() }],
            };
          }

          const taskSummaryText = canShowStartBuildingTasks(subscriptionTier)
            ? formatStartBuildingTasks(tasksForBuild, activeProjectId)
            : "";
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
          await client.startBuilding(activeProjectId, activeModel);
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

        const logs: string[] = [];
        
        let logCount = 0;
        let pausedForReview = false;
        let lastProjectEvent: Record<string, unknown> | null = null;
        let sawStartBuildingReviewMessage = false;
        let rawEventCount = 0;
        await client.streamProjectEvents(activeProjectId, {
          onRaw: (raw) => {
            rawEventCount++;
            try {
              lastProjectEvent = JSON.parse(raw) as Record<string, unknown>;
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
          onAgentLog: (log) => {
            logCount++;
            const entry = `[${log.agent_type}] ${log.summary}`;
            logs.push(entry);
            log.info("continue_project event agent_log", {
              projectId: activeProjectId,
              action: log.action,
              agentType: log.agent_type,
              summary: log.summary,
            });
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
          },
          onPlanningComplete: (data) => {
            if (data.status === "paused_for_review") {
              pausedForReview = true;
            }
          },
          idleTimeoutMs: 60_000,
          progressTimeoutMs: 45_000,
          maxTimeoutMs: 180_000,
        });

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
          const backendSuggestions = pendingAfterPause.agents.filter((agent) => agent === "continue" || agent === "review");
          const hasBackendContinue = backendSuggestions.includes("continue");
          const suggestions = hasBackendContinue ? backendSuggestions : ["continue", "review"];
          const hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(activeProjectId);
          log.info("continue_project paused_for_review backend suggestion gate", {
            projectId: activeProjectId,
            pendingSuggestions: pendingAfterPause.agents,
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
              messageId: pendingAfterPause.messageId || latestSuggestions?.messageId || "",
            });
            const finalResult = buildSuggestedAgentsText(activeProjectId, suggestions);
            const presentation = buildSuggestedAgentsPresentation(activeProjectId, suggestions);
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
            });
            const finalResult =
              "8080.ai has generated the design, tasks, and architecture, but the final review/start-building event has not appeared in `/events` yet.\n\n" +
              buildSuggestedAgentsText(activeProjectId, suggestions);
            const presentation = buildSuggestedAgentsPresentation(activeProjectId, suggestions);
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

          const [subscription, plans, profile] = await Promise.all([
            client.getSubscription().catch(() => null),
            client.getSubscriptionPlans().catch(() => []),
            client.getProfile().catch(() => null),
          ]);
          const subscriptionTier = detectSubscriptionTier(subscription, profile, plans);
          const canBuildForPlan = canUseStartBuilding(subscriptionTier);
          log.info("start_building show plan decision", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            subscriptionTier,
            canBuildForPlan,
            plansCount: plans.length,
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
              ? "paid_plan_tasks_architecture_and_review_build_signal_ready"
              : !eventEndedWithStartBuildingMessage
                ? "waiting_for_events_review_start_building_message"
                : "plan_not_allowed",
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
            subscriptionTier,
            canBuildForPlan,
          });
          log.info("start_building shown", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            shown: canShowStartBuilding,
            reason: canShowStartBuilding
              ? "paid_plan_resume_completed_with_architecture_tasks_and_review_build_signal"
              : canBuildForPlan
                ? "waiting_for_events_review_start_building_message"
                : "plan_not_allowed",
          });
          if (suggestions.length > 0) {
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: suggestions,
              messageId: latestSuggestions?.messageId ?? "",
            });
          }
          const finalResult =
            `✅ **Generation complete!**${logsText}\n\n` +
            (canShowStartBuilding
              ? `Review the design and architecture and start building.\n\n${buildSuggestedAgentsText(activeProjectId, suggestions)}`
              : canBuildForPlan
                ? `The design, tasks, and architecture are available.${suggestions.length > 0 ? `\n\n${buildSuggestedAgentsText(activeProjectId, suggestions)}` : ""}`
                : getUpgradeToBuildText());
          onUpdate?.({ content: [{ type: "text", text: finalResult }] });
          return {
            content: [{ type: "text", text: finalResult }],
            details: {
              status: canShowStartBuilding ? "complete" : "running",
              suggestions,
            },
            presentation: suggestions.length > 0
              ? buildSuggestedAgentsPresentation(activeProjectId, suggestions)
              : undefined,
          };
        } else {
          const statusAfter = await client.getProjectStatus(activeProjectId).catch(() => null);
          const pending = extractPendingSuggestion(statusAfter?.pending_suggested_agents);
          const backendSuggestions = pending.agents.filter((agent) => agent === "continue" || agent === "review");
          const hasBackendContinue = backendSuggestions.includes("continue");
          const hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(activeProjectId);
          const canShowReviewActions =
            (hasBackendContinue && (hasLatestCompletedAgentLog || pausedForReview || eventEndedAtReviewCheckpoint)) ||
            (hasDesignPages && hasLatestCompletedAgentLog) ||
            designPagesReady;
          const suggestions = canShowReviewActions
            ? (backendSuggestions.length > 0 ? backendSuggestions : ["continue", "review"])
            : [];
          log.info("continue_project backend suggestion gate", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            pendingSuggestions: pending.agents,
            backendSuggestions,
            messageId: pending.messageId,
            hasBackendContinue,
            hasLatestCompletedAgentLog,
            pausedForReview,
            eventEndedAtReviewCheckpoint,
            canShowReviewActions,
            hasTasks,
            hasArchitecture,
            hasDesignPages,
            designPagesReady,
            designPagesSummary: summarizeDesignPages(designPages),
            lastEventType: lastProjectEvent?.type,
            eventEndedWithStartBuildingMessage,
            reason: hasBackendContinue
              ? "backend_pending_suggested_agents_contains_continue"
              : hasDesignPages && hasLatestCompletedAgentLog
                ? "design_pages_generated_and_latest_agent_log_completed"
              : designPagesReady
                ? "design_pages_generation_completed"
              : canShowReviewActions
                ? "completed_agent_log_or_events_review_checkpoint"
                : "waiting_for_completed_agent_log_or_events_review_checkpoint",
          });
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: suggestions,
            messageId: pending.messageId || latestSuggestions?.messageId || "",
          });
          if (!canShowReviewActions) {
            return silentToolResult({
              status: "running",
              suggestions,
              projectId: activeProjectId,
            });
          }
          const finalResult = buildSuggestedAgentsText(activeProjectId, suggestions);
          const presentation = canShowReviewActions
            ? buildSuggestedAgentsPresentation(activeProjectId, suggestions)
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
              presentation: buildSuggestedAgentsPresentation(activeProjectId, suggestions),
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

function getDesignPageRecords(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter((page): page is Record<string, unknown> => Boolean(page) && typeof page === "object");
  }
  if (!data || typeof data !== "object") return [];

  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const pages = value.filter((page): page is Record<string, unknown> => Boolean(page) && typeof page === "object");
    if (pages.length > 0) return pages;
  }

  return [];
}

function hasCompletedDesignPages(data: unknown): boolean {
  const pages = getDesignPageRecords(data);
  if (pages.length === 0) return false;

  return pages.every((page) => {
    if (page.generation_failed === true || page.credit_blocked === true) return false;

    const sectionsDone = typeof page.sections_done === "number" ? page.sections_done : undefined;
    const sectionsTotal = typeof page.sections_total === "number" ? page.sections_total : undefined;
    const phase = typeof page.generation_phase === "string" ? page.generation_phase.toLowerCase() : "";
    const isReviewPhase = ["review", "reviewing"].some((token) => phase.includes(token));
    const hasRenderableOutput = Boolean(
      page.compiled_html || page.jsx_content || page.screenshot_url || page.screenshot_thumb_url
    );

    if (sectionsTotal !== undefined && sectionsTotal > 0) {
      const sectionsComplete = sectionsDone !== undefined && sectionsDone >= sectionsTotal;
      if (sectionsComplete && isReviewPhase && hasRenderableOutput) return true;
      if (page.generation_in_progress === true) return false;
      return sectionsComplete;
    }

    if (page.generation_in_progress === true && !(isReviewPhase && hasRenderableOutput)) return false;
    if (phase && !["complete", "completed", "done", "screenshot", "review"].some((token) => phase.includes(token))) {
      return false;
    }

    return hasRenderableOutput;
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
