import { Type } from "@sinclair/typebox";
import { requireAuthenticatedClient, AuthError, checkGenerateFirstPageCondition, determineContinueButtonLabel, getDesignPageRecords, hasCompletedDesignPages } from "./api-client.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { writeLatestSuggestions } from "./suggestions-state.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { log } from "../logger.ts";

export function createProjectStatusTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
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
      onUpdate: (partial: { content: { type: "text"; text: string }[] }) => void
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

        // Show extra fields from API for discovery
        const knownKeys = new Set(["id", "phase", "status", "title", "activeAgent", "agentMessage", "requirementDocUrl", "error", "current_step", "steps", "progress"]);
        const extraKeys = Object.keys(status).filter(k => !knownKeys.has(k) && status[k] !== undefined && status[k] !== null);
        if (extraKeys.length > 0) {
          lines.push("");
          lines.push("**Other fields:**");
          for (const k of extraKeys) {
            const val = typeof status[k] === "object" ? JSON.stringify(status[k]) : String(status[k]);
            lines.push(`  ${k}: ${val.length > 100 ? val.slice(0, 100) + "…" : val}`);
          }
        }

        const pending = extractPendingSuggestion(status.pending_suggested_agents);
        let agents = pending.agents;
        let presentation: unknown;

        if (agents.length === 0) {
          try {
            const [designPages, hasLatestCompletedAgentLog] = await Promise.all([
              client.getDesignPages(projectId).catch(() => null),
              client.hasLatestCompletedAgentLog(projectId).catch(() => false),
            ]);
            const designPagesReady = hasCompletedDesignPages(designPages);
            const hasDesignPages = getDesignPageRecords(designPages).length > 0;
            const canShowReviewActions = (hasDesignPages && hasLatestCompletedAgentLog) || designPagesReady;
            if (canShowReviewActions) {
              agents = ["continue", "review"];
              log.info("project_status recovered suggestions from design completion state", {
                projectId,
                agents,
                hasLatestCompletedAgentLog,
                designPagesReady,
              });
            }
          } catch (err) {
            log.info("project_status failed to recover suggestions", err);
          }
        }

        if (agents && agents.length > 0) {
          await writeLatestSuggestions(stateDir, sessionId, {
            projectId,
            agents,
            messageId: pending.messageId,
            buttons: pending.buttons,
          });

          const continueButtonLabel = agents.includes("continue") ? await determineContinueButtonLabel(client, projectId) : undefined;
          const suggestionText = buildSuggestedAgentsText(projectId, agents, "", continueButtonLabel, pending.buttons);
          lines.push("");
          lines.push(suggestionText);

          presentation = buildSuggestedAgentsPresentation(projectId, agents, "", continueButtonLabel, pending.buttons);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          presentation,
        };
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
