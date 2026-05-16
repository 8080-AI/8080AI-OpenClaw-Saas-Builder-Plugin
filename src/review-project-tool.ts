import { Type } from "@sinclair/typebox";
import open from "open";
import { AuthRequiredError } from "./auth.ts";
import { AuthError, requireAuthenticatedClient } from "./api-client.ts";

export function createReviewProjectTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_open_project_requirements",
    description:
      "Open the requirement document for an 8080.ai project in the user's web browser. " +
      "Use when the user wants to view, review, or see the requirements/spec doc for a " +
      "specific 8080.ai project. Requires the project ID.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String({
        description: "The 8080.ai project ID whose requirement document should be opened. Optional if a project is already active.",
      })),
    }),

    async execute(
      _id: string,
      params: { projectId?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl, sessionId } = deps;

      try {
        const { readActiveProject } = await import("./project-state.ts");
        const activeProjectId = params.projectId || await readActiveProject(stateDir, sessionId);
        
        if (!activeProjectId) {
          return {
            content: [{ type: "text", text: "No active project found. Please select a project first." }],
          };
        }

        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        const status = await client.getProjectStatus(activeProjectId);
        if (!status.requirementDocUrl) {
          return {
            content: [
              {
                type: "text",
                text: `No requirement document available yet for project ${activeProjectId}. Current phase: ${status.phase}`,
              },
            ],
          };
        }
        await open(status.requirementDocUrl);
        return {
          content: [
            {
              type: "text",
              text: `Opened requirement document in browser:\n${status.requirementDocUrl}`,
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
