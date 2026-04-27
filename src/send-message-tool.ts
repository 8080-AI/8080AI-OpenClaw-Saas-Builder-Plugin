import { Type } from "@sinclair/typebox";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient } from "./api-client.ts";
import { buildSuggestedAgentsJsonl } from "./review-continue.ts";

export function createSendMessageTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
}) {
  return {
    name: "ai8080_send_message",
    description:
      "Send a follow-up message to the 8080.ai AI agent for an existing project. " +
      "Use when the user wants to add new requirements, make changes, or ask questions about the project. " +
      "The AI will stream a response back with guidance or updates.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "The 8080.ai project ID to send the message to.",
      }),
      content: Type.String({
        description: "The message content to send to the AI agent.",
      }),
    }),

    async execute(
      _id: string,
      params: { projectId: string; content: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl } = deps;

      let token: string;
      try {
        token = await requireToken(stateDir);
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { content: [{ type: "text", text: err.message }] };
        }
        throw err;
      }

      try {
        const client = createApiClient({ token, apiBaseUrl });
        let responseText = "";

        const result = await client.streamSendMessage(
          params.projectId,
          params.content,
          (token) => {
            responseText += token;
          }
        );

        // If suggested agents were detected, show a button
        if (result.suggestedAgents && result.suggestedAgents.length > 0) {
          const a2ui = buildSuggestedAgentsJsonl(params.projectId, result.suggestedAgents);
          return {
            content: [
              {
                type: "text",
                text: `🤖 **AI Response:**\n\n${responseText}\n\n<!-- a2ui\n${a2ui}\n-->`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `🤖 **AI Response:**\n\n${responseText}`,
            },
          ],
        };
      } catch (err) {
        if (err instanceof AuthError) {
          return { content: [{ type: "text", text: (err as Error).message }] };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `8080.ai error: ${msg}` }] };
      }
    },
  };
}
