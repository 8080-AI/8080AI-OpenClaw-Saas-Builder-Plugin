import { Type } from "@sinclair/typebox";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient } from "./api-client.ts";

export function createTriggerAgentsTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
}) {
  return {
    name: "ai8080_trigger_agents",
    description:
      "Trigger specific AI agents on 8080.ai after the user has clicked the 'Run Requirements/Designs' button. " +
      "This starts the suggested agents working on the project requirements or designs.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "The 8080.ai project ID to trigger agents for.",
      }),
      agents: Type.Array(Type.String(), {
        description: "List of agent names to trigger (e.g., ['requirements', 'design']).",
      }),
    }),

    async execute(
      _id: string,
      params: { projectId: string; agents: string[] },
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
        await client.triggerAgents(params.projectId, params.agents);
        return {
          content: [
            {
              type: "text",
              text: `✅ Triggered agents: ${params.agents.join(", ")}\n\nThe AI agents are now working on your project. Run \`/ai8080 status\` to check progress.`,
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
