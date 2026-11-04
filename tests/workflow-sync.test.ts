import test from "node:test";
import assert from "node:assert/strict";
import { waitForWorkflowCheckpoint, type WorkflowSyncClient } from "../src/workflow-sync.ts";
import { buildSuggestedAgentChoices } from "../src/review-continue.ts";

const action = (label = "Generate Architecture") => ({ type: "suggested_agents", agents: ["continue"],
  buttons: [{ key: "continue", action: "resume_design", label }], message_id: label });
const schedule = (label = "Generate Architecture", seconds = 30) => ({ server_now: new Date().toISOString(), auto_runs: [{
  entry_id: label, button_key: "continue", label, status: "scheduled", fire_at: new Date(Date.now() + seconds * 1000).toISOString(),
}] });
function fake(overrides: Partial<WorkflowSyncClient> = {}): WorkflowSyncClient {
  return {
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: null }),
    getAutoRuns: async () => ({ auto_runs: [] }),
    getAgentLogs: async () => [],
    getPlanningStatus: async () => ({ is_active: true, pm_step_status: "pending", pipeline_run_status: "running" }),
    getBuildPhaseExecutionState: async () => ({ can_start: false, runnable_tasks: [], blocking_reason: "task_plan_missing" }) as any,
    getTasks: async () => [],
    streamProjectEvents: async (_id, callbacks) => new Promise<void>(resolve => {
      if (callbacks.signal?.aborted) resolve();
      else callbacks.signal?.addEventListener("abort", () => resolve(), { once: true });
    }),
    ...overrides,
  };
}
const options = { modelTier: "super_large", timeoutMs: 500, pollIntervalMs: 5, scheduleGraceMs: 30, reconnectMs: 5, startedAt: 0 };

test("live checkpoint and timer are delivered even while REST reads are stuck", async () => {
  let streamAborted = false;
  let release!: (value: any) => void;
  const slow = new Promise<any>(resolve => { release = resolve; });
  const client = fake({
    getProjectStatus: () => slow,
    getAutoRuns: () => slow,
    getPlanningStatus: () => slow,
    streamProjectEvents: async (_id, cb) => {
      await new Promise<void>(resolve => {
        cb.signal?.addEventListener("abort", () => { streamAborted = true; resolve(); }, { once: true });
        setTimeout(() => {
          const runs = schedule();
          cb.onRaw?.(JSON.stringify({ ...action(), status: "paused_for_review", buttons: [...action().buttons,
            { kind: "auto_run", action: "wait_auto_run", payload: { ...runs.auto_runs[0], server_now: runs.server_now } }] }));
        }, 40);
      });
    },
  });
  const result = await waitForWorkflowCheckpoint(client, "project", options);
  assert.equal(result.status, "checkpoint");
  assert.deepEqual(buildSuggestedAgentChoices("project", result.suggestion.agents, undefined, result.suggestion.buttons).map(x => x.label), ["Generate Architecture"]);
  assert.equal(streamAborted, true);
  release({ auto_runs: [], is_active: true, id: "project" });
});

test("a delayed schedule is joined to the completed design checkpoint", async () => {
  let attempts = 0;
  const result = await waitForWorkflowCheckpoint(fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: action() }),
    getAgentLogs: async () => [{ action: "completed", agent_type: "Design Agent", summary: "Designed Calculator", created_at: new Date().toISOString() }] as any,
    getPlanningStatus: async () => ({ is_active: false, pm_step_status: "pending", pipeline_run_status: "paused_review" }),
    getAutoRuns: async () => ++attempts < 3 ? { auto_runs: [] } : schedule(),
  }), "project", { ...options, scheduleGraceMs: 100 });
  assert.ok(attempts >= 3);
  assert.equal(result.status, "checkpoint");
  assert.deepEqual(buildSuggestedAgentChoices("project", result.suggestion.agents, undefined, result.suggestion.buttons).map(x => x.label), ["Generate Architecture"]);
});

test("an agent completion cannot expose a generic Design action while planning runs", async () => {
  const created_at = new Date().toISOString();
  const result = await waitForWorkflowCheckpoint(fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: { agents: ["Design Agent"] } }),
    getAgentLogs: async () => [
      { action: "completed", agent_type: "System Requirements Agent", created_at },
      { action: "started", agent_type: "User Flow Planner", created_at },
    ] as any,
  }), "project", { ...options, timeoutMs: 60 });
  assert.equal(result.status, "running");
  assert.deepEqual(result.suggestion.agents, []);
});

test("running Design suggestion waits for the first-page review action and its delayed schedule", async () => {
  const created_at = new Date().toISOString();
  let reads = 0;
  const client = fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: { agents: ["Design Agent"] } }),
    getAgentLogs: async () => [
      { action: "completed", agent_type: "System Requirements Agent", created_at },
      { action: "started", agent_type: "User Flow Planner", created_at },
    ] as any,
    getAutoRuns: async () => ++reads < 10 ? { auto_runs: [] } : schedule("Generate First Page"),
    streamProjectEvents: async (_id, cb) => {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => cb.onRaw?.(JSON.stringify({
          ...action("Generate First Page"), status: "paused_for_review",
        })), 30);
        cb.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    },
  });
  const result = await waitForWorkflowCheckpoint(client, "project", { ...options, scheduleGraceMs: 150 });
  assert.equal(result.status, "checkpoint");
  assert.deepEqual(buildSuggestedAgentChoices("project", result.suggestion.agents, undefined, result.suggestion.buttons).map(x => x.label), ["Generate First Page"]);
});

test("expired architecture action is replaced by freshly checked Build Tasks after automatic progression", async () => {
  let readinessReads = 0;
  const client = fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: action() }),
    getAutoRuns: async () => schedule("Generate Architecture", -1),
    getPlanningStatus: async () => ({ is_active: ++readinessReads < 3, pm_step_status: readinessReads < 3 ? "pending" : "done" }),
    getBuildPhaseExecutionState: async () => ({ can_start: readinessReads >= 3, current_phase: { id: "phase" },
      runnable_tasks: readinessReads >= 3 ? [{ id: "task" }] : [], all_completed: false }) as any,
  });
  const result = await waitForWorkflowCheckpoint(client, "project", options);
  assert.ok(readinessReads >= 3);
  assert.equal(result.status, "ready_to_build");
  assert.deepEqual(result.suggestion.agents, ["start_building", "review"]);
  assert.equal(result.phaseId, "phase");
});

test("failed schedule lookup still permits an authoritative manual action without inventing Wait", async () => {
  const result = await waitForWorkflowCheckpoint(fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: action() }),
    getAutoRuns: async () => ({ auto_runs: [], lookup_failed: true }),
    getPlanningStatus: async () => ({ is_active: false, pm_step_status: "pending", pipeline_run_status: "paused_review" }),
  }), "project", options);
  assert.equal(result.status, "checkpoint");
  assert.deepEqual(buildSuggestedAgentChoices("project", result.suggestion.agents, undefined, result.suggestion.buttons).map(x => x.label), ["Generate Architecture"]);
});

test("observation timeout and user cancellation settle without launching work", async () => {
  const result = await waitForWorkflowCheckpoint(fake(), "project", { ...options, timeoutMs: 15 });
  assert.equal(result.status, "running");
  const controller = new AbortController();
  controller.abort();
  const aborted = await waitForWorkflowCheckpoint(fake(), "project", { ...options, signal: controller.signal });
  assert.equal(aborted.status, "aborted");
});

test("slow stale REST suggestions cannot replace newer event actions", async () => {
  let first = true;
  const result = await waitForWorkflowCheckpoint(fake({
    getProjectStatus: async () => {
      if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 20)); }
      return { id: "project", pending_suggested_agents: action("Generate First Page") };
    },
    getAutoRuns: async () => ({ auto_runs: [], lookup_failed: true }),
    streamProjectEvents: async (_id, cb) => {
      cb.onRaw?.(JSON.stringify({ ...action(), status: "paused_for_review" }));
      await new Promise<void>(resolve => cb.signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
  }), "project", { ...options, consumed: { agents: ["continue"], buttons: action("Generate First Page").buttons, messageId: "Generate First Page", sessionId: "" } });
  assert.equal(result.status, "checkpoint");
  assert.equal(result.suggestion.buttons?.[0].label, "Generate Architecture");
});

for (const label of ["Generate First Page", "Generate All Pages", "Generate Architecture"]) {
  test(`schedule alone exposes ${label} without Wait when pending suggestions are cleared`, async () => {
    const result = await waitForWorkflowCheckpoint(fake({
      getAutoRuns: async () => schedule(label),
    }), "project", options);
    assert.equal(result.status, "checkpoint");
    assert.deepEqual(buildSuggestedAgentChoices("project", result.suggestion.agents, undefined, result.suggestion.buttons)
      .map(choice => choice.label), [label]);
  });
}

test("a first-page schedule replaces a stale generic Design candidate", async () => {
  const result = await waitForWorkflowCheckpoint(fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: { agents: ["Design Agent"] } }),
    getAutoRuns: async () => schedule("Generate First Page"),
  }), "project", options);
  assert.equal(result.status, "checkpoint");
  assert.deepEqual(buildSuggestedAgentChoices("project", result.suggestion.agents, undefined, result.suggestion.buttons)
    .map(choice => choice.label), ["Generate First Page"]);
});

test("a new message with the same action label is not suppressed as consumed", async () => {
  const old = { agents: ["continue"], buttons: action().buttons, messageId: "old", sessionId: "session" };
  let reads = 0;
  const result = await waitForWorkflowCheckpoint(fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents:
      ++reads < 3 ? old : { ...old, messageId: "new" } }),
    getPlanningStatus: async () => ({ is_active: false, pipeline_run_status: "paused_review" }),
  }), "project", { ...options, consumed: old });
  assert.ok(reads >= 3);
  assert.equal(result.status, "checkpoint");
  assert.equal(result.suggestion.messageId, "new");
});

test("a consumed countdown is ignored while waiting for the next schedule entry", async () => {
  const oldRun = schedule("Generate First Page");
  const consumed = { agents: ["generate_first_page"], messageId: "old", sessionId: "",
    buttons: [{ kind: "auto_run", action: "wait_auto_run", payload: oldRun.auto_runs[0] }] };
  let reads = 0;
  const result = await waitForWorkflowCheckpoint(fake({
    getAutoRuns: async () => ++reads < 3 ? oldRun : schedule("Generate Architecture"),
  }), "project", { ...options, consumed });
  assert.ok(reads >= 3);
  assert.deepEqual(buildSuggestedAgentChoices("project", result.suggestion.agents, undefined, result.suggestion.buttons)
    .map(choice => choice.label), ["Generate Architecture"]);
});

test("retiring a running action does not hide the same label at a new checkpoint", async () => {
  const result = await waitForWorkflowCheckpoint(fake({
    streamProjectEvents: async (_id, cb) => {
      await new Promise<void>(resolve => {
        cb.onRaw?.(JSON.stringify({ ...action(), message_id: "old" }));
        cb.onRaw?.(JSON.stringify({ type: "agent_log", agent_type: "Design Agent",
          action: "started", created_at: new Date().toISOString() }));
        const timer = setTimeout(() => cb.onRaw?.(JSON.stringify({ ...action(),
          message_id: "new", status: "paused_for_review" })), 10);
        cb.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    },
  }), "project", options);
  assert.equal(result.status, "checkpoint");
  assert.equal(result.suggestion.messageId, "new");
});

test("credit-filtered tasks still expose Build Tasks and Review after planning", async () => {
  const phaseTasks = [{ id: "task", title: "Calculator" }];
  const result = await waitForWorkflowCheckpoint(fake({
    getPlanningStatus: async () => ({ is_active: false, pm_step_status: "done" }),
    getBuildPhaseExecutionState: async () => ({ can_start: false, all_completed: false,
      current_phase: { id: "phase" }, runnable_tasks: [], phase_tasks: phaseTasks,
      blocking_reason: "insufficient_credits" }),
  }), "project", options);
  assert.equal(result.status, "ready_to_build");
  assert.deepEqual(result.suggestion.agents, ["start_building", "review"]);
  assert.deepEqual(result.tasks, phaseTasks);
});

test("automatic observation returns untimed Generate All Pages with its exact resume phase", async () => {
  const buttons = [{ key: "continue", action: "resume_design", label: "Generate All Pages", payload: { phase: "first_page" } },
    { key: "review", action: "review", label: "Review" }];
  const result = await waitForWorkflowCheckpoint(fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: {
      agents: ["continue", "review"], message_id: "all-pages", buttons,
    } }),
    getPlanningStatus: async () => ({ is_active: false, pm_step_status: "pending", pipeline_run_status: "paused_review" }),
  }), "project", { ...options, followAutomaticStages: true });
  assert.equal(result.status, "checkpoint");
  assert.deepEqual(buildSuggestedAgentChoices("project", result.suggestion.agents, undefined, result.suggestion.buttons)
    .map(choice => choice.label), ["Generate All Pages", "Review"]);
  assert.equal(result.suggestion.buttons?.[0].payload.phase, "first_page");
});

test("a delayed timer keeps automatic observation running instead of returning a manual action", async () => {
  let reads = 0;
  const result = await waitForWorkflowCheckpoint(fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: action("Generate First Page") }),
    getPlanningStatus: async () => ({ is_active: false, pipeline_run_status: "paused_review" }),
    getAutoRuns: async () => ++reads < 4 ? { auto_runs: [] } : schedule("Generate First Page"),
  }), "project", { ...options, followAutomaticStages: true, scheduleGraceMs: 80, timeoutMs: 120 });
  assert.equal(result.status, "running");
  assert.ok(reads >= 4);
});

test("a paused first-page review uses the latest structured suggested-agent array when pending agents are null", async () => {
  const result = await waitForWorkflowCheckpoint(fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: null,
      messages: [{ id: "first-page-ready", author: "assistant", suggested_agents: ["generate_all_pages"],
        buttons: [{ key: "continue", action: "resume_design", label: "Generate All Pages", payload: { phase: "first_page" } }] }],
    }),
    getPlanningStatus: async () => ({ is_active: false, pm_step_status: "pending", pipeline_run_status: "paused_review" }),
  }), "project", { ...options, followAutomaticStages: true });
  assert.equal(result.status, "checkpoint");
  assert.equal(result.suggestion.messageId, "first-page-ready");
  assert.deepEqual(buildSuggestedAgentChoices("project", result.suggestion.agents, undefined, result.suggestion.buttons)
    .map(choice => choice.label), ["Generate All Pages"]);
});

test("latest reply recovery never scans older offers or guesses an action from completion text", async () => {
  const { extractLatestReplySuggestion } = await import("../src/suggested-agents.ts");
  assert.deepEqual(extractLatestReplySuggestion([
    { author: "assistant", content: "Click Generate All Pages to continue." },
    { author: "assistant", content: "The architecture is being generated." },
  ]).agents, []);
  assert.deepEqual(extractLatestReplySuggestion([{ author: "assistant", content: "The first page completed." }]).agents, []);
  assert.deepEqual(extractLatestReplySuggestion([{ author: "user", content: "Click Generate All Pages" }]).agents, []);
  assert.deepEqual(extractLatestReplySuggestion([{ author: "assistant", created_at: "2020-01-01T00:00:00Z", content: "Click Generate All Pages" }], Date.now()).agents, []);
  const explicit = extractLatestReplySuggestion([{ id: "current", author: "assistant", buttons: [
    { key: "continue", action: "resume_design", label: "Generate All Pages", payload: { phase: "first_page" } },
  ] }]);
  assert.equal(explicit.buttons?.[0].payload.phase, "first_page");
});

test("an untimed REST suggested_agents array displays its actual action", async () => {
  const result = await waitForWorkflowCheckpoint(fake({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: null,
      suggested_agents: ["generate_all_pages"], message_id: "manual-array",
      suggested_buttons: [{ key: "continue", action: "resume_design", label: "Generate All Pages", payload: { phase: "first_page" } }],
    }),
    getPlanningStatus: async () => ({ is_active: false, pipeline_run_status: "paused_review" }),
  }), "project", { ...options, followAutomaticStages: true });
  assert.equal(result.status, "checkpoint");
  assert.deepEqual(result.suggestion.agents, ["generate_all_pages"]);
  assert.equal(result.suggestion.buttons?.[0].label, "Generate All Pages");
});
