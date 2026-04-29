import { Type } from "@sinclair/typebox";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient } from "./api-client.ts";

export function createContinueProjectTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
}) {
  return {
    name: "ai8080_continue_project",
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
        await client.resumeDesign(params.projectId);

        let pausedForReview = false;
        const logs: string[] = [];
        let accumulatedText = "";
        
        await client.streamProjectEvents(params.projectId, {
          onAgentLog: (log) => {
            logs.push(`[${log.agent_type}] ${log.summary}`);
          },
          onChatMessage: (msg) => {
            logs.push(`[System] ${msg.content}`);
          },
          onPlanningComplete: () => {}
        });

        const [designPages, tasks, arch] = await Promise.all([
          client.getDesignPages(params.projectId).catch(() => null),
          client.getTasks(params.projectId).catch(() => null),
          client.getArchitecture(params.projectId).catch(() => null),
        ]);

        function hasGeneratedData(data: unknown): boolean {
          if (!data) return false;
          if (Array.isArray(data)) return data.length > 0;
          if (typeof data === 'object') {
            for (const val of Object.values(data)) {
              if (Array.isArray(val) && val.length > 0) return true;
            }
          }
          return false;
        }

        const isGenerated = hasGeneratedData(designPages) || hasGeneratedData(tasks) || hasGeneratedData(arch);
        const logsText = logs.length > 0 ? `\n\n**Activity Log:**\n${logs.map(l => `- ${l}`).join("\n")}` : "";

        if (isGenerated) {
          accumulatedText = `✅ **Generation complete!**\n${logsText}\n\nReview the design and architecture and start building.`;
          return {
            content: [{ type: "text", text: accumulatedText }],
            details: {
              status: "complete",
              suggestions: ["start_building"]
            }
          };
        } else {
          accumulatedText = `✅ **Agent execution finished, but no new designs were generated.**\n${logsText}`;
          return {
            content: [{ type: "text", text: accumulatedText }],
            details: {
              status: "complete",
              suggestions: ["continue", "review"]
            }
          };
        }
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
