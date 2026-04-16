import { Type } from "@sinclair/typebox";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient } from "./api-client.ts";

export function createContinueProjectTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
}) {
  return {
    name: "continue_project",
    description:
      "Signal 8080.ai to proceed past the requirement-review phase and start building the project. " +
      "Use when the user has reviewed the requirements and wants to continue, proceed, or approve " +
      "so the agents start building. Requires the project ID.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "The 8080.ai project ID to continue building.",
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
        await client.continueProject(params.projectId);
        return {
          content: [
            {
              type: "text",
              text: `✅ Continuing project ${params.projectId}. Agents are now building your software.`,
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
