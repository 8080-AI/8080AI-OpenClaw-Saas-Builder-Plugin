import test from "node:test";
import assert from "node:assert/strict";
import { getCheckpointButtons } from "../src/checkpoint-auto-runs.ts";
import { buildSuggestedAgentChoices } from "../src/review-continue.ts";

for (const label of ["Generate First Page", "Generate Architecture"]) {
  test(`${label} waits for its schedule and shows the actual action without Wait`, async () => {
    let calls = 0;
    const buttons = [{ key: "continue", action: "resume_design", label }];
    const result = await getCheckpointButtons({ getAutoRuns: async () => ({
      server_now: "2026-10-30T10:00:00Z",
      auto_runs: ++calls < 2 ? [] : [{ entry_id: "entry", button_key: "continue", label, status: "scheduled", fire_at: "2026-10-30T10:00:30Z" }],
    }) }, "project", ["continue"], buttons, { intervalMs: 0 });
    assert.equal(calls, 2);
    assert.deepEqual(buildSuggestedAgentChoices("project", ["continue"], undefined, result).map(choice => choice.label), [label]);
  });
}

test("a different action's countdown cannot create a Wait button", async () => {
  const result = await getCheckpointButtons({ getAutoRuns: async () => ({ auto_runs: [{
    entry_id: "entry", button_key: "continue", label: "Generate Architecture", status: "scheduled", fire_at: "2026-10-30T10:00:30Z",
  }] }) }, "project", ["continue"], [{ key: "continue", action: "resume_design", label: "Generate First Page" }], { attempts: 1 });
  assert.deepEqual(buildSuggestedAgentChoices("project", ["continue"], undefined, result).map(choice => choice.label), ["Generate First Page"]);
});
