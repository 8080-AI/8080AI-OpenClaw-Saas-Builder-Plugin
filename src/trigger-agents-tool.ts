import { Type } from "@sinclair/typebox";
import { AuthError, AGENT_DISPLAY_NAMES, requireAuthenticatedClient, filterStartBuildingAgents, isPauseForReviewText, type ProjectStatus } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { groupAgents, hasGeneratedData } from "./command.ts";
import { readActiveModel } from "./model-state.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { writeLatestSuggestions } from "./suggestions-state.ts";
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

  while (!(statusHasReviewCheckpoint(latestStatus) && statusHasBackendContinue(latestStatus)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    latestStatus = await client.getProjectStatus(projectId);
  }

  return latestStatus;
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
      "If the user sends a raw button payload like '8080_trigger_agents_<projectId>_<agentsJsonArray>', you MUST use this tool. Extract the projectId and parse the JSON array of agents to pass as arguments. This starts the suggested agents working on the project.",
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
        
        let displayNames: string[] = [];
        if (params.agents.includes('plan_all')) {
          displayNames = ["System Requirements Agent", "User Flow Planner", "Tech Lead Agent"];
        } else {
          displayNames = params.agents.map(a => AGENT_DISPLAY_NAMES[a] ?? a);
        }
        
        let accumulatedText = `✅ **Triggered agents:** ${displayNames.join(", ")}\n\n`;
        
        for (const name of displayNames) {
          accumulatedText += `⏳ [Agent] **${name}** is running...\n`;
        }
        accumulatedText += `\n`;
        
        onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null });

        // Stream events live to the dashboard until the planning checkpoint or idle timeout.
        let pausedForReview = false;
        let hasCompletedAgent = false;
        await client.streamProjectEvents(params.projectId, {
          onAgentLog: (log) => {
            if (log.action === "completed") {
              hasCompletedAgent = true;
              accumulatedText += `✅ [Agent] **${log.agent_type}** completed: ${log.summary}\n`;
            } else if (log.action === "started") {
              accumulatedText += `⏳ [Agent] **${log.agent_type}** started: ${log.summary}\n`;
            } else {
              accumulatedText += `ℹ️ [Agent] **${log.agent_type}**: ${log.summary}\n`;
            }
            
            onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null });
          },
          onChatMessage: (msg) => {
            accumulatedText += `\n\n**System:** ${msg.content}`;
            onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null });
          },
          onSrdChunk: (chunk) => {
            if (chunk.seq === 1) accumulatedText += `\n\n---\n\n`;
            accumulatedText += chunk.content;
            onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null });
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

        const projectStatusAfter = await waitForReviewCheckpoint(client, params.projectId, {
          timeoutMs: params.agents.includes("plan_all") ? 15_000 : 10_000,
          intervalMs: 5_000,
        });
        const hasReviewCheckpoint = statusHasReviewCheckpoint(projectStatusAfter);
        const backendHasContinue = statusHasBackendContinue(projectStatusAfter);
        const backendReviewReady = hasReviewCheckpoint && backendHasContinue;
        if (backendReviewReady) {
          log.info("trigger_agents detected review checkpoint from project status", {
            projectId: params.projectId,
            agents: params.agents,
            backendHasContinue,
          });
        } else {
          log.info("trigger_agents review checkpoint not ready in backend suggestions", {
            projectId: params.projectId,
            agents: params.agents,
            hasReviewText: hasReviewCheckpoint,
            backendHasContinue,
            pendingSuggestions: extractPendingSuggestion(projectStatusAfter.pending_suggested_agents).agents,
          });
        }

        if (pausedForReview && !backendReviewReady) {
          accumulatedText +=
            `\n\nPlanning reached the review checkpoint, but 8080.ai has not exposed the **Continue** action yet. ` +
            `I will wait to show Continue until the backend publishes it.`;
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: params.projectId,
            agents: [],
            messageId,
          });
          return {
            content: [{ type: "text", text: accumulatedText }],
            details: {
              status: "waiting_for_backend_continue",
              suggestions: [],
            },
          };
        }

        if (backendReviewReady) {
          const reviewAgents = groupAgents(["continue", "review"]);
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: params.projectId,
            agents: reviewAgents,
            messageId,
          });
          accumulatedText += `\n\n**Planning complete — ready for your review.**\n\n`;
          accumulatedText += `**What would you like to do next?**\n`;
          accumulatedText += `1. ▶️ Continue — proceed to building\n`;
          accumulatedText += `2. 🔍 Review — inspect the generated requirements & design\n`;

          const presentation = buildSuggestedAgentsPresentation(params.projectId, reviewAgents);
          onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null, presentation });

          return {
            content: [{ type: "text", text: accumulatedText }],
            details: {
              status: "paused_for_review",
              suggestions: reviewAgents,
            },
            presentation,
          };
        }

        // Fetch fresh suggestions from the project detail
        const pendingAfter = extractPendingSuggestion(projectStatusAfter.pending_suggested_agents);
        let finalAgentsAfter: string[] = pendingAfter.agents;
        if (pendingAfter.messageId) messageId = pendingAfter.messageId;
        if (params.agents.includes("plan_all") && finalAgentsAfter.includes("plan_all")) {
          finalAgentsAfter = finalAgentsAfter.filter((agent) => agent !== "plan_all");
        }

        log.info("trigger_agents backend suggested agents after events", {
          projectId: params.projectId,
          pendingAgents: finalAgentsAfter,
          messageId,
          reason: finalAgentsAfter.includes("continue")
            ? "backend_exposed_continue"
            : "backend_has_not_exposed_continue",
        });

        if (finalAgentsAfter.length > 0) {
          log.info("start_building suggestions decision", {
            projectId: params.projectId,
            pending: finalAgentsAfter,
            allowStartBuilding: false,
          });
          finalAgentsAfter = filterStartBuildingAgents(finalAgentsAfter, false);
        }

        if (finalAgentsAfter.length > 0) {
          const groupedAgentsAfter = groupAgents(finalAgentsAfter);
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: params.projectId,
            agents: groupedAgentsAfter,
            messageId,
          });
          const suggestionsText = buildSuggestedAgentsText(params.projectId, groupedAgentsAfter);
          const presentation = buildSuggestedAgentsPresentation(params.projectId, groupedAgentsAfter);
          accumulatedText += suggestionsText;

          return {
            content: [
              {
                type: "text",
                text: accumulatedText,
              },
            ],
            details: {
              status: "complete",
              suggestions: groupedAgentsAfter
            },
            presentation,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: accumulatedText,
            },
          ],
          details: {
            status: "complete",
            suggestions: []
          }
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
