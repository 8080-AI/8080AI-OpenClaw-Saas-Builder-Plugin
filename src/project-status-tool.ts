import { Type } from "@sinclair/typebox";
import { requireAuthenticatedClient, AuthError } from "./api-client.ts";
import { buildProjectStatusResponse } from "./project-status-response.ts";
import { exactToolResult } from "./exact-response.ts";
import { readActiveModel } from "./model-state.ts";

export function createProjectStatusTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  siteUrl?: string;
  sessionId?: string;
}) {
  return {
    name: "ai8080_get_project_status",
    description:
      "Get the current status of an 8080.ai project by its ID. " +
      "Fetches the latest Tech Lead reply from messages, current valid action buttons, and public links for ready artifacts. " +
      "Use when the user asks about the status, phase, or progress of a specific 8080.ai project.",
    parameters: Type.Object({
      projectId: Type.Optional(
        Type.String({
          description: "The 8080.ai project ID to check status for.",
        })
      ),
    }),

    async execute(
      _id: string,
      params: { projectId?: string },
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[] }) => void
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl, sessionId } = deps;

      try {
        const { readActiveProject } = await import("./project-state.ts");
        const projectId = params.projectId || (await readActiveProject(stateDir, sessionId));

        if (!projectId) {
          return {
            content: [
              {
                type: "text",
                text: "No active project found. Please provide a projectId or select a project first.",
              },
            ],
          };
        }

        onUpdate?.({ content: [{ type: "text", text: `🔄 Fetching status for project ${projectId}...` }] });

        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        const response = await buildProjectStatusResponse(client, {
          projectId, stateDir, sessionId: sessionId ?? "default", siteUrl: deps.siteUrl,
          modelTier: await readActiveModel(stateDir),
        });
        return exactToolResult(response.text, {
          projectId, messageId: response.messageId, suggestions: response.suggestions,
        }, response.presentation);
      } catch (err) {
        if (err instanceof AuthError) {
          return { content: [{ type: "text", text: (err as Error).message }] };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `8080.ai error: ${msg}` }],
        };
      }
    },
  };
}
