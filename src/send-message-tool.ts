import { Type } from "@sinclair/typebox";
import { requireAuthenticatedClient, AuthError, filterStartBuildingAgents } from "./api-client.ts";
import {
  buildSuggestedAgentsPresentation,
  buildSuggestedAgentsJsonl,
  buildSuggestedAgentsText,
} from "./review-continue.ts";
import { groupAgents, hasGeneratedData } from "./command.ts";
import { readActiveModel } from "./model-state.ts";
import { canShowStartBuildingTasks, canUseStartBuilding, detectSubscriptionTier, formatStartBuildingTasks, getUpgradeToBuildText } from "./task-summary.ts";
import { log } from "../logger.ts";

// AgentToolResult shape required by the OpenClaw SDK's onUpdate callback.
type ToolContent = { type: "text"; text: string };
type ToolResult<T = unknown> = { content: ToolContent[]; details: T; presentation?: any };
type OnUpdate = (partial: { content: ToolContent[]; details: any; presentation?: any }) => void;

// Emit a streaming update — each call replaces the previous partial content in
// OpenClaw's UI, so pass the full accumulated text every time.
// We use a small timeout to ensure the event loop yields and the UI can render.
async function stream(onUpdate: OnUpdate | undefined, text: string, presentation?: any): Promise<void> {
  onUpdate?.({ content: [{ type: "text", text }], details: null, presentation });
  await new Promise(r => setTimeout(r, 0));
}

export function createSendMessageTool(deps: {
  stateDir: () => string;
  siteUrl: string;
  apiBaseUrl: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_send_message",
    description:
      "Send a follow-up message to the 8080.ai AI agent for an existing project. " +
      "Use when the user wants to add new requirements, make changes, or ask questions about the project. " +
      "IMPORTANT: Pass the user's EXACT message. Do not expand or rewrite it. " +
      "The AI will return a response. You MUST output this response EXACTLY word-for-word to the user without summarizing.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String({
        description: "The 8080.ai project ID. If omitted, the tool will automatically use the currently active project for the session.",
      })),
      content: Type.String({
        description: "The EXACT message content provided by the user. Do not expand or rewrite.",
      }),
      MediaPaths: Type.Optional(Type.Array(Type.String(), {
        description: "Absolute paths to any media files (images, documents) attached by the user. Handled automatically by OpenClaw.",
      })),
    }),
    async execute(
      _id: string,
      params: { projectId?: string; content: string; MediaPaths?: string[] },
      _signal: AbortSignal | undefined,
      onUpdate: OnUpdate | undefined
    ): Promise<ToolResult> {
      const stateDir = deps.stateDir();
      const { siteUrl, apiBaseUrl, sessionId } = deps;
      log.info("send_message received", {
        projectId: params.projectId,
        content: params.content,
        mediaCount: params.MediaPaths?.length ?? 0,
      });
      // Detect button-style selections that should trigger actions directly.
      const trimmedContent = params.content.trim().toLowerCase();
      const isRunPlanAll = /run\s+plan\s+all/i.test(trimmedContent);
      const numericSelection = trimmedContent.match(/^(?:select\s+)?(\d+)$/);
      const isStartBuildingSelection = /^(?:start[\s_-]*building|start[\s_-]*build)$/i.test(trimmedContent);

      if (isRunPlanAll || numericSelection || isStartBuildingSelection) {
        try {
          const { readActiveProject } = await import("./project-state.ts");
          const { readLatestSuggestionsForProject, writeLatestSuggestions } = await import("./suggestions-state.ts");

          const activeProjectId = params.projectId || await readActiveProject(stateDir, sessionId);
          if (!activeProjectId) {
            return {
              content: [{ type: "text", text: "No active project found. Please start or select a project first." }],
              details: null,
            };
          }
          log.info("send_message using active project", { activeProjectId });
          const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);

          const lastSuggestions = await readLatestSuggestionsForProject(stateDir, sessionId, activeProjectId);

          let agents: string[] = ["plan_all"];
          let action: "trigger" | "resume" | "review" | "build" = "trigger";

          if (numericSelection) {
            const index = parseInt(numericSelection[1], 10) - 1;
            if (lastSuggestions && lastSuggestions.agents && lastSuggestions.agents[index]) {
              const selected = lastSuggestions.agents[index];
              if (selected === "continue") {
                action = "resume";
              } else if (selected === "review") {
                action = "review";
              } else if (selected === "start_building") {
                action = "build";
              } else {
                agents = selected.startsWith("GROUP:") ? selected.slice(6).split('|') : [selected];
              }
            } else if (!isRunPlanAll) {
              throw new Error("No suggested agents found for this selection.");
            }
          } else if (isStartBuildingSelection) {
            action = "build";
            agents = ["start_building"];
            log.info("start_building text selection matched", {
              projectId: activeProjectId,
              content: params.content,
              suggestions: lastSuggestions?.agents ?? [],
            });
          } else {
            agents = lastSuggestions?.agents ?? ["plan_all"];
          }
          log.info("send_message selection decision", { agents, action });
          const messageId = lastSuggestions?.messageId ?? "";

          if (action === "review") {
            const reviewUrl = `${siteUrl}/planning/${activeProjectId}/requirements`;
            return {
              content: [{ type: "text", text: `🔍 **Review Mode**\n\nOpen your project to review the generated requirements and design:\n\n🔗 [${reviewUrl}](${reviewUrl})` }],
              details: { projectId: activeProjectId, action: "review" },
            };
          }
          
          let accumulatedText = "";
          if (action === "build") {
            const [tasksForBuild, archForBuild] = await Promise.all([
              client.getTasks(activeProjectId).catch(() => null),
              client.getArchitecture(activeProjectId).catch(() => null),
            ]);
            const canStartBuilding = hasGeneratedData(tasksForBuild) && hasGeneratedData(archForBuild);
            log.info("start_building selected readiness decision", {
              projectId: activeProjectId,
              hasTasks: hasGeneratedData(tasksForBuild),
              hasArchitecture: hasGeneratedData(archForBuild),
              canStartBuilding,
            });
            if (!canStartBuilding) {
              return {
                content: [{ type: "text", text: "Start Building is not available yet. Architecture and tasks must be generated first." }],
                details: { projectId: activeProjectId, action: "build", blocked: true },
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
              subscriptionTier,
              canBuildForPlan,
              plansCount: plans.length,
            });
            if (!canBuildForPlan) {
              return {
                content: [{ type: "text", text: getUpgradeToBuildText(siteUrl) }],
                details: { projectId: activeProjectId, action: "build", blocked: true, subscriptionTier },
              };
            }
            let taskSummaryText = "";
            if (canShowStartBuildingTasks(subscriptionTier)) {
              taskSummaryText = formatStartBuildingTasks(tasksForBuild, activeProjectId, siteUrl);
              log.info("start_building task list", { projectId: activeProjectId, tier: subscriptionTier, tasks: tasksForBuild, taskSummaryText, shown: Boolean(taskSummaryText) });
            } else {
              log.info("start_building task list", { projectId: activeProjectId, tier: subscriptionTier, shown: false, reason: "plan_not_allowed" });
            }

            accumulatedText =
              `🚀 Triggering **Building Phase** for project \`${activeProjectId}\`...\n\n` +
              (taskSummaryText ? `${taskSummaryText}\n\n` : "");
            await stream(onUpdate, accumulatedText);
            const model = await readActiveModel(stateDir);
            log.info("start_building selected build api about to call", {
              projectId: activeProjectId,
              activeModel: model,
            });
            await client.startBuilding(activeProjectId, model);
            log.info("start_building selected build api completed", {
              projectId: activeProjectId,
              activeModel: model,
              taskSummaryShown: Boolean(taskSummaryText),
            });
            return {
              content: [{
                type: "text",
                text:
                  `✅ **Building Started!** Agents are now writing your software.` +
                  (taskSummaryText ? `\n\n${taskSummaryText}` : ""),
              }],
              details: { projectId: activeProjectId, action: "build", status: "started" },
            };
          } else if (action === "resume") {
            accumulatedText = `🚀 Triggering **Design Agent** to continue building project \`${activeProjectId}\`...\n\n`;
            await stream(onUpdate, accumulatedText);
            try {
              await client.resumeDesign(activeProjectId);
            } catch (err) {
              if (err instanceof AuthError) {
                const finalAgents = ["continue", "review"];
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: activeProjectId,
                  agents: finalAgents,
                  messageId: "",
                });
                const text =
                  `${err.message}\n\n` +
                  `Your project checkpoint is still saved. After logging in, choose Continue again to resume.`;
                return {
                  content: [{ type: "text", text }],
                  details: { projectId: activeProjectId, status: "auth_expired", agents: finalAgents },
                  presentation: buildSuggestedAgentsPresentation(activeProjectId, finalAgents),
                };
              }
              throw err;
            }
          } else {
            accumulatedText = `🚀 Triggering **${isRunPlanAll ? "Run Plan All" : agents.join(", ")}** on project \`${activeProjectId}\`...\n\n`;
            await stream(onUpdate, accumulatedText);
            log.info("send_message trigger_agents about to call", {
              projectId: activeProjectId,
              agents,
              messageId,
              isRunPlanAll,
            });
            await client.triggerAgents(activeProjectId, agents, messageId);
            log.info("send_message trigger_agents completed", {
              projectId: activeProjectId,
              agents,
              messageId,
              isRunPlanAll,
            });
          }

          // Monitor logs live
          let hasCompletedAgent = false;
          let pausedForReview = false;
          const eventIdleTimeoutMs = 600_000;
          log.info("send_message streamProjectEvents start", {
            projectId: activeProjectId,
            agents,
            action,
            idleTimeoutMs: eventIdleTimeoutMs,
          });
          await client.streamProjectEvents(activeProjectId, {
            onAgentLog: (log) => {
              if (log.action === "completed") {
                hasCompletedAgent = true;
                accumulatedText += `✅ [Agent] **${log.agent_type}** completed: ${log.summary}\n`;
              } else if (log.action === "started") {
                accumulatedText += `⏳ [Agent] **${log.agent_type}** started: ${log.summary}\n`;
              } else {
                accumulatedText += `ℹ️ [Agent] **${log.agent_type}**: ${log.summary}\n`;
              }
              void stream(onUpdate, accumulatedText);
            },
            onChatMessage: (msg) => {
              accumulatedText += `\n**System:** ${msg.content}\n`;
              void stream(onUpdate, accumulatedText);
            },
            onPlanningComplete: (data) => {
              if (data.status === "paused_for_review") {
                pausedForReview = true;
              }
            },
            idleTimeoutMs: eventIdleTimeoutMs,
          });
          log.info("send_message streamProjectEvents finished", {
            projectId: activeProjectId,
            agents,
            pausedForReview,
            hasCompletedAgent,
          });

          // Show suggestions at the end
          let finalAgents: string[] = [];

          if (pausedForReview) {
            finalAgents = ["continue", "review"];
          } else {
            const statusAfter = await client.getProjectStatus(activeProjectId);

            if (statusAfter.pending_suggested_agents) {
              finalAgents = Object.keys(statusAfter.pending_suggested_agents).filter(k => statusAfter.pending_suggested_agents![k] === true);
            }

            // Fallback to Continue only when the agent-log timeline says the
            // current agent run has completed. While an agent is still running,
            // avoid presenting stale Review/Continue choices.
            if (finalAgents.length === 0) {
              const hasCompletedLog = await client.hasLatestCompletedAgentLog(activeProjectId);
              if (hasCompletedLog) {
                finalAgents = ["continue"];
              }
            }
          }

          // Final Readiness Check: Architecture and Tasks
          let readinessText = "";
          let hasArchitectureAndTasks = false;
          let canBuildForPlan = false;
          try {
            const [arch, tasks] = await Promise.all([
              client.getArchitecture(activeProjectId).catch(() => null),
              client.getTasks(activeProjectId).catch(() => null),
            ]);

            const hasArchitecture = hasGeneratedData(arch);
            const hasTasks = hasGeneratedData(tasks);
            hasArchitectureAndTasks = hasArchitecture && hasTasks;
            log.info("start_building readiness decision", { projectId: activeProjectId, hasArchitecture, hasTasks, willShow: hasArchitectureAndTasks });

            if (hasArchitectureAndTasks) {
              const share = await client.createDesignShare(activeProjectId).catch(() => null);
              readinessText = `\n\n🎉 **Project Ready for Building!**\n`;
              if (share?.share_url) {
                readinessText += `🎨 **Design Preview:** [${share.share_url}](${share.share_url})\n`;
              }
              const [subscription, plans, profile] = await Promise.all([
                client.getSubscription().catch(() => null),
                client.getSubscriptionPlans().catch(() => []),
                client.getProfile().catch(() => null),
              ]);
              const subscriptionTier = detectSubscriptionTier(subscription, profile, plans);
              canBuildForPlan = canUseStartBuilding(subscriptionTier);
              log.info("start_building show plan decision", {
                projectId: activeProjectId,
                subscriptionTier,
                canBuildForPlan,
                plansCount: plans.length,
              });

              // Add "Start Building" to the agents if not already there
              if (canBuildForPlan) {
                const hasCompletedLog = await client.hasLatestCompletedAgentLog(activeProjectId);
                log.info("agent_logs continue override decision", {
                  projectId: activeProjectId,
                  source: "send_message_tool",
                  action,
                  hasCompletedLog,
                  hasArchitecture,
                  hasTasks,
                  canBuildForPlan,
                  willOverrideToContinue: false,
                  reason: "tasks_and_architecture_ready_agent_log_completed_is_not_ui_continue",
                });
                log.info("start_building added", {
                  projectId: activeProjectId,
                  reason: action === "resume" ? "resume_completed_with_architecture_and_tasks" : "architecture_and_tasks",
                });
                finalAgents = ["start_building"];
                log.info("suggestions final decision before write", {
                  projectId: activeProjectId,
                  source: "send_message_tool",
                  action,
                  suggestions: finalAgents,
                  hasCompletedAgentLog: hasCompletedLog,
                  hasArchitecture,
                  hasTasks,
                  canBuildForPlan,
                });
              }
              if (!canBuildForPlan) {
                readinessText += `\n${getUpgradeToBuildText(siteUrl)}`;
              }
            }
          } catch (err) {
            log.info("Readiness check error", err);
          }

          finalAgents = filterStartBuildingAgents(finalAgents, hasArchitectureAndTasks && canBuildForPlan);
          if (action === "resume" && finalAgents.length === 0 && !hasArchitectureAndTasks) {
            log.info("resume ended before generated checkpoint; preserving review actions", {
              projectId: activeProjectId,
              pausedForReview,
              hasCompletedAgent,
              hasArchitectureAndTasks,
            });
            finalAgents = ["continue", "review"];
          }
          const finalGroupedAgents = groupAgents(finalAgents);
          accumulatedText += readinessText;
          if (finalGroupedAgents.length > 0) {
            accumulatedText += `\n\n${buildSuggestedAgentsText(activeProjectId, finalGroupedAgents)}`;
          }
          const presentation = finalGroupedAgents.length > 0
            ? buildSuggestedAgentsPresentation(activeProjectId, finalGroupedAgents)
            : undefined;

          // Update saved suggestions for the next selection
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: finalGroupedAgents,
            messageId: "",
          });

          return {
            content: [{ type: "text", text: accumulatedText }],
            details: { projectId: activeProjectId, agents: finalGroupedAgents },
            presentation,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `8080.ai error triggering agents: ${msg}` }], details: null };
        }
      }
      try {
        const { readActiveProject } = await import("./project-state.ts");
        const activeProjectId = params.projectId || await readActiveProject(stateDir, sessionId);

        if (!activeProjectId) {
          return {
            content: [{ type: "text", text: "No active project found. Use `ai8080_list_projects` then `ai8080_select_project` to select a project first, or specify the projectId explicitly." }],
            details: null
          };
        }

        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        let responseText = "";

        // 1. Handle media uploads if present
        let mediaUrls: string[] = [];
        if (params.MediaPaths && params.MediaPaths.length > 0) {
          try {
            mediaUrls = await client.uploadMedia(params.MediaPaths, activeProjectId);
          } catch (uploadErr) {
            log.info("Media upload failed", uploadErr);
            // We'll continue without media if upload fails, or should we error?
            // For now, let's just log it and continue.
          }
        }

        const activeModel = await readActiveModel(stateDir);

        // Record the last known assistant message BEFORE we stream,
        // so the fallback can detect stale vs. new messages if needed.
        let lastKnownMsgId: string | undefined;
        try {
          const statusBefore = await client.getProjectStatus(activeProjectId);
          const msgs = (statusBefore.messages || []) as { id?: string; author?: string }[];
          const lastAssistant = [...msgs].reverse().find(m => m.author === "assistant");
          lastKnownMsgId = lastAssistant?.id;
          log.info("lastKnownMsgId", lastKnownMsgId);
        } catch { /* ignore */ }

        void stream(onUpdate, "⏳ **Connecting to 8080.ai...**");
        let suggestedAgents: string[] = [];
        let result = await client.streamSendMessage(
          activeProjectId,
          params.content,
          (token) => {
            if (!responseText) void stream(onUpdate, "🤖 **AI Response Starting...**");
            responseText += token;
            void stream(onUpdate, `🤖 **AI Response:**\n\n${responseText}`);
          },
          {
            model: activeModel,
            mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
            onSuggestedAgents: (agents, pid) => {
              suggestedAgents.push(...agents);
            },
            onRaw: (raw) => {
              log.info("Raw SSE event", raw);
            }
          }
        );

        // Deduplicate agents
        suggestedAgents = Array.from(new Set([...suggestedAgents, ...(result.suggestedAgents || [])]));
        const streamSuggestedAgents = [...suggestedAgents];
        log.info("send_message stream suggested agents", {
          projectId: activeProjectId,
          suggestedAgents: streamSuggestedAgents,
          hasPlanAll: streamSuggestedAgents.includes("plan_all"),
        });

        // Fallback: if response is empty, check for a NEW message in history.
        if (!responseText.trim()) {
          log.info("Response empty, waiting 2s then checking history for NEW message...");
          await new Promise(r => setTimeout(r, 2000));
          try {
            const status = await client.getProjectStatus(activeProjectId);
            const messages = (status.messages || []) as { id?: string; author?: string; content?: string }[];
            const assistantMsgs = [...messages].reverse().filter(m => m.author === "assistant");
            const newMsg = assistantMsgs.find(m => m.id !== lastKnownMsgId);

            if (newMsg?.content) {
              responseText = newMsg.content;
              log.info("Found NEW fallback message", { messageId: newMsg.id });
            }
          } catch (fallbackErr) {
            log.info("Fallback failed", fallbackErr);
          }
        }

        const cleanText = responseText.trim();
        const isQuestion = cleanText.endsWith("?");

        // ----------------------------------------------------------------
        // Fetch pending agents from project status if none found in stream
        // ----------------------------------------------------------------
        if (suggestedAgents.length === 0 && !isQuestion && cleanText) {
          try {
            const status = await client.getProjectStatus(activeProjectId);
            const pending = status.pending_suggested_agents;
            if (pending && typeof pending === 'object') {
              if (Array.isArray((pending as any).agents)) {
                suggestedAgents = (pending as any).agents.filter((a: unknown): a is string => typeof a === 'string');
              } else {
                for (const [key, val] of Object.entries(pending)) {
                  if (typeof val === 'string') suggestedAgents.push(val);
                  else if (val === true) suggestedAgents.push(key);
                }
              }
            }
          } catch { }
        }

        if (!streamSuggestedAgents.includes("plan_all")) {
          suggestedAgents = suggestedAgents.filter((agent) => agent !== "plan_all");
        }
        if (isQuestion) {
          suggestedAgents = [];
        }
        log.info("send_message suggestion display decision", {
          projectId: activeProjectId,
          isQuestion,
          streamSuggestedAgents,
          finalSuggestedAgents: suggestedAgents,
          showRunPlanAll: !isQuestion && streamSuggestedAgents.includes("plan_all") && suggestedAgents.includes("plan_all"),
        });

        if (suggestedAgents.length > 0) {
          suggestedAgents = filterStartBuildingAgents(suggestedAgents, false);
        }

        const groupedAgents = groupAgents(suggestedAgents);
        const presentation = groupedAgents.length > 0
          ? buildSuggestedAgentsPresentation(activeProjectId, groupedAgents, cleanText)
          : undefined;
        const agentText = groupedAgents.length > 0 ? buildSuggestedAgentsText(activeProjectId, groupedAgents, cleanText) : "";

        let finalResponse = cleanText;
        if (!isQuestion && groupedAgents.length > 0) {
          finalResponse += agentText;
        }

        // SAVE the suggestions so they can be picked up by a subsequent numeric selection (e.g. typing "1")
        if (groupedAgents.length > 0) {
          const { writeLatestSuggestions } = await import("./suggestions-state.ts");
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: groupedAgents,
            messageId: "",
          });
        }

        if (finalResponse) {
          onUpdate?.({
            content: [{ type: "text", text: `🤖 **AI Response:**\n\n${finalResponse}` }],
            details: {
              status: "complete",
              suggestions: groupedAgents,
              projectId: activeProjectId,
            },
          });
        }

        return {
          content: [{ type: "text", text: `🤖 **AI Response:**\n\n${finalResponse}` }],
          details: {
            status: "complete",
            suggestions: groupedAgents,
            projectId: activeProjectId,
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
