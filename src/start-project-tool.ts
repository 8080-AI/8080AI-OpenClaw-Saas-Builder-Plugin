import { Type } from "@sinclair/typebox";
import { requireAuthenticatedClient, AuthError, filterStartBuildingAgents } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { readActiveModel } from "./model-state.ts";
import { stripA2UI, groupAgents } from "./command.ts";
import { writeActiveProject } from "./project-state.ts";
import { writeLatestSuggestions } from "./suggestions-state.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { exactToolResult } from "./exact-response.ts";
import { log } from "../logger.ts";

// AgentToolResult shape required by the OpenClaw SDK's onUpdate callback.
type ToolContent = { type: "text"; text: string };
type ToolResult<T = unknown> = { content: ToolContent[]; details: T; presentation?: any };
type OnUpdate = (partial: { content: ToolContent[]; details: any; presentation?: any }) => void;
type StatusMessage = { id?: string; author?: string; content?: string };

// Emit a streaming update — each call replaces the previous partial content in
// OpenClaw's UI, so pass the full accumulated text every time.
// We use a small timeout to ensure the event loop yields and the UI can render.
export async function stream(onUpdate: OnUpdate | undefined, text: string, presentation?: any): Promise<void> {
  onUpdate?.({ content: [{ type: "text", text }], details: null, presentation });
  await new Promise(r => setTimeout(r, 0));
}

function latestAssistantContent(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const assistant = [...(messages as StatusMessage[])]
    .reverse()
    .find((message) => message.author === "assistant" && typeof message.content === "string" && message.content.trim());
  return assistant?.content?.trim() ?? "";
}

export function createStartProjectTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  pollingTimeoutMs: number;
  sessionId: string;
}) {
  return {
    name: "ai8080_start_project",
    description:
      "The primary tool for building software projects using 8080.ai. " +
      "Use this whenever the user wants to create, build, or scaffold a new application. " +
      "It connects to the 8080.ai platform which handles architecture, coding, and deployment. " +
      "Shows live agent activity from the platform as it works. " +
      "For long-running 8080.ai actions, always pass timeoutMs=600000 so OpenClaw allows the tool call to wait for agent completion.",
    parameters: Type.Object({
      user_raw_prompt: Type.String({
        description:
          "The EXACT, raw, unedited prompt provided by the user. " +
          "WARNING: Do NOT write a requirements document. Do NOT expand the prompt. Do NOT add bullet points. " +
          "If the user says 'build a snake game', you MUST pass EXACTLY 'build a snake game'.",
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
      params: { user_raw_prompt: string; MediaPaths?: string[]; timeoutMs?: number },
      _signal: AbortSignal | undefined,
      onUpdate: OnUpdate | undefined
    ): Promise<ToolResult> {
      const stateDir = deps.stateDir();
      const { apiBaseUrl, pollingTimeoutMs, sessionId } = deps;
     
      const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
      log.info("start_project execute entered", {
        prompt: params.user_raw_prompt,
        mediaCount: params.MediaPaths?.length ?? 0,
      });
        // --- Create project + stream the Tech Lead's initial reply token by token ---
      let projectId: string;
      let accumulatedText = "";
      let suggestedAgents: string[] = [];
      let suggestionMessageId = "";

      try {
        const activeModel = await readActiveModel(stateDir);

        // 1. Handle media uploads if present
        let mediaUrls: string[] = [];
        if (params.MediaPaths && params.MediaPaths.length > 0) {
          log.info("Uploading media files", params.MediaPaths);
          try {
            // Use 'temp' since project ID isn't known yet
            mediaUrls = await client.uploadMedia(params.MediaPaths, "temp");
          } catch (uploadErr) {
            log.info("Media upload failed", uploadErr);
          }
        }

        const result = await client.streamProjectCreation(
          params.user_raw_prompt,
          (token) => {
            // Called once per SSE token — accumulate and push the full text so
            // OpenClaw replaces the previous partial with the longer one each time,
            // producing a word-by-word streaming effect identical to LLM output.
            accumulatedText += token;
            void stream(onUpdate, accumulatedText);
          },
          (raw) => {
            try {
              const event = JSON.parse(raw);
              if (event.type === "token") return;
              log.info("start_project SSE event", event);
            } catch {
              log.info("start_project raw SSE event", raw);
            }
          },
          (agents, _pid, messageId) => {
            log.info("Received agent suggestions from stream", { agents, messageId });
            // Collect suggestions and show them after the strict Start Building
            // gate has checked the project events stream.
            suggestedAgents.push(...agents);
            if (messageId) suggestionMessageId = messageId;
          },
          {
            model: activeModel,
            mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined
          }
        );
        projectId = result.projectId;
        log.info("Project created", { projectId });
        log.info("Project created-------", { projectId });
        // Store project_id in session state
        await writeActiveProject(stateDir, projectId, sessionId);

        if (!accumulatedText.trim()) {
          const timeoutMs = Math.min(pollingTimeoutMs, 45_000);
          const deadline = Date.now() + timeoutMs;
          log.info("start_project stream empty; polling for assistant response", { projectId, timeoutMs });
          while (!accumulatedText.trim() && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 1500));
            try {
              const status = await client.getProjectStatus(projectId);
              const assistantText = latestAssistantContent(status.messages);
              if (assistantText) {
                accumulatedText = assistantText;
                log.info("start_project fetched assistant response from project detail", {
                  projectId,
                  textLength: assistantText.length,
                });
                await stream(onUpdate, accumulatedText);
                break;
              }
            } catch (pollErr) {
              log.info("start_project assistant response poll failed", pollErr);
            }
          }
        }

        // ----------------------------------------------------------------
        // The 8080.ai backend does NOT send suggested_agents in the SSE
        // stream. Instead, they're available via the project status
        // endpoint's `pending_suggested_agents` field after stream ends.
        // ----------------------------------------------------------------
        if ((suggestedAgents.length === 0 || !suggestionMessageId) && projectId) {
          try {
            const status = await client.getProjectStatus(projectId);
            const pending = extractPendingSuggestion(status.pending_suggested_agents);
            if (suggestedAgents.length === 0) suggestedAgents.push(...pending.agents);
            if (pending.messageId) suggestionMessageId = pending.messageId;
            log.info("Fetched pending agents from status", suggestedAgents);
          } catch (statusErr) {
            log.info("Failed to fetch project status for agents", statusErr);
          }
        }

        if (suggestedAgents.length > 0) {
          log.info("start_building suggestions decision", { projectId, pending: suggestedAgents, allowStartBuilding: false });
          suggestedAgents = filterStartBuildingAgents(suggestedAgents, false);
        }

        const groupedAgents = groupAgents(suggestedAgents);
        if (suggestedAgents.length > 0) {
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId,
            agents: groupedAgents,
            messageId: suggestionMessageId,
          });
        }

        const cleanText = stripA2UI(accumulatedText);
        const isQuestion = cleanText.trim().endsWith("?");

        let finalResponse = cleanText;
        if (!isQuestion && suggestedAgents.length > 0) {
          finalResponse += `\n\n▶️ Type **"Start"** to proceed.`;
        }
        if (!finalResponse.trim()) {
          finalResponse =
            `Project \`${projectId}\` was created, but 8080.ai did not return an assistant response from /stream-trigger yet. ` +
            `Open or refresh the project on 8080.ai to check whether the Tech Lead response is still pending.`;
        }
        log.info("Final response ready", { isQuestion, suggestedAgents });
        void stream(onUpdate, `🤖 **AI Response:**\n\n${finalResponse}`);
        log.info("Initial response streamed.");
        return exactToolResult(finalResponse, { projectId, phase: "started" }) as ToolResult;
      } catch (err) {
        if (err instanceof AuthError) {
          return { content: [{ type: "text", text: (err as Error).message }], details: null };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to create project: ${msg}` }], details: null };
      }
    },
  };
}
