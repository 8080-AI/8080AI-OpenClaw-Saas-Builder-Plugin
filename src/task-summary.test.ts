import test from "node:test";
import assert from "node:assert/strict";
import { formatProjectTasks } from "./task-summary.ts";

test("formatProjectTasks renders only compact todo tasks returned by /tasks", () => {
  const result = formatProjectTasks("project-123", [
    {
      task_number: 2,
      title: "Wire calculator operations",
      description: "Support addition and subtraction.",
      status: "ai_in_progress",
      role: "Frontend Agent",
      priority: "high",
      effort_days: 1,
    },
    {
      task_number: 1,
      title: "Create calculator layout",
      status: "todo",
    },
  ]);

  assert.equal(result.totalTasks, 1);
  assert.deepEqual(result.statusCounts, { todo: 1 });
  assert.match(result.text, /### Task List/);
  assert.match(result.text, /#### Todo \(1\)/);
  assert.match(result.text, /#1 Create calculator layout/);
  assert.doesNotMatch(result.text, /Wire calculator operations/);
  assert.doesNotMatch(result.text, /Role:|Priority:|Effort:|Support addition/);
});

test("formatProjectTasks explains when /tasks has no todo tasks", () => {
  const result = formatProjectTasks("project-empty", { tasks: [] });

  assert.equal(result.totalTasks, 0);
  assert.deepEqual(result.statusCounts, {});
  assert.equal(
    result.text,
    "### Task List\n\nProject: `project-empty`\n\nNo todo tasks are available."
  );
});

test("formatProjectTasks accepts wrapped API responses and ignores invalid entries", () => {
  const result = formatProjectTasks("project-wrapped", {
    data: [null, "invalid", { task_number: "A-1", title: "Deploy", status: "todo" }],
  });

  assert.equal(result.totalTasks, 1);
  assert.deepEqual(result.statusCounts, { todo: 1 });
  assert.match(result.text, /#A-1 Deploy/);
});
