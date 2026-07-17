import { Type } from "@sinclair/typebox";
import { requireAuthenticatedClient, AuthError, filterStartBuildingAgents, isPauseForReviewText, isReviewArchitectureStartBuildingChatMessage, checkGenerateFirstPageCondition, determineContinueButtonLabel } from "./api-client.ts";
import {
  buildRequirementsUrl,
  buildSuggestedAgentsPresentation,
  buildSuggestedAgentsJsonl,
  buildSuggestedAgentsText,
} from "./review-continue.ts";
import { groupAgents, hasGeneratedData } from "./command.ts";
import { readActiveModel } from "./model-state.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { canShowStartBuildingTasks, canUseStartBuilding, detectSubscriptionTier, formatStartBuildingTasks, getUpgradeToBuildText } from "./task-summary.ts";
import { getDesignPreviewText } from "./design-preview.ts";
import { silentToolResult } from "./exact-response.ts";
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
      "The AI will return a response. You MUST output this response EXACTLY word-for-word to the user without summarizing. " +
      "For Run Plan All or Continue selections, if the tool returns no visible content, do not summarize, announce, or confirm the action; remain silent until visible Continue/Review actions are returned. " +
      "For long-running 8080.ai actions, always pass timeoutMs=600000 so OpenClaw allows the tool call to wait for agent completion.",
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
      timeoutMs: Type.Number({
        default: 600000,
        minimum: 1,
        maximum: 600000,
        description: "Required OpenClaw dynamic-tool timeout override in milliseconds. Always use 600000 for 8080.ai long-running actions.",
      }),
    }),
    async execute(
      _id: string,
      params: { projectId?: string; content: string; MediaPaths?: string[]; timeoutMs?: number },
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
          let messageId = lastSuggestions?.messageId ?? "";
          if (action === "trigger" && !messageId) {
            try {
              const status = await client.getProjectStatus(activeProjectId);
              const pending = extractPendingSuggestion(status.pending_suggested_agents);
              messageId = pending.messageId;
              log.info("send_message selection hydrated message id", {
                projectId: activeProjectId,
                agents,
                messageId,
                pendingAgents: pending.agents,
              });
            } catch (err) {
              log.info("send_message failed to hydrate message id", err);
            }
          }
          log.info("send_message selection decision", { agents, action, messageId });

          if (action === "review") {
            const status = await client.getProjectStatus(activeProjectId).catch(() => null);
            const pending = extractPendingSuggestion(status?.pending_suggested_agents);
            const reviewUrl = status?.requirementDocUrl || buildRequirementsUrl(siteUrl, activeProjectId, pending.sessionId);
            log.info("send_message review url", {
              projectId: activeProjectId,
              reviewUrl,
              sessionId: pending.sessionId,
            });
            return {
              content: [{ type: "text", text: reviewUrl }],
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
            const designPreviewText = await getDesignPreviewText(client, activeProjectId, siteUrl);
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
                  (taskSummaryText ? `\n\n${taskSummaryText}` : "") +
                  designPreviewText,
              }],
              details: { projectId: activeProjectId, action: "build", status: "started" },
            };
          } else if (action === "resume") {
            try {
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId: activeProjectId,
                agents: [],
                messageId,
              });
              log.info("send_message consuming continue suggestion", {
                projectId: activeProjectId,
                messageId,
              });
              await client.resumeDesign(activeProjectId);
            } catch (err) {
              if (err instanceof AuthError) {
                const finalAgents = ["continue", "review"];
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: activeProjectId,
                  agents: finalAgents,
                  messageId,
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
            log.info("send_message trigger_agents about to call", {
              projectId: activeProjectId,
              agents,
              messageId,
              isRunPlanAll,
            });
            try {
              await client.triggerAgents(activeProjectId, agents, messageId);
            } catch (err) {
              const logs = await client.getAgentLogs(activeProjectId).catch(() => []);
              const hasPlanningActivity = logs.some((entry) => isPlanningActivityLog(entry));
              log.info("send_message trigger_agents failed; checking whether agents are already running", {
                projectId: activeProjectId,
                agents,
                messageId,
                isRunPlanAll,
                error: err instanceof Error ? err.message : String(err),
                hasPlanningActivity,
              });
              if (!hasPlanningActivity) throw err;
            }
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
          let lastProjectEvent: Record<string, unknown> | null = null;
          const eventIdleTimeoutMs = 120_000;
          const eventProgressTimeoutMs = 300_000;
          const eventMaxTimeoutMs = 480_000;
          log.info("send_message streamProjectEvents start", {
            projectId: activeProjectId,
            agents,
            action,
            idleTimeoutMs: eventIdleTimeoutMs,
            progressTimeoutMs: eventProgressTimeoutMs,
            maxTimeoutMs: eventMaxTimeoutMs,
          });
          try {
            await client.streamProjectEvents(activeProjectId, {
              onRaw: (raw) => {
                try {
                  lastProjectEvent = JSON.parse(raw) as Record<string, unknown>;
                } catch { }
              },
              onAgentLog: (log) => {
                if (log.action === "completed") {
                  hasCompletedAgent = true;
                }
                log.info("send_message event agent_log", {
                  projectId: activeProjectId,
                  action: log.action,
                  agentType: log.agent_type,
                  summary: log.summary,
                });
              },
              onChatMessage: (msg) => {
                log.info("send_message event chat_message", {
                  projectId: activeProjectId,
                  isPauseForReview: isPauseForReviewText(msg.content),
                });
              },
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
            log.info("send_message event stream failed; continuing with project polling", {
              projectId: activeProjectId,
              agents,
              action,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          log.info("send_message streamProjectEvents finished", {
            projectId: activeProjectId,
            agents,
            pausedForReview,
            hasCompletedAgent,
          });
          const eventEndedWithStartBuildingMessage = isReviewArchitectureStartBuildingChatMessage(lastProjectEvent);
          log.info("send_message /events final event decision", {
            projectId: activeProjectId,
            action,
            lastEventType: lastProjectEvent?.type,
            lastEventContent: typeof lastProjectEvent?.content === "string"
              ? lastProjectEvent.content.slice(0, 240)
              : undefined,
            eventEndedWithStartBuildingMessage,
          });

          // Show suggestions at the end
          let finalAgents: string[] = [];
          let finalMessageId = messageId;
          let pendingButtons: any[] | undefined = undefined;

          if (pausedForReview) {
            const statusAfter = await client.getProjectStatus(activeProjectId);
            const pending = extractPendingSuggestion(statusAfter.pending_suggested_agents);
            pendingButtons = pending.buttons;
            const backendResumeSuggestions = pending.agents.filter((agent) => agent === "continue" || agent === "review");
            const hasBackendContinue = backendResumeSuggestions.includes("continue");
            const hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(activeProjectId);
            if (pending.messageId) finalMessageId = pending.messageId;
            log.info("send_message paused_for_review backend suggestion gate", {
              projectId: activeProjectId,
              action,
              pendingAgents: pending.agents,
              backendResumeSuggestions,
              hasBackendContinue,
              hasLatestCompletedAgentLog,
            });
            finalAgents = hasLatestCompletedAgentLog
              ? (hasBackendContinue ? backendResumeSuggestions : ["continue", "review"])
              : [];
          } else {
            const statusAfter = await client.getProjectStatus(activeProjectId);

            const pending = extractPendingSuggestion(statusAfter.pending_suggested_agents);
            pendingButtons = pending.buttons;
            finalAgents = pending.agents;
            if (pending.messageId) finalMessageId = pending.messageId;

            log.info("send_message backend suggested agents after events", {
              projectId: activeProjectId,
              action,
              pendingAgents: finalAgents,
              messageId: finalMessageId,
              reason: finalAgents.includes("continue")
                ? "backend_exposed_continue"
                : "backend_has_not_exposed_continue",
            });
          }

          // Final Readiness Check: Architecture and Tasks
          let readinessText = "";
          let hasArchitectureAndTasks = false;
          let canBuildForPlan = false;
          try {
            const [arch, tasks, hasReviewBuildSystemMessage] = await Promise.all([
              client.getArchitecture(activeProjectId).catch(() => null),
              client.getTasks(activeProjectId).catch(() => null),
              client.hasReviewBuildSystemMessage(activeProjectId).catch(() => false),
            ]);

            const hasArchitecture = hasGeneratedData(arch);
            const hasTasks = hasGeneratedData(tasks);
            const hasReviewBuildPhase = eventEndedWithStartBuildingMessage || hasReviewBuildSystemMessage;
            hasArchitectureAndTasks = hasArchitecture && hasTasks;
            log.info("start_building readiness decision", {
              projectId: activeProjectId,
              hasArchitecture,
              hasTasks,
              hasReviewBuildSystemMessage,
              hasReviewBuildPhase,
              willShow: hasArchitectureAndTasks && hasReviewBuildPhase,
            });

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
                const canShowStartBuilding = hasReviewBuildPhase;
                const backendResumeSuggestions = finalAgents.filter((agent) => agent === "continue" || agent === "review");
                const hasBackendContinue = backendResumeSuggestions.includes("continue");
                log.info("agent_logs continue override decision", {
                  projectId: activeProjectId,
                  source: "send_message_tool",
                  action,
                  eventEndedWithStartBuildingMessage,
                  hasReviewBuildSystemMessage,
                  hasReviewBuildPhase,
                  backendResumeSuggestions,
                  hasBackendContinue,
                  hasArchitecture,
                  hasTasks,
                  canBuildForPlan,
                  willShowStartBuilding: canShowStartBuilding,
                  reason: canShowStartBuilding
                    ? "paid_plan_tasks_architecture_and_review_build_signal_ready"
                    : !hasReviewBuildPhase
                      ? "waiting_for_review_build_phase_signal"
                      : "plan_not_allowed",
                });
                if (canShowStartBuilding) {
                  log.info("start_building added", {
                    projectId: activeProjectId,
                    reason: action === "resume"
                      ? "resume_completed_with_architecture_tasks_and_review_build_signal"
                      : "architecture_tasks_and_review_build_signal",
                  });
                  finalAgents = ["start_building"];
                } else {
                  readinessText += hasReviewBuildPhase
                    ? `\n8080.ai is still finishing the latest agent step. I will show Continue only after 8080.ai exposes it.`
                    : `\n8080.ai has not emitted the final review/start-building signal yet. I will show Continue only after 8080.ai exposes it.`;
                  finalAgents = hasBackendContinue ? backendResumeSuggestions : [];
                }
                log.info("suggestions final decision before write", {
                  projectId: activeProjectId,
                  source: "send_message_tool",
                  action,
                  suggestions: finalAgents,
                  eventEndedWithStartBuildingMessage,
                  hasReviewBuildSystemMessage,
                  hasReviewBuildPhase,
                  backendResumeSuggestions,
                  hasBackendContinue,
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
            log.info("resume ended before generated checkpoint; no review actions exposed yet", {
              projectId: activeProjectId,
              pausedForReview,
              hasCompletedAgent,
              hasArchitectureAndTasks,
            });
          }
          const finalGroupedAgents = groupAgents(finalAgents);
          if (finalGroupedAgents.length === 0) {
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: activeProjectId,
              agents: [],
              messageId: finalMessageId,
            });
            return silentToolResult({
              status: "waiting_for_next_actions",
              action,
              projectId: activeProjectId,
            }) as ToolResult;
          }
          accumulatedText += readinessText;
          const continueButtonLabel = finalGroupedAgents.includes("continue") ? await determineContinueButtonLabel(client, activeProjectId) : undefined;
          accumulatedText += `\n\n${buildSuggestedAgentsText(activeProjectId, finalGroupedAgents, "", continueButtonLabel, pendingButtons)}`;
          const presentation = buildSuggestedAgentsPresentation(activeProjectId, finalGroupedAgents, "", continueButtonLabel, pendingButtons);

          // Update saved suggestions for the next selection
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: finalGroupedAgents,
            messageId: finalMessageId,
            buttons: pendingButtons,
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
        let suggestionMessageId = "";
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
            onSuggestedAgents: (agents, pid, messageId) => {
              suggestedAgents.push(...agents);
              if (messageId) suggestionMessageId = messageId;
            },
            onRaw: undefined
          }
        );

        // Deduplicate agents
        suggestedAgents = Array.from(new Set([...suggestedAgents, ...(result.suggestedAgents || [])]));
        if (result.messageId) suggestionMessageId = result.messageId;
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
        let finalPendingButtons: any[] | undefined = undefined;
        if ((suggestedAgents.length === 0 || !suggestionMessageId) && !isQuestion && cleanText) {
          try {
            const status = await client.getProjectStatus(activeProjectId);
            const pending = extractPendingSuggestion(status.pending_suggested_agents);
            if (suggestedAgents.length === 0) suggestedAgents = pending.agents;
            if (pending.messageId) suggestionMessageId = pending.messageId;
            finalPendingButtons = pending.buttons;
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
        const continueButtonLabel = groupedAgents.includes("continue") ? await determineContinueButtonLabel(client, activeProjectId) : undefined;
        const presentation = groupedAgents.length > 0
          ? buildSuggestedAgentsPresentation(activeProjectId, groupedAgents, cleanText, continueButtonLabel, finalPendingButtons)
          : undefined;
        const agentText = groupedAgents.length > 0 ? buildSuggestedAgentsText(activeProjectId, groupedAgents, cleanText, continueButtonLabel, finalPendingButtons) : "";

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
            messageId: suggestionMessageId,
            buttons: finalPendingButtons,
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
        if (!finalResponse.trim()) {
          return silentToolResult({
            status: "empty_response",
            projectId: activeProjectId,
          }) as ToolResult;
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
