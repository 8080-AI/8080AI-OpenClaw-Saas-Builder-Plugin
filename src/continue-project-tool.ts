import { Type } from "@sinclair/typebox";
import { AuthRequiredError } from "./auth.ts";
import { AuthError, requireAuthenticatedClient } from "./api-client.ts";

export function createContinueProjectTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_continue_project",
    description:
      "Signal 8080.ai to proceed past the requirement-review phase and start building the project. " +
      "Use when the user has reviewed the requirements and wants to continue, proceed, or approve " +
      "so the agents start building. Requires the project ID.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String({
        description: "The 8080.ai project ID. Optional if a project is already active.",
      })),
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
        const activeProjectId = params.projectId || await readActiveProject(stateDir, sessionId);
        
        if (!activeProjectId) {
          return {
            content: [{ type: "text", text: "No active project found. Please select a project first." }],
          };
        }

        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        await client.resumeDesign(activeProjectId);

        onUpdate?.({ content: [{ type: "text", text: "🚀 Design agents running..." }] });

        let accumulatedText = "";
        const logs: string[] = [];
        
        let logCount = 0;
        await client.streamProjectEvents(activeProjectId, {
          onAgentLog: (log) => {
            logCount++;
            const entry = `[${log.agent_type}] ${log.summary}`;
            logs.push(entry);
            accumulatedText = `🚀 Agents are working...\n\n**Activity Log:**\n${logs.map(l => `- ${l}`).join("\n")}`;
            onUpdate?.({ content: [{ type: "text", text: accumulatedText }] });
          },
          onChatMessage: (msg) => {
            logCount++;
            const entry = `[System] ${msg.content}`;
            logs.push(entry);
            accumulatedText = `🚀 Agents are working...\n\n**Activity Log:**\n${logs.map(l => `- ${l}`).join("\n")}`;
            onUpdate?.({ content: [{ type: "text", text: accumulatedText }] });
          },
          onPlanningComplete: () => {}
        });

        // If we got no logs after a while, or the stream closed, proceed to fetch results
        if (logCount === 0) {
          await new Promise(r => setTimeout(r, 2000)); // Brief pause to ensure backend processed resume
        }

        const [designPages, tasks, arch] = await Promise.all([
          client.getDesignPages(activeProjectId).catch(() => null),
          client.getTasks(activeProjectId).catch(() => null),
          client.getArchitecture(activeProjectId).catch(() => null),
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
          const finalResult = `✅ **Generation complete!**${logsText}\n\nReview the design and architecture and start building.`;
          onUpdate?.({ content: [{ type: "text", text: finalResult }] });
          return {
            content: [{ type: "text", text: finalResult }],
            details: {
              status: "complete",
              suggestions: ["start_building"]
            }
          };
        } else {
          const finalResult = `✅ **Agent execution finished, but no new designs were generated.**${logsText}`;
          onUpdate?.({ content: [{ type: "text", text: finalResult }] });
          return {
            content: [{ type: "text", text: finalResult }],
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
