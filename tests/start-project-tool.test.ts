import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeApiKey } from "../src/api-key.ts";
import { readLatestSuggestions } from "../src/suggestions-state.ts";
import { createStartProjectTool } from "../src/start-project-tool.ts";

for (const mode of ["timed-running", "timed-build-ready", "manual-start"] as const) {
  test(`project creation handles ${mode} without displaying a timed Start as a manual action`, async t => {
    const stateDir = await mkdtemp(join(tmpdir(), "8080-create-observe-"));
    const issuedAt = Date.now();
    await writeApiKey(stateDir, `sk-8080ai-${Buffer.from(JSON.stringify({ uid: "test", ts: new Date(issuedAt).toISOString() })).toString("base64url")}`,
      { uid: "test", issuedAt, expiresAt: null });
    const oldFetch = globalThis.fetch;
    t.after(async () => { globalThis.fetch = oldFetch; await rm(stateDir, { recursive: true, force: true }); });
    const requests: { url: string; method: string }[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/chat/messages")) return Response.json({ project_id: "project" });
      if (url.endsWith("/stream-trigger")) return new Response([
        { type: "token", content: "Planning starts automatically in 20 seconds." },
        { type: "suggested_agents", agents: ["plan_all"], message_id: "start-offer" },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
      if (url.endsWith("/projects/project")) return Response.json({ id: "project", pending_suggested_agents: {
        agents: ["plan_all"], message_id: "start-offer", buttons: [
          { key: "start", action: "trigger_agents", label: "Start", payload: { agents: ["plan_all"] } },
        ],
      } });
      if (url.endsWith("/auto-runs")) {
        const now = Date.now();
        return Response.json({ server_now: new Date(now).toISOString(), auto_runs: mode === "manual-start" ? [] : [
          { entry_id: "start-offer", button_key: "start", label: "Start", status: "scheduled", fire_at: new Date(now + 20000).toISOString() },
        ] });
      }
      if (url.includes("planning-status")) return Response.json({ is_active: mode === "timed-running", pm_step_status: mode === "timed-build-ready" ? "done" : "pending" });
      if (url.includes("execution-state")) return Response.json({ can_start: mode === "timed-build-ready", all_completed: false,
        current_phase: mode === "timed-build-ready" ? { id: "phase" } : null,
        runnable_tasks: mode === "timed-build-ready" ? [{ id: "task", title: "Build calculator", status: "todo" }] : [] });
      if (url.endsWith("/agent-logs") || url.endsWith("/tasks")) return Response.json([]);
      if (url.endsWith("/events")) return new Response("", { headers: { "Content-Type": "text/event-stream" } });
      throw new Error(`Unexpected request: ${url}`);
    };
    const updates: any[] = [];
    const tool = createStartProjectTool({ stateDir: () => stateDir, apiBaseUrl: "http://localhost", pollingTimeoutMs: 600000, sessionId: "session" });
    const result = await tool.execute("create", { user_raw_prompt: "Create a calculator", timeoutMs: mode === "timed-running" ? 5001 : 10000 }, undefined, update => updates.push(update));
    assert.equal(requests.filter(request => request.method === "POST").length, 2, "only create and Tech Lead stream are submitted; Start is never submitted again");
    const text = result.content[0].text;
    if (mode === "manual-start") {
      assert.match(text, /Suggested Next Steps:\n1\. Start/);
      assert.equal(requests.some(request => request.url.endsWith("/events")), false);
    } else {
      assert.doesNotMatch(text, /\d+\. Start/);
      if (mode === "timed-running") {
        assert.equal(result.details.status, "running");
        assert.equal((result.details.nextTool as any).arguments.observeOnly, true);
        assert.ok(updates.some(update => /Next: Start/.test(update.content[0].text)));
        const saved = await readLatestSuggestions(stateDir, "session");
        assert.deepEqual(saved?.agents, []);
        assert.ok(saved?.observation);
      } else {
        assert.equal(result.details.status, "ready_to_build");
        assert.match(text, /Build Tasks/);
      }
    }
  });
}
