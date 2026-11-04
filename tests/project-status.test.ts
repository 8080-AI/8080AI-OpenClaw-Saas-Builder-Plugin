import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectStatusResponse, latestTechLeadMessage } from "../src/project-status-response.ts";
import { createProjectStatusTool } from "../src/project-status-tool.ts";
import { create8080Command } from "../src/command.ts";
import { writeApiKey } from "../src/api-key.ts";
import { readLatestSuggestions, writeLatestSuggestions } from "../src/suggestions-state.ts";
import { writeActiveProject } from "../src/project-state.ts";
import type { ChatMessage } from "../src/api-client.ts";

const message = (id: string, seconds: number, extra = {}): ChatMessage => ({
  id, project_id: "project", author: "assistant", content: id,
  created_at: `2026-11-04T10:00:${String(seconds).padStart(2, "0")}Z`, ...extra,
});
const gate = { key: "continue", action: "resume_design", label: "Generate First Page", kind: "workflow", payload: { phase: "user_flow" } };
async function state(t: any) {
  const stateDir = await mkdtemp(join(tmpdir(), "8080-status-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir, sessionId: "session", projectId: "project", siteUrl: "https://site.example", modelTier: "super_large" };
}
function client(overrides: Record<string, unknown> = {}) {
  return {
    getProjectStatus: async () => ({ id: "project", phase: "planning", status: "paused_for_review", pending_suggested_agents: null }),
    getProjectChatMessages: async () => [message("Latest Tech Lead reply", 20, { buttons: [gate] })],
    getPlanningStatus: async () => ({ is_active: false, pm_step_status: "pending", pipeline_run_status: "paused_review" }),
    getBuildPhaseExecutionState: async () => ({ can_start: false, all_completed: false, current_phase: null, runnable_tasks: [] }),
    ...overrides,
  } as any;
}

test("latest reply is selected by date and excludes other projects, users, and unrelated agents", () => {
  assert.equal(latestTechLeadMessage([
    message("new", 20), message("old", 10), message("user", 50, { author: "user" }),
    message("other project", 55, { project_id: "other" }), message("Design output", 40, { agent_type: "Design Agent" }),
  ], "project")?.id, "new");
  assert.equal(latestTechLeadMessage([message("old", 10), message("system gate", 25, { author: "system", buttons: [gate] })], "project")?.id, "system gate");
});

test("current reply gate supplies the exact action and resume phase when pending suggestions are null", async t => {
  const options = await state(t);
  const result = await buildProjectStatusResponse(client(), options);
  assert.match(result.text, /Latest Tech Lead message\nLatest Tech Lead reply/);
  assert.match(result.text, /1\. Generate First Page/);
  assert.deepEqual(result.suggestions, ["continue"]);
  const saved = await readLatestSuggestions(options.stateDir, options.sessionId);
  assert.equal(saved?.messageId, "Latest Tech Lead reply");
  assert.equal(saved?.buttons?.[0].payload.phase, "user_flow");
});

test("old actionable replies never resurrect buttons after a newer non-actionable reply", async t => {
  const options = await state(t);
  await writeLatestSuggestions(options.stateDir, options.sessionId, { projectId: "project", messageId: "old", agents: ["continue"] });
  const result = await buildProjectStatusResponse(client({ getProjectChatMessages: async () => [
    message("old", 10, { buttons: [gate] }), message("Still working", 20),
  ] }), options);
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.presentation, undefined);
  assert.deepEqual((await readLatestSuggestions(options.stateDir, options.sessionId))?.agents, []);
});

for (const extra of [{ clicked_buttons: ["continue"] }, { allowed_buttons: [] }, { buttons: [{ ...gate, enabled: false }] }]) {
  test(`unavailable or already selected buttons stay hidden: ${JSON.stringify(extra)}`, async t => {
    const result = await buildProjectStatusResponse(client({ getProjectChatMessages: async () => [message("latest", 20, { buttons: [gate], ...extra })] }), await state(t));
    assert.deepEqual(result.suggestions, []);
  });
}

test("active execution suppresses stale generation buttons", async t => {
  const result = await buildProjectStatusResponse(client({ getPlanningStatus: async () => ({ is_active: true, pipeline_run_status: "running" }) }), await state(t));
  assert.deepEqual(result.suggestions, []);
});

test("backend build readiness overrides earlier design actions and includes all public artifact links", async t => {
  const result = await buildProjectStatusResponse(client({
    getPlanningStatus: async () => ({ is_active: false, pm_step_status: "done" }),
    getBuildPhaseExecutionState: async () => ({ can_start: true, all_completed: false, current_phase: { id: "phase" }, runnable_tasks: [{}] }),
    getArtifactShareSnapshot: async () => ({ requirements: { content: "SRD" }, flows: [{ mermaid_content: "graph TD" }],
      pages: [{ id: "home", has_compiled_html: true }], diagrams: [{ content: "diagram" }],
      tasks: [{ task_type: "development", creation_source: "system" }], planning: { pm_step_status: "done" }, logs: [] }),
    createArtifactShare: async (_project: string, type: string) => ({ share_id: `share-${type}`, is_public: true }),
  }), await state(t));
  assert.deepEqual(result.suggestions, ["start_building", "review"]);
  assert.match(result.text, /1\. Build Tasks\n2\. Review/);
  assert.equal((result.text.match(/https:\/\/site.example\/shared\/artifacts\//g) ?? []).length, 5);
});

test("blocked Build Tasks is removed even when stale pending suggestions still offer it", async t => {
  const result = await buildProjectStatusResponse(client({
    getProjectStatus: async () => ({ phase: "planning", pending_suggested_agents: { agents: ["start_building"] } }),
  }), await state(t));
  assert.deepEqual(result.suggestions, []);
});

test("a messages failure preserves status and its authoritative pending actions", async t => {
  const result = await buildProjectStatusResponse(client({
    getProjectChatMessages: async () => { throw new Error("unavailable"); },
    getProjectStatus: async () => ({ phase: "planning", pending_suggested_agents: { agents: ["continue"], buttons: [gate] } }),
  }), await state(t));
  assert.match(result.text, /latest Tech Lead message could not be loaded/);
  assert.match(result.text, /1\. Generate First Page/);
});

test("slash and natural-language status use the scoped messages API and return identical replies, buttons, and links", async t => {
  const options = await state(t);
  const issuedAt = Date.now();
  const key = `sk-8080ai-${Buffer.from(JSON.stringify({ uid: "test", ts: new Date(issuedAt).toISOString() })).toString("base64url")}`;
  await writeApiKey(options.stateDir, key, { uid: "test", issuedAt, expiresAt: null });
  await writeActiveProject(options.stateDir, "project", "session");
  const requests: { url: string; method: string }[] = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push({ url: url.href, method: init?.method ?? "GET" });
    if (url.pathname === "/chat/messages") {
      assert.equal(url.searchParams.get("project_id"), "project");
      assert.equal(url.searchParams.has("session_id"), false, "OpenClaw session IDs must not restrict project history");
      return Response.json({ messages: [message("Latest reply", 20, { buttons: [gate] }), message("User question", 30, { author: "user" })] });
    }
    if (url.pathname === "/projects/project") return Response.json({ id: "project", phase: "planning", pending_suggested_agents: null });
    if (url.pathname.endsWith("/auto-runs")) return Response.json({ auto_runs: [] });
    if (url.pathname === "/chat/planning-status") return Response.json({ is_active: false, pm_step_status: "pending" });
    if (url.pathname.endsWith("/build-phases/execution-state")) return Response.json({ can_start: false, all_completed: false, runnable_tasks: [] });
    if (url.pathname.endsWith("/requirements")) return Response.json({ content: "SRD" });
    if (url.pathname.endsWith("/user-flows")) return Response.json({ user_flows: [{ mermaid_content: "graph TD" }] });
    if (url.pathname.endsWith("/agent-logs")) return Response.json([]);
    if (url.pathname.endsWith("/artifact-shares")) return Response.json({ share_id: `public-${JSON.parse(String(init?.body)).artifact_type}`, is_public: true });
    return new Response("Not found", { status: 404 });
  };
  const deps = { stateDir: () => options.stateDir, apiBaseUrl: "https://api.example", siteUrl: options.siteUrl, sessionId: "session" };
  const natural = await createProjectStatusTool(deps).execute("status", {}, undefined, () => {});
  const command = create8080Command({ runtime: { state: { resolveStateDir: deps.stateDir } } }, deps);
  const slash = await command.handler({ args: "status" });
  assert.equal(slash.text, natural.content[0].text);
  assert.deepEqual(slash.presentation, natural.presentation);
  assert.equal(natural.details?.exactUserResponse, slash.text);
  assert.match(slash.text, /Latest Tech Lead message\nLatest reply/);
  assert.match(slash.text, /public-requirements/); assert.match(slash.text, /public-user-flow/);
  assert.match(slash.text, /1\. Generate First Page/);
  assert.equal(requests.filter(request => new URL(request.url).pathname === "/chat/messages").length, 2);
  assert.ok(requests.filter(request => request.method === "POST").every(request => request.url.endsWith("/artifact-shares")), "status never triggers generation");
});

test("clicked message metadata overrides an obsolete pending agent array for the same gate", async t => {
  const result = await buildProjectStatusResponse(client({
    getProjectStatus: async () => ({ phase: "planning", pending_suggested_agents: { agents: ["continue"], message_id: "latest", buttons: [gate] } }),
    getProjectChatMessages: async () => [message("latest", 20, { buttons: [gate], clicked_buttons: ["continue"] })],
  }), await state(t));
  assert.deepEqual(result.suggestions, []);
});

test("completed artifacts remain linked when no manual actions are available", async t => {
  const result = await buildProjectStatusResponse(client({
    getProjectChatMessages: async () => [message("Finished", 20)],
    getArtifactShareSnapshot: async () => ({ requirements: { content: "Completed SRD" }, logs: [] }),
    createArtifactShare: async () => ({ share_id: "completed-srd", is_public: true }),
  }), await state(t));
  assert.deepEqual(result.suggestions, []);
  assert.match(result.text, /completed-srd/);
  assert.equal(result.presentation, undefined);
});
