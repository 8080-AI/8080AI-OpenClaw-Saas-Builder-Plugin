import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowProgress } from "../src/workflow-progress.ts";
import type { WorkflowSnapshot } from "../src/workflow-sync.ts";

const start = Date.parse("2026-11-02T08:00:00Z");
const snapshot = (seconds: number, agents: any[] = [], schedules: WorkflowSnapshot["schedules"] = []): WorkflowSnapshot => ({
  type: "workflow_snapshot", now: start + seconds * 1000, paused: false, agents, schedules,
});
const agent = (name: string, action: string, at: number, began = 0) => ({
  agent_type: name, action, startedAt: start + began * 1000,
  created_at: new Date(start + at * 1000).toISOString(), message_id: String(began), summary: "Backend activity",
});

test("progress shows measured agent elapsed time and the backend countdown", () => {
  const progress = new WorkflowProgress(start);
  let text = progress.update(snapshot(10, [agent("System Requirements Agent", "started", 0)], [
    { entryId: "first", label: "Generate First Page", expiresAt: start + 30_000 },
  ]));
  assert.match(text, /System Requirements Agent: running — 10 seconds elapsed/);
  assert.match(text, /Generate First Page\*\* — automatically triggers in 20 seconds/);
  assert.match(text, /requirements, personas, and user flows/);
  text = progress.update(snapshot(15, [agent("System Requirements Agent", "completed", 15)]));
  assert.match(text, /System Requirements Agent: completed — 15 seconds/);
  assert.doesNotMatch(text, /Suggested Next Steps|1\. Wait|Build Tasks/);
});

test("stage history follows scheduled first page, all pages, and architecture without reset on continuation", () => {
  let progress = new WorkflowProgress(start);
  for (const [label, name, began] of [
    ["Generate First Page", "Design Agent", 10],
    ["Generate All Pages", "Design Agent", 30],
    ["Generate Architecture", "System Architect", 50],
  ] as const) {
    progress.update(snapshot(began - 1, [], [{ entryId: label, label, expiresAt: start + began * 1000 }]));
    progress.update(snapshot(began + 5, [agent(name, "started", began, began)]));
    progress.update(snapshot(began + 8, [agent(name, "completed", began + 8, began)]));
    progress = new WorkflowProgress(start + 100_000, "Start", JSON.parse(JSON.stringify(progress.state)));
  }
  const text = progress.render(start + 60_000, undefined, true);
  for (const label of ["Start", "Generate First Page", "Generate All Pages", "Generate Architecture"]) assert.ok(text.includes(`**${label}**`));
  assert.match(text, /Elapsed: 60 seconds/);
  assert.match(text, /System Architect: completed — 8 seconds/);
});
