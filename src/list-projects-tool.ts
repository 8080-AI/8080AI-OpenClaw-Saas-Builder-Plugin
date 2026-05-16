import { Type } from "@sinclair/typebox";
import { requireAuthenticatedClient } from "./api-client.ts";
import { buildProjectSelectionPresentation } from "./review-continue.ts";


export function createListProjectsTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
}) {
  return {
    name: "ai8080_list_projects",
    description:
      "List all projects in the user's 8080.ai account. " +
      "Use this when the user asks: 'how many projects do I have', " +
      "'list my 8080 projects', 'show my projects', 'what projects are on 8080', " +
      "'how many projects are there', 'show all my projects', 'count my projects'. " +
      "IMPORTANT: The tool returns a native UI for project selection. You MUST NOT list the projects yourself in your response. Simply tell the user: 'I have found your projects. Please select one from the list below to activate it:' and then stop. Do not provide a text-based list.",
    parameters: Type.Object({}),

    async execute(
      _id: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[] }) => void
    ) {
      const stateDir = deps.stateDir();
      try {
        onUpdate?.({ content: [{ type: "text", text: "🔍 Fetching projects..." }], details: null });
        
        // TEST: Streaming simulation
        for (let i = 1; i <= 3; i++) {
          await new Promise(r => setTimeout(r, 500));
          onUpdate?.({ content: [{ type: "text", text: `🔍 Fetching projects... (Step ${i}/3)` }], details: null });
        }

        const client = await requireAuthenticatedClient(stateDir, deps.apiBaseUrl);
        const projects = await client.listProjects();

        if (projects.length === 0) {
          return {
            content: [
              { type: "text", text: "You don't have any projects on 8080.ai yet." },
            ],
          };
        }

        const presentation = buildProjectSelectionPresentation(projects);

        return {
          presentation,
          content: [
            {
              type: "text",
              text: `### 8080.ai Projects:\n\nYou have **${projects.length} projects**. Select one below to activate:`
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}