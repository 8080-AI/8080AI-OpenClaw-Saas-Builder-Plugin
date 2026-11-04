import test from "node:test";
import assert from "node:assert/strict";
import { findLatestRunningDesignLog } from "../src/continue-project-tool.ts";
import { extractEventSuggestion, mergeSuggestedButtons } from "../src/suggested-agents.ts";
import { buildSuggestedAgentChoices } from "../src/review-continue.ts";

test("completed user-flow planning cannot be mistaken for a running design", () => {
  assert.equal(findLatestRunningDesignLog([
    { agent_type: "User Flow Planner", action: "completed", message_id: "flow", created_at: "2026-10-29T05:18:47" },
    { agent_type: "User Flow Planner", action: "started", summary: "Designing screen flows per persona...", message_id: "flow", created_at: "2026-10-29T05:18:24" },
  ]), undefined);
});

for (const action of ["completed", "failed", "cancelled"]) {
  test(`a newer ${action} supersedes a design start regardless of array order`, () => {
    const started = { agent_type: "Design Agent", action: "started", message_id: "resume-design", created_at: "2026-10-29T05:18:24" };
    const terminal = { ...started, action, created_at: "2026-10-29T05:18:47" };
    assert.equal(findLatestRunningDesignLog([started, terminal]), undefined);
    assert.equal(findLatestRunningDesignLog([terminal, started]), undefined);
    const restarted = { ...started, created_at: "2026-10-29T05:19:00" };
    assert.equal(findLatestRunningDesignLog([terminal, restarted]), restarted);
  });
}

test("live nested workflow buttons supply their actual label and replace old status buttons", () => {
  const button = { action: "resume_design", label: "Generate First Page", key: "continue" };
  const event = extractEventSuggestion({ type: "suggested_agents", pending_suggested_agents: { buttons: [button], message_id: "live" } });
  assert.deepEqual(event.agents, ["continue"]);
  const buttons = mergeSuggestedButtons(event.buttons, [{ ...button, label: "Generate Architecture" }]);
  assert.deepEqual(buttons, [button]);
  assert.deepEqual(buildSuggestedAgentChoices("project", event.agents, undefined, buttons).map(choice => choice.label), ["Generate First Page"]);
  assert.deepEqual(mergeSuggestedButtons([], [button]), []);
});

test("continue results use normal response delivery and protect against status lookups", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createContinueProjectTool } = await import("../src/continue-project-tool.ts");
  const stateDir = await mkdtemp(join(tmpdir(), "8080-continue-"));
  try {
    const tool = createContinueProjectTool({ stateDir: () => stateDir, apiBaseUrl: "http://unused.invalid", sessionId: "test" });
    const result = await tool.execute("test", {}, undefined, () => {});
    assert.equal("terminate" in result && result.terminate, false);
    assert.equal(result.details.turnComplete, undefined);
    assert.equal(result.details.protectFromStatusLookup, true);
    assert.equal(result.details.exactUserResponse, result.content[0].text);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
