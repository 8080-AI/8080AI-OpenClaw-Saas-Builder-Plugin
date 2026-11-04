import { waitForWorkflowCheckpoint, type WorkflowSyncClient } from "./workflow-sync.ts";
import { writeLatestSuggestions } from "./suggestions-state.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { formatProjectTasks } from "./task-summary.ts";
import { exactToolResult } from "./exact-response.ts";
import type { PendingSuggestion } from "./suggested-agents.ts";
import { WorkflowProgress, type WorkflowProgressState } from "./workflow-progress.ts";
import { getLabelForAgent } from "./review-continue.ts";
import { log } from "../logger.ts";

export async function waitForProjectResponse(client: WorkflowSyncClient, options: {
  stateDir: string; sessionId: string; projectId: string; modelTier: string;
  signal?: AbortSignal; timeoutMs?: number; consumed?: PendingSuggestion; startedAt?: number;
  onUpdate?: (result: ReturnType<typeof exactToolResult>) => void;
  onProgress?: (event: Record<string, unknown>) => void;
  progressState?: WorkflowProgressState;
  initialSuggestion?: PendingSuggestion;
  toolDeadlineAt?: number;
  observationWindowMs?: number;
}) {
  // A code-mode caller can abandon a pending exec even when the plugin's
  // timeout is ten minutes. Return a completed result with a continuation
  // within 45 seconds, so it receives project/progress evidence between reads.
  const deadline = Math.min(
    Date.now() + 45_000,
    (options.toolDeadlineAt ?? Date.now() + Math.min(600_000, options.timeoutMs ?? 600_000)) - 5_000,
  );
  const startedAt = options.progressState?.startedAt ?? (options.startedAt || Date.now());
  const selectedAgent = options.consumed?.agents.find(agent => agent !== "review");
  const initialStage = selectedAgent ? getLabelForAgent(selectedAgent, undefined, options.consumed?.buttons) : "Start";
  const progress = new WorkflowProgress(startedAt, initialStage, options.progressState);
  let lastText = "";
  const publish = (text: string) => {
    if (text === lastText) return;
    lastText = text;
    options.onUpdate?.(exactToolResult(text, { status: "running", projectId: options.projectId }));
  };
  publish(progress.render(Date.now()));
  await writeLatestSuggestions(options.stateDir, options.sessionId, {
    projectId: options.projectId, agents: [], messageId: options.consumed?.messageId ?? options.initialSuggestion?.messageId ?? "",
    observation: { consumed: options.consumed, startedAt, progress: progress.state },
  });
  let checkpoint: Awaited<ReturnType<typeof waitForWorkflowCheckpoint>>;
  let firstWindow = true;
  do {
    checkpoint = await waitForWorkflowCheckpoint(client, options.projectId, {
      ...options,
      initialSuggestion: firstWindow ? options.initialSuggestion : undefined,
      startedAt,
      followAutomaticStages: true,
      onProgress: event => {
        // Use a single accumulated progress panel instead of replacing it with
        // individual raw SSE messages or an intermediate action list.
        if (event.type === "workflow_snapshot") {
          publish(progress.update(event as import("./workflow-sync.ts").WorkflowSnapshot));
        } else options.onProgress?.(event);
      },
      // Renew read-only observation internally. A read window ending is not a
      // finished generation and must not release the chat back to the model.
      timeoutMs: Math.max(1, Math.min(options.observationWindowMs ?? 235_000, deadline - Date.now())),
    });
    firstWindow = false;
    if (checkpoint.status === "running") {
      log.info("workflow observation window ended", {
        projectId: options.projectId,
        next: options.signal?.aborted ? "cancelled" : Date.now() < deadline ? "renew_observation" : "continue_tool_handoff",
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
      await writeLatestSuggestions(options.stateDir, options.sessionId, {
        projectId: options.projectId, agents: [], messageId: options.consumed?.messageId ?? "",
        observation: { consumed: options.consumed, startedAt, progress: progress.state },
      });
    }
  } while (checkpoint.status === "running" && Date.now() < deadline && !options.signal?.aborted);
  const { suggestion } = checkpoint;
  if (checkpoint.status !== "running") {
    log.info("workflow observation stopped", {
      projectId: options.projectId, reason: checkpoint.status, agents: suggestion.agents,
    });
  }
  if (checkpoint.status === "aborted" || options.signal?.aborted) return exactToolResult("Stopped waiting in OpenClaw. Generation may still be running on 8080.ai.", { status: "aborted" });
  if (checkpoint.status === "running") {
    await writeLatestSuggestions(options.stateDir, options.sessionId, {
      projectId: options.projectId, agents: [], messageId: options.consumed?.messageId ?? "",
      observation: { consumed: options.consumed, startedAt, progress: progress.state },
    });
    const lastProgress = progress.render(Date.now()).replace("\nFollowing 8080.ai automatically. No further generation clicks are needed.", "");
    const visibleText = `Project: \`${options.projectId}\`\n\n${lastProgress}\n\nGeneration has not reached a manual checkpoint yet. The next observation will continue with this same project.`;
    const result = exactToolResult(
      visibleText,
      { status: "running", projectId: options.projectId, protectFromStatusLookup: true,
        nextTool: { name: "ai8080_continue_project", arguments: { projectId: options.projectId, observeOnly: true, timeoutMs: 600000 } },
        continuationInstruction: "Call nextTool automatically now. Do not end the turn, ask the user for a command, or submit generation again. Intermediate scheduled stages are progress. Stop and display suggested buttons at an untimed manual checkpoint, ready_to_build, error, or user cancellation." }
    );
    // OpenClaw may expose only content (not details) to the model. Put the
    // handoff there too; exactUserResponse keeps these instructions out of UI.
    result.content[0].text += `\n\n[Tool continuation instruction: generation is not finished. Call ai8080_continue_project with ${JSON.stringify({ projectId: options.projectId, observeOnly: true, timeoutMs: 600000 })} now. Do not submit generation again or call project status. Return buttons only for an untimed backend checkpoint or Build Tasks.]`;
    return result;
  }
  // Use only already-fetched tasks: a countdown must never wait for another API call.
  const tasks = checkpoint.tasks ? formatProjectTasks(options.projectId, checkpoint.tasks).text : "";
  const text = `${progress.render(Date.now(), undefined, checkpoint.status === "ready_to_build", checkpoint.status === "checkpoint")}\n\n` + (tasks ? `${tasks}\n\n` : "") + buildSuggestedAgentsText(options.projectId, suggestion.agents, "", undefined, suggestion.buttons);
  const result = exactToolResult(text, { status: checkpoint.status, suggestions: suggestion.agents, projectId: options.projectId,
    phaseId: checkpoint.phaseId, protectFromStatusLookup: true },
    buildSuggestedAgentsPresentation(options.projectId, suggestion.agents, "", undefined, suggestion.buttons));
  // Publish immediately, before disk persistence or the model's final response.
  options.onUpdate?.(result);
  await writeLatestSuggestions(options.stateDir, options.sessionId, {
    projectId: options.projectId, agents: suggestion.agents, messageId: suggestion.messageId, buttons: suggestion.buttons,
  });
  return result;
}
