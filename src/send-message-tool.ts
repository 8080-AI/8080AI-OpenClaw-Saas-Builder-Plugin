import { Type } from "@sinclair/typebox";
import { requireAuthenticatedClient, AuthError } from "./api-client.ts";
import {
  buildSuggestedAgentsPresentation,
  buildSuggestedAgentsJsonl,
  buildSuggestedAgentsText,
} from "./review-continue.ts";
import { groupAgents } from "./command.ts";
import { readActiveModel } from "./model-state.ts";

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
      const { apiBaseUrl, sessionId } = deps;

      // Detect "run plan all" or numeric selections — trigger agents directly
      const trimmedContent = params.content.trim().toLowerCase();
      const isRunPlanAll = /run\s+plan\s+all/i.test(trimmedContent);
      const numericSelection = trimmedContent.match(/^(?:select\s+)?(\d+)$/);

      if (isRunPlanAll || numericSelection) {
        try {
          const { readActiveProject } = await import("./project-state.ts");
          const { readLatestSuggestions, writeLatestSuggestions } = await import("./suggestions-state.ts");

          const activeProjectId = params.projectId || await readActiveProject(stateDir, sessionId);
          if (!activeProjectId) {
            return {
              content: [{ type: "text", text: "No active project found. Please start or select a project first." }],
              details: null,
            };
          }

          const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);

          const lastSuggestions = await readLatestSuggestions(stateDir, sessionId);

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
          } else {
            agents = lastSuggestions?.agents ?? ["plan_all"];
          }

          const messageId = lastSuggestions?.messageId ?? "";

          if (action === "review") {
            const reviewUrl = `${apiBaseUrl.replace("/api/v1", "")}/planning/${activeProjectId}/requirements`;
            return {
              content: [{ type: "text", text: `🔍 **Review Mode**\n\nOpen your project to review the generated requirements and design:\n\n🔗 [${reviewUrl}](${reviewUrl})` }],
              details: { projectId: activeProjectId, action: "review" },
            };
          }

          let accumulatedText = "";
          if (action === "build") {
            accumulatedText = `🚀 Triggering **Building Phase** for project \`${activeProjectId}\`...\n\n`;
            await stream(onUpdate, accumulatedText);
            const model = await readActiveModel(stateDir);
            await client.startBuilding(activeProjectId, model);
          } else if (action === "resume") {
            accumulatedText = `🚀 Triggering **Design Agent** to continue building project \`${activeProjectId}\`...\n\n`;
            await stream(onUpdate, accumulatedText);
            await client.resumeDesign(activeProjectId);
          } else {
            accumulatedText = `🚀 Triggering **${isRunPlanAll ? "Run Plan All" : agents.join(", ")}** on project \`${activeProjectId}\`...\n\n`;
            await stream(onUpdate, accumulatedText);
            await client.triggerAgents(activeProjectId, agents, messageId);
          }

          // Monitor logs live
          let hasCompletedAgent = false;
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
          });

          // Show suggestions at the end
          const statusAfter = await client.getProjectStatus(activeProjectId);
          let finalAgents: string[] = [];

          if (statusAfter.pending_suggested_agents) {
            finalAgents = Object.keys(statusAfter.pending_suggested_agents).filter(k => statusAfter.pending_suggested_agents![k] === true);
          }

          // Fallback to continue/review if no specific agents are suggested at this stage
          if (finalAgents.length === 0) {
            finalAgents = ["continue", "review"];
          }

          const groupedAgentsAfter = groupAgents(finalAgents);

          // Final Readiness Check: Architecture and Tasks
          let readinessText = "";
          try {
            const [arch, tasks] = await Promise.all([
              client.getArchitecture(activeProjectId).catch(() => null),
              client.getTasks(activeProjectId).catch(() => null),
            ]);

            if (arch && tasks) {
              const share = await client.createDesignShare(activeProjectId).catch(() => null);
              readinessText = `\n\n🎉 **Project Ready for Building!**\n`;
              if (share?.share_url) {
                readinessText += `🎨 **Design Preview:** [${share.share_url}](${share.share_url})\n`;
              }

              // Add "Start Building" to the agents if not already there
              if (!finalAgents.includes("start_building")) {
                finalAgents.push("start_building");
              }
            }
          } catch (err) {
            process.stderr.write(`[8080.ai] Readiness check error: ${err}\n`);
          }

          const finalGroupedAgents = groupAgents(finalAgents);
          accumulatedText += readinessText;
          accumulatedText += `\n\n${buildSuggestedAgentsText(activeProjectId, finalGroupedAgents)}`;

          accumulatedText += `\n\n> **Note:** Visit [8080.ai](https://8080.ai) for buying premium plan and complete your project end to end.`;

          // Update saved suggestions for the next selection
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId: activeProjectId,
            agents: finalGroupedAgents,
            messageId: "",
          });

          return {
            content: [{ type: "text", text: accumulatedText }],
            details: { projectId: activeProjectId, agents: finalGroupedAgents },
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
            console.error("[8080.ai] Media upload failed:", uploadErr);
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
          console.log(`[8080.ai tool] lastKnownMsgId: ${lastKnownMsgId}`);
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
              console.log(`[8080.ai tool] Raw SSE event: ${raw}`);
            }
          }
        );

        // Deduplicate agents
        suggestedAgents = Array.from(new Set([...suggestedAgents, ...(result.suggestedAgents || [])]));

        // Fallback: if response is empty, check for a NEW message in history.
        if (!responseText.trim()) {
          console.log("[8080.ai tool] Response empty, waiting 2s then checking history for NEW message...");
          await new Promise(r => setTimeout(r, 2000));
          try {
            const status = await client.getProjectStatus(activeProjectId);
            const messages = (status.messages || []) as { id?: string; author?: string; content?: string }[];
            const assistantMsgs = [...messages].reverse().filter(m => m.author === "assistant");
            const newMsg = assistantMsgs.find(m => m.id !== lastKnownMsgId);

            if (newMsg?.content) {
              responseText = newMsg.content;
              console.log(`[8080.ai tool] Found NEW fallback message: ${newMsg.id}`);
            }
          } catch (fallbackErr) {
            console.error("[8080.ai tool] Fallback failed:", fallbackErr);
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

        // Forced Fallback: If no agents suggested but it's a declarative response, force "plan_all"
        if (suggestedAgents.length === 0 && !isQuestion && cleanText) {
          suggestedAgents.push("plan_all");
        }

        const groupedAgents = groupAgents(suggestedAgents);
        const presentation = buildSuggestedAgentsPresentation(activeProjectId, groupedAgents, cleanText);
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
