import { Type } from "@sinclair/typebox";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient } from "./api-client.ts";

export function createProjectStatusTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
}) {
  return {
    name: "get_project_status",
    description:
      "Get the current status of a 8080.ai project by its ID. " +
      "Shows the active agent, current phase, and requirement doc URL if available. " +
      "Use when the user asks about the status, phase, or progress of a specific 8080.ai project.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "The 8080.ai project ID to check status for.",
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

      const client = createApiClient({ token, apiBaseUrl });

      try {
        const status = await client.getProjectStatus(params.projectId);
        const lines = [
          `Project: ${params.projectId}`,
          `Phase:   ${status.phase}`,
        ];
        if (status.activeAgent) lines.push(`Agent:   ${status.activeAgent}`);
        if (status.agentMessage) lines.push(`Status:  ${status.agentMessage}`);
        if (status.requirementDocUrl)
          lines.push(`Req Doc: ${status.requirementDocUrl}`);
        if (status.error) lines.push(`Error:   ${status.error}`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
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
