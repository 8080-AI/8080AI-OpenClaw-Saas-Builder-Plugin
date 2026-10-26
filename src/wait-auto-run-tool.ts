import { Type } from "@sinclair/typebox";
import { AuthError, requireAuthenticatedClient } from "./api-client.ts";
import { exactToolResult } from "./exact-response.ts";
import { consumeAutoRunSuggestion } from "./suggestions-state.ts";
import { log } from "../logger.ts";

export function createWaitAutoRunTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_wait_auto_run",
    description:
      "Cancel a scheduled 8080.ai automatic action so the user can trigger it manually. " +
      "Use this whenever the user chooses the numbered Wait option or sends a raw value beginning with '8080_wait_'. " +
      "Decode the JSON after that prefix and pass its projectId and entryId fields unchanged.",
    parameters: Type.Object({
      projectId: Type.String({ description: "The 8080.ai project ID associated with the Wait option." }),
      entryId: Type.String({ description: "The scheduled auto-run entry ID associated with the Wait option." }),
    }),

    async execute(
      _id: string,
      params: { projectId: string; entryId: string; label?: string }
    ) {
      try {
        const client = await requireAuthenticatedClient(deps.stateDir(), deps.apiBaseUrl);
        // This countdown is intentionally cancelled before doing any status
        // lookup. Even one preliminary request can let a short auto-run win
        // the race and make this endpoint return `not_scheduled`.
        const result = await client.waitForAutoRun(params.projectId, params.entryId);

        log.info("wait_auto_run response", {
          projectId: params.projectId,
          entryId: params.entryId,
          status: result.status,
        });

        await consumeAutoRunSuggestion(
          deps.stateDir(),
          deps.sessionId,
          params.projectId,
          params.entryId
        );

        if (result.status === "cancelled") {
          const label = params.label || "the action";
          return exactToolResult(
            `Automatic ${label} was cancelled. Choose ${label} when you are ready to trigger it manually.` +
              `\n\n### Suggested Next Steps:\n1. ${label}`,
            { projectId: params.projectId, entryId: params.entryId, status: result.status }
          );
        }

        return exactToolResult(
          "That automatic action is no longer scheduled; it may already be running or completed.",
          { projectId: params.projectId, entryId: params.entryId, status: "not_scheduled" }
        );
      } catch (err) {
        if (err instanceof AuthError) {
          return exactToolResult(err.message, { status: "auth_error" });
        }
        const message = err instanceof Error ? err.message : String(err);
        return exactToolResult(`8080.ai error while cancelling the automatic action: ${message}`, {
          projectId: params.projectId,
          entryId: params.entryId,
          status: "error",
        });
      }
    },
  };
}
