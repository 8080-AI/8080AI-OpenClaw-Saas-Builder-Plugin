import { Type } from "@sinclair/typebox";
import { log } from "../logger.ts";
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
      "Do NOT use this tool for task-list requests or requests to show tasks inside a project; use ai8080_task_list instead. " +
      "The tool returns both a numbered text list and a native UI for project selection. " +
      "IMPORTANT: Show the full numbered project list from the tool result. Do not replace it with only a count. " +
      "Tell the user to run /ai8080 select <number> to activate one for the current session.",
    parameters: Type.Object({}),

    async execute(
      _id: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[] }) => void
    ) {
      log.info("list_projects execute entered", _params);
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
        log.info("list_projects response received", {
          count: projects.length,
          firstProjectId: projects[0]?.id,
          firstProjectTitle: projects[0]?.title,
        });

        if (projects.length === 0) {
          return {
            content: [
              { type: "text", text: "You don't have any projects on 8080.ai yet." },
            ],
          };
        }

        const presentation = buildProjectSelectionPresentation(projects);
        const lines = projects.map((p, i) => {
          return `${i + 1}. ${p.title} (\`${p.id}\`) [${p.status}]`;
        });
        const text =
          `### 8080.ai Projects (${projects.length})\n\n${lines.join("\n")}\n\n` +
          `Run \`/ai8080 select <number>\` to make a project active for this OpenClaw session.\n\n` +
          `Example: \`/ai8080 select 1\``;

        log.info("list_projects full list prepared", {
          count: projects.length,
          textLength: text.length,
        });

        return {
          presentation,
          content: [
            {
              type: "text",
              text,
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
