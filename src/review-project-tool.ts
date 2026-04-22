import { Type } from "@sinclair/typebox";
import open from "open";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient } from "./api-client.ts";

export function createReviewProjectTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
}) {
  return {
    name: "ai8080_open_project_requirements",
    description:
      "Open the requirement document for an 8080.ai project in the user's web browser. " +
      "Use when the user wants to view, review, or see the requirements/spec doc for a " +
      "specific 8080.ai project. Requires the project ID.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "The 8080.ai project ID whose requirement document should be opened.",
      }),
    }),

    async execute(
      _id: string,
      params: { projectId: string },
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
        const status = await client.getProjectStatus(params.projectId);
        if (!status.requirementDocUrl) {
          return {
            content: [
              {
                type: "text",
                text: `No requirement document available yet for project ${params.projectId}. Current phase: ${status.phase}`,
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
