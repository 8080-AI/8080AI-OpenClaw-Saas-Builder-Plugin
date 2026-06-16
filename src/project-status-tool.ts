import { Type } from "@sinclair/typebox";
import { requireAuthenticatedClient, AuthError } from "./api-client.ts";
import { buildProjectActivationResult } from "./project-activation.ts";

export function createProjectStatusTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_get_project_status",
    description:
      "Get the current status of an 8080.ai project by its ID. " +
      "Shows the active agent, current phase, and requirement doc URL if available. " +
      "Use when the user asks about the status, phase, or progress of a specific 8080.ai project.",
    parameters: Type.Object({
      projectId: Type.Optional(
        Type.String({
          description: "The 8080.ai project ID to check status for.",
        })
      ),
    }),

    async execute(
      _id: string,
      params: { projectId?: string },
      _signal: AbortSignal | undefined,
      onUpdate: ((partial: { content: { type: "text"; text: string }[]; details?: unknown; presentation?: unknown }) => void) | undefined
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl, sessionId } = deps;

      try {
        const { readActiveProject } = await import("./project-state.ts");
        const projectId = params.projectId || (await readActiveProject(stateDir, sessionId));

        if (!projectId) {
          return {
            content: [
              {
                type: "text",
                text: "No active project found. Please provide a projectId or select a project first.",
              },
            ],
          };
        }

        onUpdate?.({ content: [{ type: "text", text: `🔄 Fetching status for project ${projectId}...` }] });

        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        const status = await client.getProjectStatus(projectId);
        const lines = [
          `### 📊 Project Status`,
        ];
        if (status.title) lines.push(`**Project:** ${status.title}`);
        lines.push(`**ID:** ${projectId}`);
        lines.push(`**Phase:** ${status.phase ?? status.status ?? "unknown"}`);
        if (status.activeAgent) lines.push(`**Agent:** ${status.activeAgent}`);
        if (status.agentMessage) lines.push(`**Message:** ${status.agentMessage}`);
        if (status.progress !== undefined) lines.push(`**Progress:** ${status.progress}%`);

        // Show steps if available
        if (status.steps && Array.isArray(status.steps) && status.steps.length > 0) {
          lines.push("");
          lines.push("**Build Steps:**");
          for (const step of status.steps) {
            const icon =
              step.status === "completed" ? "✅" :
              step.status === "in_progress" ? "🔄" :
              step.status === "failed" ? "❌" : "⏳";
            lines.push(`  ${icon} ${step.name}`);
          }
        } else if (status.current_step) {
          lines.push("");
          lines.push(`**Current Step:** 🔄 ${status.current_step}`);
        }

        if (status.requirementDocUrl)
          lines.push(`\n**Req Doc:** ${status.requirementDocUrl}`);
        if (status.error) lines.push(`\n❌ **Error:** ${status.error}`);

        const activation = await buildProjectActivationResult({
          client,
          projectId,
          projectTitle: status.title || projectId,
          stateDir,
          openClawSessionId: sessionId,
          introText: "",
        });
        const text = lines.join("\n") + activation.latestMessageText;
        const result = {
          content: [{ type: "text" as const, text }],
          details: {
            projectId,
          },
          presentation: activation.presentation,
        };

        onUpdate?.(result);
        return result;
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
