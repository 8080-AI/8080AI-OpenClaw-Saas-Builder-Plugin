import { Type } from "@sinclair/typebox";
import { AuthRequiredError } from "./auth.ts";
import { AuthError, requireAuthenticatedClient } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { readLatestSuggestionsForProject, writeLatestSuggestions } from "./suggestions-state.ts";
import { log } from "../logger.ts";
import { readActiveModel } from "./model-state.ts";
import { canShowStartBuildingTasks, canUseStartBuilding, detectSubscriptionTier, formatStartBuildingTasks, getUpgradeToBuildText } from "./task-summary.ts";

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
      "Do not use for Start Building; Start Building must trigger the build action.",
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
        const latestSuggestions = await readLatestSuggestionsForProject(stateDir, sessionId, activeProjectId);
        const shouldStartBuilding =
          latestSuggestions?.agents.some((agent) => agent === "start_building" || agent === "start_build") === true &&
          !latestSuggestions.agents.includes("continue");

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
                (taskSummaryText ? `\n\n${taskSummaryText}` : ""),
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
        await client.streamProjectEvents(activeProjectId, {
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
          idleTimeoutMs: 600_000,
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
          const suggestions = ["continue", "review"];
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: suggestions,
            messageId: "",
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
          log.info("agent_logs continue override decision", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            hasCompletedAgentLog,
            hasTasks,
            hasArchitecture,
            canBuildForPlan,
            willOverrideToContinue: false,
            reason: "tasks_and_architecture_ready_agent_log_completed_is_not_ui_continue",
          });
          const suggestions = canBuildForPlan
            ? ["start_building"]
            : [];
          log.info("suggestions final decision before write", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            suggestions,
            writeSuggestions: canBuildForPlan,
            hasCompletedAgentLog,
            hasTasks,
            hasArchitecture,
            subscriptionTier,
            canBuildForPlan,
          });
          log.info("start_building shown", {
            projectId: activeProjectId,
            source: "continue_project_tool",
            shown: canBuildForPlan,
            reason: canBuildForPlan
              ? "resume_completed_with_architecture_and_tasks"
              : "plan_not_allowed",
          });
          if (canBuildForPlan) {
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: suggestions,
              messageId: "",
            });
          }
          const finalResult =
            `✅ **Generation complete!**${logsText}\n\n` +
            (canBuildForPlan
              ? `Review the design and architecture and start building.\n\n${buildSuggestedAgentsText(activeProjectId, suggestions)}`
              : getUpgradeToBuildText());
          onUpdate?.({ content: [{ type: "text", text: finalResult }] });
          return {
            content: [{ type: "text", text: finalResult }],
            details: {
              status: "complete",
              suggestions,
            },
            presentation: canBuildForPlan
              ? buildSuggestedAgentsPresentation(activeProjectId, suggestions)
              : undefined,
          };
        } else {
          const suggestions = ["continue"];
          const finalResult =
            `✅ **Agent execution finished, but no new designs were generated.**${logsText}\n\n` +
            buildSuggestedAgentsText(activeProjectId, suggestions);
          const presentation = buildSuggestedAgentsPresentation(activeProjectId, suggestions);
          onUpdate?.({ content: [{ type: "text", text: finalResult }], details: null, presentation });
          return {
            content: [{ type: "text", text: finalResult }],
            details: {
              status: "complete",
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
              messageId: "",
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
