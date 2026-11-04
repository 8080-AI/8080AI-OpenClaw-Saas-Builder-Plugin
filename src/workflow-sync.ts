import { AuthError, isPauseForReviewText, type createApiClient, type AgentLog, type AutoRunsResponse } from "./api-client.ts";
import { evaluateBuildTasksReadiness, canOfferBuildTasksAction, type BuildTasksReadiness } from "./build-readiness.ts";
import { extractEventSuggestion, extractLatestReplySuggestion, extractPendingSuggestion, type PendingSuggestion } from "./suggested-agents.ts";
import { buildSuggestedAgentChoices } from "./review-continue.ts";
import { log } from "../logger.ts";

type Client = ReturnType<typeof createApiClient>;
export type WorkflowSyncClient = Pick<Client, "getProjectStatus" | "getAutoRuns" | "getAgentLogs" | "getPlanningStatus" | "getBuildPhaseExecutionState" | "getTasks" | "streamProjectEvents">;
export type WorkflowCheckpoint = {
  status: "checkpoint" | "ready_to_build" | "running" | "aborted";
  suggestion: PendingSuggestion;
  tasks?: unknown;
  phaseId?: string;
};
export type WorkflowSnapshot = {
  type: "workflow_snapshot";
  now: number;
  agents: (AgentLog & { startedAt?: number })[];
  schedules: { entryId: string; label: string; expiresAt: number }[];
  paused: boolean;
};
const empty = (): PendingSuggestion => ({ agents: [], messageId: "", sessionId: "" });
function timestamp(value?: string): number {
  if (!value) return 0;
  return Date.parse(/(?:z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`) || 0;
}
function actionKey(suggestion: PendingSuggestion): string {
  return buildSuggestedAgentChoices("", suggestion.agents, undefined, suggestion.buttons)
    .filter(choice => choice.kind === "agent").map(choice => choice.label).sort().join("|");
}
function checkpointKey(suggestion: PendingSuggestion): string {
  return JSON.stringify([
    suggestion.sessionId, suggestion.messageId, [...suggestion.agents].sort(),
    (suggestion.buttons ?? []).filter(button => button.enabled !== false).map(button =>
      [button.key, button.action, button.kind === "auto_run" ? button.payload?.entry_id : button.label,
        button.payload?.phase]).sort(),
  ]);
}

/** Events and independent polling lanes converge here. A slow schedule request
 * cannot block events, agent logs, or fresh build readiness. Never submit work. */
export async function waitForWorkflowCheckpoint(
  client: WorkflowSyncClient,
  projectId: string,
  options: {
    modelTier: string;
    timeoutMs: number;
    signal?: AbortSignal;
    consumed?: PendingSuggestion;
    startedAt?: number;
    onProgress?: (event: Record<string, unknown>) => void;
    pollIntervalMs?: number;
    scheduleGraceMs?: number;
    reconnectMs?: number;
    followAutomaticStages?: boolean;
    initialSuggestion?: PendingSuggestion;
  }
): Promise<WorkflowCheckpoint> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  // Real clients cancel every outstanding read when the observation completes.
  const scoped = "withSignal" in client ? (client as Client).withSignal(signal) : client;
  const startedAt = options.startedAt ?? Date.now();
  const interval = options.pollIntervalMs ?? 3_000;
  const grace = options.scheduleGraceMs ?? 8_000;
  const minimumGrace = Math.min(3_000, grace);
  let candidate = empty();
  let candidateAt = 0;
  let eventVersion = 0;
  let paused = false;
  let latestMessages: unknown;
  let hasPendingSuggestion = false;
  const agentStates = new Map<string, AgentLog>();
  const agentStarts = new Map<string, number>();
  let readiness: BuildTasksReadiness | undefined;
  let tasks: unknown;
  let schedules: any[] = [];
  let scheduleFetchedAt = 0;
  const expiredActions = new Set<string>();
  let done = false;
  let resolve!: (value: WorkflowCheckpoint) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<WorkflowCheckpoint>((res, rej) => { resolve = res; reject = rej; });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const actionableTasks = (): unknown[] => {
    const state = readiness?.state;
    // Credit filtering removes otherwise planned tasks from runnable_tasks.
    // Keep the build action available so its existing credit gate can explain the hold.
    if (state?.blocking_reason === "insufficient_credits" && Array.isArray(state.phase_tasks)) return state.phase_tasks;
    return state?.runnable_tasks ?? [];
  };
  const finish = (status: WorkflowCheckpoint["status"], suggestion = empty()) => {
    if (done) return;
    done = true;
    resolve({ status, suggestion, tasks: status === "ready_to_build" ? actionableTasks() : tasks, phaseId: readiness?.phaseId });
    controller.abort();
  };
  const fail = (error: unknown) => {
    if (done) return;
    done = true;
    reject(error);
    controller.abort();
  };
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!done) fn(); }, ms);
    timers.add(timer);
  };
  const consumedKey = options.consumed ? checkpointKey(options.consumed) : "";
  const consumedSchedules = new Set((options.consumed?.buttons ?? [])
    .filter(button => button.kind === "auto_run")
    .map(button => button.payload?.entry_id).filter(Boolean));
  const unavailable = (next: PendingSuggestion) =>
    checkpointKey(next) === consumedKey || expiredActions.has(checkpointKey(next));
  const accept = (next: PendingSuggestion) => {
    if (!next.agents.length) return;
    if (unavailable(next)) return;
    if (checkpointKey(next) !== checkpointKey(candidate)) {
      candidateAt = Date.now();
      later(check, minimumGrace);
      if (grace > minimumGrace) later(check, grace);
    }
    candidate = next;
  };
  const clearAction = () => {
    if (candidate.agents.length) expiredActions.add(checkpointKey(candidate));
    candidate = empty();
    paused = false;
    readiness = undefined;
  };
  function check() {
    if (done || signal.aborted) return;
    const now = Date.now();
    options.onProgress?.({ type: "workflow_snapshot", now, paused,
      agents: [...agentStates.entries()].map(([key, entry]) => ({ ...entry, startedAt: agentStarts.get(key) })),
      schedules: schedules.filter(button => button.expiresAt > now && !consumedSchedules.has(button.payload.entry_id))
        .map(button => ({ entryId: button.payload.entry_id, label: button.payload.label, expiresAt: button.expiresAt })),
    } satisfies WorkflowSnapshot);
    // Readiness is refreshed throughout the wait, including after auto-resume.
    const runnableCount = actionableTasks().length;
    if (readiness && canOfferBuildTasksAction(readiness, runnableCount)) {
      finish("ready_to_build", { ...empty(), agents: ["start_building", "review"] });
      return;
    }
    // Some review pauses clear pending agents even though the latest backend
    // reply explicitly offers a manual button. Recover that current offer.
    if (paused && !hasPendingSuggestion) {
      const reply = extractLatestReplySuggestion(latestMessages, startedAt);
      if (reply.agents.length) accept(reply);
    }
    const liveSchedules = schedules.filter(button => button.expiresAt > now &&
      !consumedSchedules.has(button.payload.entry_id));
    const scheduleButtons = liveSchedules.map(({ expiresAt, ...button }) => ({ ...button,
        payload: { ...button.payload, server_now: new Date(Date.parse(button.payload.fire_at) - (expiresAt - now)).toISOString() },
      }));
    // A scheduled action remains authoritative when project detail has cleared
    // pending_suggested_agents or still contains a legacy generic agent name.
    // Normalize from the schedule alone so explicit stale agents cannot mask it.
    const scheduled = extractPendingSuggestion({ buttons: scheduleButtons });
    const candidateActions = actionKey(candidate).split("|");
    const matchingCandidate = scheduled.agents.length > 0 &&
      actionKey(scheduled).split("|").every(label => candidateActions.includes(label));
    const next = scheduled.agents.length ? {
      ...scheduled,
      agents: matchingCandidate ? candidate.agents : scheduled.agents,
      messageId: matchingCandidate ? candidate.messageId : "",
      sessionId: matchingCandidate ? candidate.sessionId : "",
      buttons: [...(matchingCandidate ? candidate.buttons ?? [] : [])
        .filter(button => button.kind !== "auto_run"), ...scheduleButtons],
    } : extractPendingSuggestion({ ...candidate,
      buttons: (candidate.buttons ?? []).filter(button => button.kind !== "auto_run"),
    });
    const choices = buildSuggestedAgentChoices(projectId, next.agents, undefined, next.buttons);
    // Schedule readiness is independent of whether the Wait UI is enabled.
    const hasScheduledAction = scheduled.agents.length > 0 && scheduleButtons.length > 0;
    const key = actionKey(next);
    if (unavailable(next)) return;
    // A schedule reaching its deadline is no longer a manual next action.
    if (!hasScheduledAction && schedules.some(button => button.expiresAt <= now && key.includes(button.payload.label))) {
      clearAction();
      return;
    }
    // Completing one agent is not a pipeline pause: another agent may start
    // in the same second. Only backend review gates and schedules are actionable.
    if (!next.agents.length || !(paused || hasScheduledAction)) return;
    if (next.agents.some(agent => agent === "start_building" || agent === "start_build")) return; // Build readiness above is authoritative.
    // All checkpoint actions get schedule grace, including legacy agent names.
    if (!hasScheduledAction && (now - candidateAt < minimumGrace ||
        (scheduleFetchedAt < candidateAt && now - candidateAt < grace))) return;
    // Follow checkpoints only while the backend actually scheduled their next
    // action. An untimed review gate needs a user click (e.g. All Pages).
    if (options.followAutomaticStages && hasScheduledAction) return;
    // Give the schedule transaction its full grace period before deciding that
    // a paused checkpoint is manual, even after an early empty schedule read.
    if (options.followAutomaticStages && now - candidateAt < grace) return;
    log.info("workflow_sync checkpoint ready", { projectId, agents: next.agents, labels: choices.map(choice => choice.label) });
    finish("checkpoint", next);
  }
  const applyLogs = (entries: AgentLog[]) => {
    // Keep independent agent/message states; equal timestamps across agents
    // must not hide a startup behind another agent's completion.
    const ordered = [...(Array.isArray(entries) ? entries : [])].sort((a, b) =>
      timestamp(a.created_at) - timestamp(b.created_at) ||
      Number(a.action === "completed") - Number(b.action === "completed"));
    for (const newest of ordered) {
      const key = `${newest.agent_type}:${newest.message_id ?? ""}`;
      const previous = agentStates.get(key);
      if (previous && (timestamp(newest.created_at) < timestamp(previous.created_at) ||
          (timestamp(newest.created_at) === timestamp(previous.created_at) &&
            previous.action === "completed" && ["started", "running"].includes(newest.action)))) continue;
      const changed = !previous || JSON.stringify(newest) !== JSON.stringify(previous);
      if (["started", "running"].includes(newest.action)) {
        const time = timestamp(newest.created_at);
        const previousStart = agentStarts.get(key);
        if (!previousStart || (previous && !["started", "running"].includes(previous.action))) agentStarts.set(key, time);
      }
      agentStates.set(key, newest);
      if (changed && ["failed", "error"].includes(newest.action) && timestamp(newest.created_at) >= startedAt - 5_000) {
        fail(new Error(`Agent ${newest.agent_type} failed: ${newest.summary}`));
      }
      if (changed && ["started", "running"].includes(newest.action) &&
          timestamp(newest.created_at) >= startedAt - 5_000) {
        eventVersion++;
        clearAction();
      }
      if (changed) options.onProgress?.({ type: "agent_log", ...newest });
    }
    check();
  };
  const applySchedules = (data: AutoRunsResponse) => {
    scheduleFetchedAt = Date.now();
    if (data.lookup_failed) { check(); return; } // Keep valid event data on a failed read.
    const serverNow = timestamp(data.server_now) || scheduleFetchedAt;
    schedules = data.auto_runs.filter(entry => entry.status === "scheduled").map(entry => ({
      key: entry.button_key, kind: "auto_run", action: "wait_auto_run", label: "Wait",
      payload: { ...entry, server_now: data.server_now },
      expiresAt: scheduleFetchedAt + timestamp(entry.fire_at) - serverNow,
    }));
    check();
  };
  const onRaw = (raw: string) => {
    if (done) return;
    let event: Record<string, any>;
    try { event = JSON.parse(raw); } catch { return; }
    options.onProgress?.(event);
    if (event.type === "error") { fail(new Error(String(event.message ?? event.content ?? "8080.ai generation failed"))); return; }
    if (event.type === "agent_log") {
      if (["failed", "error"].includes(event.action) && !event.created_at) {
        fail(new Error(`Agent ${event.agent_type} failed: ${event.summary}`));
        return;
      }
      applyLogs([event as AgentLog]);
    }
    if (Array.isArray(event.auto_runs)) applySchedules(event as AutoRunsResponse);
    const next = extractEventSuggestion(event);
    const hasSuggestion = next.agents.length > 0 || event.type === "suggested_agents";
    if (hasSuggestion) {
      eventVersion++;
      if (!next.agents.length) clearAction();
      else accept(next);
      const autoButtons = next.buttons?.filter(button => button.kind === "auto_run");
      if (autoButtons?.length) applySchedules({ auto_runs: autoButtons.map(button => button.payload), server_now: autoButtons[0].payload?.server_now });
    }
    if (["paused_review", "paused_for_review"].includes(String(event.status)) ||
        (event.type === "chat_message" && isPauseForReviewText(event.content))) paused = true;
    check();
  };
  const poll = (name: string, read: () => Promise<void>) => {
    const run = async () => {
      if (done || signal.aborted) return;
      try { await read(); }
      catch (error) {
        if (done || signal.aborted) return;
        if (error instanceof AuthError) { fail(error); return; }
        log.info("workflow_sync read failed; retaining live events", { projectId, source: name, error: error instanceof Error ? error.message : String(error) });
      }
      if (!done) later(() => { void run(); }, interval);
    };
    void run();
  };
  const aborted = () => { if (!done) finish("aborted"); };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  later(() => finish("running"), Math.max(1, options.timeoutMs));
  if (options.followAutomaticStages) {
    const heartbeat = () => { check(); if (!done) later(heartbeat, 1_000); };
    later(heartbeat, 1_000);
  }
  // Project creation already fetched this live offer. Seed observation without
  // consuming Start or submitting it again; the backend owns its countdown.
  if (options.initialSuggestion) onRaw(JSON.stringify({ type: "suggested_agents",
    pending_suggested_agents: options.initialSuggestion }));
  poll("project", async () => {
    const version = eventVersion;
    const status = await scoped.getProjectStatus(projectId, { includeAutoRuns: false });
    if (done || version !== eventVersion) return; // A slow REST snapshot cannot overwrite a newer event.
    // REST can expose suggested_agents directly, not only inside pending.
    const pending = extractEventSuggestion(status);
    latestMessages = status.messages;
    hasPendingSuggestion = pending.agents.length > 0;
    if (pending.agents.length) accept(pending);
    if (status.error) { fail(new Error(String(status.error))); return; }
    check();
  });
  poll("agent_logs", async () => { const logs = await scoped.getAgentLogs(projectId); if (!done) applyLogs(logs); });
  poll("auto_runs", async () => {
    const version = eventVersion;
    const runs = await scoped.getAutoRuns(projectId);
    if (!done && version === eventVersion) applySchedules(runs);
  });
  poll("build_readiness", async () => {
    const version = eventVersion;
    const [planning, execution] = await Promise.all([
      scoped.getPlanningStatus(projectId), scoped.getBuildPhaseExecutionState(projectId, options.modelTier),
    ]);
    if (done || version !== eventVersion) return;
    readiness = evaluateBuildTasksReadiness(execution, planning);
    if (["paused_review", "paused_for_review"].includes(String(planning.pipeline_run_status))) paused = true;
    check();
  });
  poll("tasks", async () => { const value = await scoped.getTasks(projectId); if (!done) tasks = value; });
  const stream = async () => {
    if (done || signal.aborted) return;
    try {
      await scoped.streamProjectEvents(projectId, { onRaw, signal,
        idleTimeoutMs: 60_000, progressTimeoutMs: 60_000, maxTimeoutMs: Math.max(1, options.timeoutMs),
        onPlanningComplete: data => { if (["paused_review", "paused_for_review"].includes(data.status)) paused = true; check(); },
      });
    } catch (error) {
      if (!done && !signal.aborted) log.info("workflow_sync reconnecting events", { projectId, error: String(error) });
    }
    if (!done) later(() => { void stream(); }, options.reconnectMs ?? 500);
  };
  void stream();
  try { return await result; }
  finally {
    done = true;
    controller.abort();
    signal.removeEventListener("abort", aborted);
    for (const timer of timers) clearTimeout(timer);
  }
}
