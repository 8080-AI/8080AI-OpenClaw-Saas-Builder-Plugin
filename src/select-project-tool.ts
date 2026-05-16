import { Type } from "@sinclair/typebox";
import { requireAuthenticatedClient, AuthError } from "./api-client.ts";
import { writeActiveProject } from "./project-state.ts";

export function createSelectProjectTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_select_project",
    description:
      "Select and activate an existing 8080.ai project for the current session. " +
      "Use this when the user wants to switch to a different project or after listing projects to set the active one. " +
      "Once selected, subsequent messages will be sent to this project.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "The ID of the 8080.ai project to select and activate.",
      }),
    }),

    async execute(
      _id: string,
      params: { projectId: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl, sessionId } = deps;

      try {
        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        
        // Verify the project exists by listing projects
        const projects = await client.listProjects();
        const selected = projects.find(p => p.id === params.projectId);
        
        if (!selected) {
          return {
            content: [{ type: "text", text: `❌ Project with ID \`${params.projectId}\` not found.` }],
            details: null
          };
        }

        await writeActiveProject(stateDir, selected.id, sessionId);
        return {
          content: [
            {
              type: "text",
              text: `✅ Project \`${selected.title}\` is now active. (${selected.id})\n\nYou can now use \`ai8080_send_message\` without specifying the projectId.`,
            },
          ],
          details: null
        };
      } catch (err) {
        if (err instanceof AuthError) {
          return { content: [{ type: "text", text: (err as Error).message }], details: null };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `8080.ai error: ${msg}` }], details: null };
      }
    },
  };
}
