import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeApiKey } from "../src/api-key.ts";
import { writeLatestSuggestions } from "../src/suggestions-state.ts";
import { createSelectButtonTool } from "../src/select-button-tool.ts";
import { createContinueProjectTool } from "../src/continue-project-tool.ts";

for (const continueObservation of [false, true]) {
  test(`Start follows every automatic stage and shows only final Build Tasks (continuation: ${continueObservation})`, async t => {
    const stateDir = await mkdtemp(join(tmpdir(), "8080-auto-pipeline-"));
    const issuedAt = Date.now();
    await writeApiKey(stateDir, `sk-8080ai-${Buffer.from(JSON.stringify({ uid: "test", ts: new Date(issuedAt).toISOString() })).toString("base64url")}`,
      { uid: "test", issuedAt, expiresAt: null });
    await writeLatestSuggestions(stateDir, "session", { projectId: "project", agents: ["plan_all"], messageId: "start" });
    let streamReads = 0;
    let finished = false;
    const requests: { url: string; method: string }[] = [];
    const oldFetch = globalThis.fetch;
    t.after(async () => { globalThis.fetch = oldFetch; await rm(stateDir, { recursive: true, force: true }); });
    const task = { id: "task", title: "Implement calculator", status: "todo" };
    const agent = (name: string, action: string, run: string) => ({
      type: "agent_log", agent_type: name, action, message_id: run, summary: `${name} ${action}`,
      created_at: new Date().toISOString(),
    });
    const scheduled = (label: string) => {
      const now = Date.now();
      return { type: "suggested_agents", agents: ["continue"], status: "paused_for_review", message_id: label,
        buttons: [{ key: "continue", action: "resume_design", label },
          { kind: "auto_run", action: "wait_auto_run", payload: { entry_id: label, status: "scheduled", button_key: "continue", label,
            fire_at: new Date(now + 100).toISOString(), server_now: new Date(now).toISOString() } }] };
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/chat/trigger-agents")) return Response.json({ status: "triggered" });
      if (url.endsWith("/events")) {
        let events: unknown[] = [];
        switch (++streamReads) {
          case 1: events = [agent("System Requirements Agent", "started", "planning"), agent("System Requirements Agent", "completed", "planning")]; break;
          case 2: events = [scheduled("Generate First Page")]; break;
          case 3: events = [agent("Design Agent", "started", "first"), agent("Design Agent", "completed", "first"), scheduled("Generate All Pages")]; break;
          case 4: events = [agent("Design Agent", "started", "all"), agent("Design Agent", "completed", "all"), scheduled("Generate Architecture")]; break;
          default:
            finished = true;
            events = [agent("System Architect", "started", "architecture"), agent("System Architect", "completed", "architecture"),
              agent("Project Manager", "completed", "tasks"), { type: "planning_complete", status: "completed" }];
        }
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.endsWith("/auto-runs")) return Response.json({ auto_runs: [] });
      if (url.endsWith("/agent-logs")) return Response.json([]);
      if (url.endsWith("/tasks")) return Response.json(finished ? [task] : []);
      if (url.includes("planning-status")) return Response.json({ is_active: !finished, pm_step_status: finished ? "done" : "pending" });
      if (url.includes("execution-state")) return Response.json(finished
        ? { can_start: true, all_completed: false, current_phase: { id: "phase" }, runnable_tasks: [task] }
        : { can_start: false, runnable_tasks: [], blocking_reason: "task_plan_missing" });
      if (url.endsWith("/projects/project")) return Response.json({ id: "project", pending_suggested_agents: null });
      throw new Error(`Unexpected request: ${url}`);
    };
    const deps = { stateDir: () => stateDir, apiBaseUrl: "http://localhost", sessionId: "session", siteUrl: "http://localhost" };
    const updates: any[] = [];
    let result = await createSelectButtonTool(deps).execute("start", { choice: "Start", timeoutMs: continueObservation ? 5001 : 10000 }, undefined, update => updates.push(update));
    if (continueObservation) {
      assert.equal(result.details.status, "running");
      const next = result.details.nextTool as any;
      assert.equal(next.arguments.observeOnly, true);
      result = await createContinueProjectTool(deps).execute("observe", { ...next.arguments, timeoutMs: 10000 }, undefined, update => updates.push(update));
    }
    assert.equal(result.details.status, "ready_to_build");
    assert.match(result.content[0].text, /Build Tasks/);
    assert.match(result.content[0].text, /Implement calculator/);
    assert.equal(requests.filter(request => request.method === "POST").length, 1, "automatic transitions must never submit more work");
    for (const label of ["Start", "Generate First Page", "Generate All Pages", "Generate Architecture"]) {
      assert.ok(updates.some(update => update.content[0].text.includes(`**${label}**`)), `${label} appears in progress`);
    }
    const progressUpdates = updates.filter(update => update.details?.status === "running");
    assert.ok(progressUpdates.some(update => /System Requirements Agent: (running|completed)/.test(update.content[0].text)));
    assert.ok(progressUpdates.some(update => /automatically triggers in/.test(update.content[0].text)));
    assert.ok(progressUpdates.every(update => !/Suggested Next Steps|Build Tasks|1\. Wait/.test(update.content[0].text)));
    assert.deepEqual(result.presentation?.blocks.find((block: any) => block.type === "buttons")?.buttons.map((button: any) => button.label), ["Build Tasks", "Review"]);
  });
}

test("an untimed backend reply displays manual buttons even with null pending agents", async t => {
  const { waitForProjectResponse } = await import("../src/workflow-response.ts");
  const { readLatestSuggestions } = await import("../src/suggestions-state.ts");
  const stateDir = await mkdtemp(join(tmpdir(), "8080-manual-checkpoint-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const shared: string[] = [];
  const result = await waitForProjectResponse({
    getArtifactShareSnapshot: async () => ({
      requirements: { content: "# SRD" }, flows: [{ mermaid_content: "graph TD; A-->B" }],
      pages: [{ id: "home", has_compiled_html: true, sections_total: 1, sections_done: 1 }], logs: [],
    }),
    createArtifactShare: async (_id: string, type: string) => {
      shared.push(type);
      return { share_id: `link-${type}`, is_public: true };
    },
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: null, messages: [{
      author: "assistant", id: "all-pages", agents: ["continue", "review"], buttons: [
        { key: "continue", action: "resume_design", label: "Generate All Pages", payload: { phase: "first_page" } },
      ],
    }] }),
    getAutoRuns: async () => ({ auto_runs: [] }),
    getAgentLogs: async () => [], getTasks: async () => [],
    getPlanningStatus: async () => ({ is_active: false, pm_step_status: "pending", pipeline_run_status: "paused_review" }),
    getBuildPhaseExecutionState: async () => ({ can_start: false, all_completed: false, runnable_tasks: [] }),
    streamProjectEvents: async (_id, cb) => new Promise<void>(resolve => cb.signal?.addEventListener("abort", () => resolve(), { once: true })),
  } as any, { stateDir, sessionId: "session", projectId: "project", siteUrl: "https://custom.example", modelTier: "super_large", timeoutMs: 15000 });
  assert.equal(result.details.status, "checkpoint");
  assert.deepEqual(shared, ["requirements", "user-flow", "design"]);
  assert.match(result.content[0].text, /https:\/\/custom.example\/shared\/artifacts\/link-design/);
  assert.equal(result.details.exactUserResponse, result.content[0].text);
  assert.deepEqual(result.presentation?.blocks.find((block: any) => block.type === "buttons")?.buttons.map((button: any) => button.label), ["Generate All Pages", "Review"]);
  assert.match(result.content[0].text, /Generation paused for your action/);
  assert.match(result.content[0].text, /1\. Generate All Pages\n2\. Review/);
  assert.doesNotMatch(result.content[0].text, /Generation complete|No further generation clicks|Build Tasks/);
  assert.equal(result.details.nextTool, undefined);
  const saved = await readLatestSuggestions(stateDir, "session");
  assert.equal(saved?.buttons?.[0].payload.phase, "first_page");
  assert.equal(saved?.observation, undefined);
});

test("read windows renew internally until Build Tasks instead of returning a running result to the model", async t => {
  const { waitForProjectResponse } = await import("../src/workflow-response.ts");
  const stateDir = await mkdtemp(join(tmpdir(), "8080-window-renewal-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let windows = 0;
  let closed = 0;
  const result = await waitForProjectResponse({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: null }),
    getAutoRuns: async () => ({ auto_runs: [] }), getAgentLogs: async () => [], getTasks: async () => [],
    getPlanningStatus: async () => ({ is_active: ++windows < 3, pm_step_status: windows < 3 ? "pending" : "done" }),
    getBuildPhaseExecutionState: async () => ({ can_start: windows >= 3, all_completed: false,
      current_phase: windows >= 3 ? { id: "phase" } : null,
      runnable_tasks: windows >= 3 ? [{ id: "task", status: "todo", title: "Implement calculator" }] : [] }),
    streamProjectEvents: async (_id, cb) => new Promise<void>(resolve => {
      cb.signal?.addEventListener("abort", () => { closed++; resolve(); }, { once: true });
    }),
  } as any, { stateDir, sessionId: "session", projectId: "project", modelTier: "super_large", timeoutMs: 6000, observationWindowMs: 15 });
  assert.ok(windows >= 3);
  assert.equal(result.details.status, "ready_to_build");
  assert.equal(result.details.nextTool, undefined);
  assert.match(result.content[0].text, /Build Tasks/);
  assert.equal(closed, windows, "every finished window cleans up its stream");
});

test("host-limit handoff is model-visible but not copied into the user-facing response", async t => {
  const { waitForProjectResponse } = await import("../src/workflow-response.ts");
  const stateDir = await mkdtemp(join(tmpdir(), "8080-observer-handoff-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const result = await waitForProjectResponse({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: null }),
    getAutoRuns: async () => ({ auto_runs: [] }), getAgentLogs: async () => [], getTasks: async () => [],
    getPlanningStatus: async () => ({ is_active: true, pm_step_status: "pending" }),
    getBuildPhaseExecutionState: async () => ({ can_start: false, all_completed: false, runnable_tasks: [] }),
    streamProjectEvents: async (_id, cb) => new Promise<void>(resolve => cb.signal?.addEventListener("abort", () => resolve(), { once: true })),
  } as any, { stateDir, sessionId: "session", projectId: "project", modelTier: "super_large", timeoutMs: 5001 });
  assert.equal(result.details.status, "running");
  assert.match(result.details.exactUserResponse, /Project: `project`/);
  assert.match(result.details.exactUserResponse, /has not reached a manual checkpoint/);
  assert.doesNotMatch(result.details.exactUserResponse, /tool observation limit was reached/);
  assert.match(result.content[0].text, /Call ai8080_continue_project/);
  assert.match(result.content[0].text, /"observeOnly":true/);
  assert.doesNotMatch(result.details.exactUserResponse, /Tool continuation instruction|Call ai8080_continue_project/);
  assert.doesNotMatch(result.details.exactUserResponse, /Continuing observation of the same generation/);
});
