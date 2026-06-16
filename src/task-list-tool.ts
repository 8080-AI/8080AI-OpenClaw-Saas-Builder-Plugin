import { Type } from "@sinclair/typebox";
import { log } from "../logger.ts";
import { AuthError, requireAuthenticatedClient } from "./api-client.ts";
import { formatTaskList } from "./command.ts";
import { readActiveProject } from "./project-state.ts";

export function createTaskListTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_task_list",
    description:
      "Show the task list for a selected 8080.ai project. " +
      "Use this for '/ai8080 task-list', 'task-list', 'show project tasks', 'list tasks', or requests to fetch /projects/{project_id}/tasks. " +
      "This tool must group tasks by their status such as todo, queued, ai_in_progress, done, error. " +
      "Do not use ai8080_list_projects for task-list requests.",
    parameters: Type.Object({
      projectId: Type.Optional(Type.String({
        description: "Optional 8080.ai project ID. If omitted, uses the active project for this OpenClaw session.",
      })),
    }),

    async execute(
      _id: string,
      params: { projectId?: string },
      _signal: AbortSignal | undefined,
      onUpdate: ((partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void) | undefined
    ) {
      const stateDir = deps.stateDir();
      const activeProjectId = params.projectId || await readActiveProject(stateDir, deps.sessionId);

      log.info("task_list tool entered", {
        requestedProjectId: params.projectId,
        activeProjectId,
        sessionId: deps.sessionId,
      });

      if (!activeProjectId) {
        log.info("task_list tool no active project", { sessionId: deps.sessionId });
        return {
          content: [{
            type: "text",
            text:
              "No active project found. Run `/ai8080 list` first, then select a project.\n\n" +
              "Use a command like `/ai8080 select 1`, `/ai8080 select <project-name>`, or `/ai8080 select <project-id>`.\n\n" +
              "Or use natural language like `select 1` or `switch to <project-name>`.\n\n" +
              "You can also run `/ai8080 task-list <project_id>`.",
          }],
          details: null,
        };
      }

      try {
        onUpdate?.({ content: [{ type: "text", text: `Fetching tasks for project \`${activeProjectId}\`...` }] });
        const client = await requireAuthenticatedClient(stateDir, deps.apiBaseUrl);
        log.info("task_list tool api request", {
          projectId: activeProjectId,
          path: `/projects/${activeProjectId}/tasks`,
        });

        const tasksResponse = await client.getTasks(activeProjectId);
        const formatted = formatTaskList(activeProjectId, tasksResponse);
        log.info("task_list tool grouped response", {
          projectId: activeProjectId,
          totalTasks: formatted.totalTasks,
          statusCounts: formatted.statusCounts,
        });

        return {
          content: [{ type: "text", text: formatted.text }],
          details: {
            projectId: activeProjectId,
            totalTasks: formatted.totalTasks,
            statusCounts: formatted.statusCounts,
          },
        };
      } catch (err) {
        if (err instanceof AuthError) {
          return { content: [{ type: "text", text: err.message }], details: null };
        }
        const msg = err instanceof Error ? err.message : String(err);
        log.info("task_list tool error", {
          projectId: activeProjectId,
          error: msg,
        });
        return {
          content: [{ type: "text", text: `8080.ai error fetching task list: ${msg}` }],
          details: null,
        };
      }
    },
  };
}
