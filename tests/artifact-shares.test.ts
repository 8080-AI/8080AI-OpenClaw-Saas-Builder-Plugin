import test from "node:test";
import assert from "node:assert/strict";
import { availableArtifactTypes, buildSuggestedAgentsTextWithShares, getArtifactShareText, type ArtifactShareSnapshot, type ArtifactType } from "../src/artifact-shares.ts";
import { createApiClient } from "../src/api-client.ts";

const before = "2026-11-04T10:00:00Z";
const started = "2026-11-04T10:01:00Z";
const saved = "2026-11-04T10:02:00Z";
const finished = "2026-11-04T10:03:00Z";
function snapshot(): ArtifactShareSnapshot {
  return {
    requirements: { content: "# SRD", updated_at: saved },
    flows: { user_flows: [{ mermaid_content: "flowchart TD; A-->B", updated_at: saved }] },
    pages: [{ id: "page", compiled_html: "<main>Hello</main>", sections_total: 2, sections_done: 2 }],
    diagrams: { service_network: [{ content: "graph TD; A-->B", updated_at: saved }] },
    tasks: [{ task_type: "development", creation_source: "system" }],
    planning: { pm_step_status: "done" },
    logs: ["System Requirements Agent", "User Flow Planner", "System Architect"].flatMap(agent_type => [
      { agent_type, action: "started", created_at: started },
      { agent_type, action: "completed", created_at: finished },
    ]),
  };
}

function clientFor(data: ArtifactShareSnapshot) {
  const created: ArtifactType[] = [];
  return {
    created,
    getArtifactShareSnapshot: async () => data,
    createArtifactShare: async (_projectId: string, type: ArtifactType) => {
      created.push(type);
      return { share_id: `share-${type}`, is_public: true };
    },
  };
}

test("Generate First Page includes only the completed SRD and user flow links", async () => {
  const data = snapshot();
  data.pages = []; data.diagrams = {}; data.tasks = [];
  const client = clientFor(data);
  const response = await buildSuggestedAgentsTextWithShares(client, "https://preview.example/path/", "project", ["generate_first_page", "review"]);
  assert.deepEqual(client.created, ["requirements", "user-flow"]);
  assert.match(response, /\[SRD document\]\(https:\/\/preview.example\/shared\/artifacts\/share-requirements\)/);
  assert.match(response, /\[User flow\]/);
  assert.match(response, /1\. Generate First Page\n2\. Review/);
  assert.doesNotMatch(response, /\[Design\]|\[Architecture\]|\[Tasks\]/);
});

test("Build Tasks includes all five ready artifacts in a stable order", async () => {
  const client = clientFor(snapshot());
  const response = await buildSuggestedAgentsTextWithShares(client, undefined, "project", ["start_building", "review"]);
  assert.deepEqual(client.created, ["requirements", "user-flow", "design", "architecture", "tasks"]);
  assert.equal((response.match(/https:\/\/8080.ai\/shared\/artifacts\//g) ?? []).length, 5);
  assert.match(response, /1\. Build Tasks\n2\. Review/);
});

test("current incomplete writes are hidden, but older accepted artifacts remain available", () => {
  const data = snapshot();
  data.logs = (data.logs as any[]).filter(log => log.action === "started");
  assert.deepEqual(availableArtifactTypes(data), ["design", "tasks"]);
  data.requirements = { content: "Previous accepted SRD", updated_at: before };
  data.flows = [{ mermaid_content: "previous flow", updated_at: before }];
  data.diagrams = [{ content: "previous architecture", updated_at: before }];
  assert.deepEqual(availableArtifactTypes(data), ["requirements", "user-flow", "design", "architecture", "tasks"]);
});

test("SRD awaiting_review and flow/architecture completion markers allow sharing", () => {
  const data = snapshot();
  data.logs = [
    ...(data.logs as any[]).filter(log => log.action === "started"),
    { agent_type: "System Requirements Agent", action: "awaiting_review", created_at: finished },
  ];
  data.timeline = ["user-flow", "architecture"].map(artifact_type => ({ artifact_type, timestamp: finished }));
  assert.equal(availableArtifactTypes(data).length, 5);
});

test("comments-only SRD and empty diagrams/flows are not shared", () => {
  const data = snapshot();
  data.requirements = { content: " <!-- metadata --> \n" };
  data.flows = [{ mermaid_content: " " }]; data.diagrams = { sequence: [{ content: " " }] };
  assert.deepEqual(availableArtifactTypes(data), ["design", "tasks"]);
});

for (const patch of [
  { generation_in_progress: true }, { generation_failed: true }, { credit_blocked: true },
  { planned: true }, { id: "planned-page" }, { id: "virtual:page" },
  { missing_sections_json: ["footer"] }, { missing_sections_json: "footer" },
  { sections_done: 1 }, { compiled_html: "", jsx_content: "", has_compiled_html: false, has_jsx_content: false },
]) {
  test(`unfinished design is excluded: ${JSON.stringify(patch)}`, () => {
    const data = snapshot();
    data.pages = [{ ...(data.pages as any[])[0], ...patch }];
    assert.ok(!availableArtifactTypes(data).includes("design"));
  });
}

test("one completed page is sufficient even while another page generates", () => {
  const data = snapshot();
  (data.pages as any[]).push({ id: "another", compiled_html: "<main/>", generation_in_progress: true });
  assert.ok(availableArtifactTypes(data).includes("design"));
});

test("tasks require a non-planning system task and a completed PM contract", () => {
  for (const pm_step_status of ["running", "pending", "failed"]) {
    const data = snapshot(); data.planning = { pm_step_status };
    assert.ok(!availableArtifactTypes(data).includes("tasks"));
  }
  for (const pm_step_status of ["done", "skipped", null, undefined]) {
    const data = snapshot(); data.planning = { pm_step_status };
    assert.ok(availableArtifactTypes(data).includes("tasks"));
  }
  const data = snapshot(); data.tasks = [{ task_type: "planning", creation_source: "system" }, { creation_source: "user" }];
  assert.ok(!availableArtifactTypes(data).includes("tasks"));
  data.tasks = [{ task_type: "development", creation_source: "system" }]; data.planning = undefined;
  assert.ok(!availableArtifactTypes(data).includes("tasks"));
});

test("failed log lookup cannot expose a possibly unfinished write", () => {
  const data = snapshot(); data.logs = undefined;
  assert.deepEqual(availableArtifactTypes(data), ["design", "tasks"]);
});

test("private shares, malformed shares, and per-artifact failures leave other links and actions intact", async () => {
  const client = {
    getArtifactShareSnapshot: async () => snapshot(),
    createArtifactShare: async (_id: string, type: ArtifactType) => {
      if (type === "requirements") throw new Error("Forbidden");
      if (type === "user-flow") return { share_id: "private", is_public: false };
      if (type === "design") return { share_id: "", is_public: true };
      return { share_id: `share-${type}`, is_public: true };
    },
  };
  const response = await buildSuggestedAgentsTextWithShares(client, undefined, "project", ["start_building"]);
  assert.match(response, /\[Architecture\]/); assert.match(response, /\[Tasks\]/);
  assert.doesNotMatch(response, /private|\[SRD document\]|\[Design\]/);
  assert.match(response, /1\. Build Tasks/);
});

test("no usable artifacts or a failed snapshot does not create shares or hide actions", async () => {
  const client = clientFor({});
  assert.equal(await getArtifactShareText(client, "project"), ""); assert.deepEqual(client.created, []);
  client.getArtifactShareSnapshot = async () => { throw new Error("Unavailable"); };
  const response = await buildSuggestedAgentsTextWithShares(client, undefined, "project", ["continue"]);
  assert.match(response, /1\. Continue/); assert.doesNotMatch(response, /Public artifact links/);
});

test("a question or empty suggestions never creates public shares", async () => {
  const client = clientFor(snapshot());
  assert.equal(await buildSuggestedAgentsTextWithShares(client, undefined, "project", ["continue"], "Which layout?"), "");
  await buildSuggestedAgentsTextWithShares(client, undefined, "project", []);
  assert.deepEqual(client.created, []);
});

test("artifact API uses scoped OpenClaw authentication and category-wide selections", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests: { url: string; init?: RequestInit }[] = [];
  const data = snapshot();
  globalThis.fetch = async (input, init) => {
    const url = String(input); requests.push({ url, init });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body, { artifact_type: body.artifact_type, item_id: null, subview: null });
      assert.equal(new Headers(init.headers).get("X-OpenClaw-API-Key"), "test-key");
      assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
      assert.equal(new Headers(init.headers).has("Authorization"), false);
      return Response.json({ share_id: `share-${body.artifact_type}`, is_public: true });
    }
    const values: Record<string, unknown> = { requirements: data.requirements, "user-flows": data.flows,
      "design-pages": data.pages, architecture: data.diagrams, tasks: data.tasks, "agent-logs": data.logs };
    if (url.includes("/chat/planning-status")) return Response.json(data.planning);
    return Response.json(values[url.split("/").at(-1)!] ?? { timeline: [] });
  };
  const client = createApiClient({ apiKey: "test-key", apiBaseUrl: "https://api.example/api/v1" });
  const result = await getArtifactShareText(client, "project/id", "https://site.example");
  assert.equal((result.match(/shared\/artifacts/g) ?? []).length, 5);
  assert.equal(requests.filter(request => request.init?.method === "POST").length, 5);
  assert.ok(requests.filter(request => request.init?.method === "POST").every(request => request.url.endsWith("/projects/project%2Fid/artifact-shares")));
});

test("a failed artifact read does not prevent the remaining public links", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") return Response.json({ share_id: "requirements-link", is_public: true });
    if (url.endsWith("/requirements")) return Response.json({ content: "# Saved SRD" });
    if (url.endsWith("/agent-logs")) return Response.json([]);
    return new Response("Unavailable", { status: 503 });
  };
  const result = await getArtifactShareText(createApiClient({ apiKey: "test-key", apiBaseUrl: "https://api.example/api/v1" }), "project");
  assert.match(result, /SRD document/); assert.doesNotMatch(result, /User flow|Architecture|Tasks|Design/);
});

test("API completion timeline markers can unlock a current flow without a completed log", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") return Response.json({ share_id: "flow-link", is_public: true });
    if (url.endsWith("/user-flows")) return Response.json({ user_flows: [{ mermaid_content: "graph TD; A-->B", updated_at: saved }] });
    if (url.endsWith("/agent-logs")) return Response.json([{ agent_type: "User Flow Planner", action: "started", created_at: started }]);
    if (url.endsWith("/ai-overview")) return Response.json({ logs: [{ artifact_type: "user-flow", created_at: finished }] });
    return new Response("Not found", { status: 404 });
  };
  const result = await getArtifactShareText(createApiClient({ apiKey: "test-key", apiBaseUrl: "https://api.example/api/v1" }), "project");
  assert.match(result, /\[User flow\].*flow-link/);
});
