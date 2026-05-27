import { Type } from "@sinclair/typebox";
import { AuthRequiredError } from "./auth.ts";
import { AuthError, isReviewArchitectureStartBuildingChatMessage, requireAuthenticatedClient } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { readLatestSuggestionsForProject, writeLatestSuggestions } from "./suggestions-state.ts";
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
      "Do not use for Run Plan All or Start Building; those must trigger the suggested agents or build action.",
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
        const hasPlanAllSuggestion = suggestedAgents.some((agent) =>
          agent === "plan_all" || (agent.startsWith("GROUP:") && agent.slice(6).split("|").includes("plan_all"))
        );
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

          let accumulatedText = agentsToTrigger.includes("plan_all")
            ? "✅ **Triggered agents:** System Requirements Agent, User Flow Planner, Tech Lead Agent\n\n"
            : `✅ **Triggered agents:** ${agentsToTrigger.join(", ")}\n\n`;
          for (const agent of agentsToTrigger) {
            accumulatedText += `⏳ [Agent] **${agent}** is running...\n`;
          }
          onUpdate?.({ content: [{ type: "text", text: accumulatedText }] });

          let pausedForReview = false;
          await client.streamProjectEvents(activeProjectId, {
            onAgentLog: (agentLog) => {
              if (agentLog.action === "completed") {
                accumulatedText += `✅ [Agent] **${agentLog.agent_type}** completed: ${agentLog.summary}\n`;
              } else if (agentLog.action === "started") {
                accumulatedText += `⏳ [Agent] **${agentLog.agent_type}** started: ${agentLog.summary}\n`;
              } else {
                accumulatedText += `ℹ️ [Agent] **${agentLog.agent_type}**: ${agentLog.summary}\n`;
              }
              onUpdate?.({ content: [{ type: "text", text: accumulatedText }] });
            },
            onChatMessage: (msg) => {
              accumulatedText += `\n**System:** ${msg.content}\n`;
              onUpdate?.({ content: [{ type: "text", text: accumulatedText }] });
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
            accumulatedText += `\n\n${buildSuggestedAgentsText(activeProjectId, suggestions)}`;
            return {
              content: [{ type: "text", text: accumulatedText }],
              details: { status: "paused_for_review", suggestions },
              presentation: buildSuggestedAgentsPresentation(activeProjectId, suggestions),
            };
          }

          return {
            content: [{ type: "text", text: accumulatedText }],
            details: { status: "triggered", agents: agentsToTrigger },
          };
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

        await client.resumeDesign(activeProjectId);

        onUpdate?.({ content: [{ type: "text", text: "🚀 Design agents running..." }] });

        let accumulatedText = "";
        const logs: string[] = [];
        
        let logCount = 0;
        let pausedForReview = false;
        let lastProjectEvent: Record<string, unknown> | null = null;
        await client.streamProjectEvents(activeProjectId, {
          onRaw: (raw) => {
            try {
              lastProjectEvent = JSON.parse(raw) as Record<string, unknown>;
              log.info("continue_project /events raw event", {
                projectId: activeProjectId,
                type: lastProjectEvent.type,
                action: lastProjectEvent.action,
                content: previewLogText(lastProjectEvent.content),
                matchesStartBuildingReviewMessage: isReviewArchitectureStartBuildingChatMessage(lastProjectEvent),
              });
            } catch (err) {
              log.info("continue_project /events raw parse failed", { projectId: activeProjectId, raw, err });
            }
          },
          onAgentLog: (log) => {
            logCount++;
            const entry = `[${log.agent_type}] ${log.summary}`;
            logs.push(entry);
            accumulatedText = `🚀 Agents are working...\n\n**Activity Log:**\n${logs.map(l => `- ${l}`).join("\n")}`;
            onUpdate?.({ content: [{ type: "text", text: accumulatedText }] });
          },
          onChatMessage: (msg) => {
            logCount++;
            const entry = `[System] ${msg.content}`;
            logs.push(entry);
            accumulatedText = `🚀 Agents are working...\n\n**Activity Log:**\n${logs.map(l => `- ${l}`).join("\n")}`;
            onUpdate?.({ content: [{ type: "text", text: accumulatedText }] });
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
        const eventEndedWithStartBuildingMessage = isReviewArchitectureStartBuildingChatMessage(lastProjectEvent);
        log.info("continue_project /events final event decision", {
          projectId: activeProjectId,
          lastEventType: lastProjectEvent?.type,
          lastEventContent: previewLogText(lastProjectEvent?.content),
          eventEndedWithStartBuildingMessage,
        });

        log.info("start_building condition-check 1 in continue_project_tool", {
          projectId: activeProjectId,
          source: "continue_project_tool",
          step: "fetch_outputs_start",
        });
        const [designPages, tasks, arch] = await Promise.all([
          client.getDesignPages(activeProjectId).catch(() => null),
          client.getTasks(activeProjectId).catch(() => null),
          client.getArchitecture(activeProjectId).catch(() => null),
        ]);

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
          isGenerated,
        });
        const logsText = logs.length > 0 ? `\n\n**Activity Log:**\n${logs.map(l => `- ${l}`).join("\n")}` : "";

        if (pausedForReview) {
          const statusAfterPause = await client.getProjectStatus(activeProjectId).catch(() => null);
          const pendingAfterPause = extractPendingSuggestion(statusAfterPause?.pending_suggested_agents);
          const suggestions = pendingAfterPause.agents.filter((agent) => agent === "continue" || agent === "review");
          const hasBackendContinue = suggestions.includes("continue");
          log.info("continue_project paused_for_review backend suggestion gate", {
            projectId: activeProjectId,
            pendingSuggestions: pendingAfterPause.agents,
            filteredSuggestions: suggestions,
            hasBackendContinue,
          });
          if (!hasBackendContinue) {
            pausedForReview = false;
          } else {
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: suggestions,
            messageId: pendingAfterPause.messageId || latestSuggestions?.messageId || "",
          });
          const finalResult = `✅ **Review checkpoint reached.**${logsText}\n\n${buildSuggestedAgentsText(activeProjectId, suggestions)}`;
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
          const hasCompletedAgentLog = canBuildForPlan
            ? await client.hasLatestCompletedAgentLog(activeProjectId)
            : false;
          const canShowStartBuilding = canBuildForPlan && hasCompletedAgentLog && eventEndedWithStartBuildingMessage;
          const statusAfterReadiness = await client.getProjectStatus(activeProjectId).catch(() => null);
          const pendingAfterReadiness = extractPendingSuggestion(statusAfterReadiness?.pending_suggested_agents);
          const backendResumeSuggestions = pendingAfterReadiness.agents.filter((agent) =>
            agent === "continue" || agent === "review"
          );
          const hasBackendContinue = backendResumeSuggestions.includes("continue");
          log.info("agent_logs continue override decision", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            hasCompletedAgentLog,
            eventEndedWithStartBuildingMessage,
            backendResumeSuggestions,
            hasBackendContinue,
            hasTasks,
            hasArchitecture,
            canBuildForPlan,
            willShowStartBuilding: canShowStartBuilding,
            reason: canShowStartBuilding
              ? "tasks_architecture_completed_agent_log_and_events_review_message_ready"
              : !eventEndedWithStartBuildingMessage
                ? "waiting_for_events_review_start_building_message"
                : "waiting_for_completed_agent_log_before_start_building",
          });
          const suggestions = canShowStartBuilding
            ? ["start_building"]
            : canBuildForPlan && hasBackendContinue
              ? backendResumeSuggestions
              : [];
          log.info("suggestions final decision before write", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            suggestions,
            writeSuggestions: suggestions.length > 0,
            hasCompletedAgentLog,
            eventEndedWithStartBuildingMessage,
            backendResumeSuggestions,
            hasBackendContinue,
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
              ? "resume_completed_with_architecture_tasks_completed_agent_log_and_events_review_message"
              : canBuildForPlan
                ? eventEndedWithStartBuildingMessage
                  ? "waiting_for_completed_agent_log"
                  : "waiting_for_events_review_start_building_message"
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
                ? eventEndedWithStartBuildingMessage
                  ? `The design, tasks, and architecture are available, but 8080.ai still has an active agent log. I will show Continue only after 8080.ai exposes it.${suggestions.length > 0 ? `\n\n${buildSuggestedAgentsText(activeProjectId, suggestions)}` : ""}`
                  : `The design, tasks, and architecture are available. I will show Continue only after /events ends with "Review the design and architecture and start building" and 8080.ai exposes Continue.${suggestions.length > 0 ? `\n\n${buildSuggestedAgentsText(activeProjectId, suggestions)}` : ""}`
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
          const suggestions = pending.agents.filter((agent) => agent === "continue" || agent === "review");
          const hasBackendContinue = suggestions.includes("continue");
          log.info("continue_project backend suggestion gate", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            pendingSuggestions: suggestions,
            messageId: pending.messageId,
            hasBackendContinue,
            hasTasks,
            hasArchitecture,
            hasDesignPages,
            lastEventType: lastProjectEvent?.type,
            eventEndedWithStartBuildingMessage,
            reason: hasBackendContinue
              ? "backend_pending_suggested_agents_contains_continue"
              : "backend_has_not_exposed_continue_yet",
          });
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: suggestions,
            messageId: pending.messageId || latestSuggestions?.messageId || "",
          });
          const finalResult = hasBackendContinue
            ? `✅ **Checkpoint reached.**${logsText}\n\n${buildSuggestedAgentsText(activeProjectId, suggestions)}`
            : `⏳ **8080.ai is still working.**${logsText}\n\nContinue is not available yet on 8080.ai, so I am not showing it in OpenClaw yet.`;
          const presentation = hasBackendContinue
            ? buildSuggestedAgentsPresentation(activeProjectId, suggestions)
            : undefined;
          onUpdate?.({ content: [{ type: "text", text: finalResult }], details: null, presentation });
          return {
            content: [{ type: "text", text: finalResult }],
            details: {
              status: hasBackendContinue ? "checkpoint" : "running",
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
