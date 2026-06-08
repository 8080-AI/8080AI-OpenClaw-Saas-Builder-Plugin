import { Type } from "@sinclair/typebox";
import { AuthError, requireAuthenticatedClient } from "./api-client.ts";
import { buildRequirementsUrl } from "./review-continue.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { log } from "../logger.ts";

export function createReviewProjectTool(deps: {
  stateDir: () => string;
  siteUrl: string;
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
      const { siteUrl, apiBaseUrl, sessionId } = deps;

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
        const pending = extractPendingSuggestion(status.pending_suggested_agents);
        const requirementUrl = status.requirementDocUrl || buildRequirementsUrl(siteUrl, activeProjectId, pending.sessionId);
        log.info("review_project url", {
          projectId: activeProjectId,
          requirementUrl,
          sessionId: pending.sessionId,
        });
        return {
          content: [
            {
              type: "text",
              text: requirementUrl,
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
