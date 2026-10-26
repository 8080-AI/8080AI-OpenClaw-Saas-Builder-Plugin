import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "./api-client.ts";
import { evaluateBuildTasksReadiness } from "./build-readiness.ts";

test("Build Tasks is ready only with can_start, a current phase, and runnable tasks", () => {
  const planningComplete = { is_active: false, pm_step_status: "done" };
  const ready = evaluateBuildTasksReadiness({
    can_start: true,
    blocking_reason: null,
    all_completed: false,
    current_phase: { id: "phase-1" },
    runnable_tasks: [{ id: "task-1" }],
  }, planningComplete);
  assert.equal(ready.canStart, true);
  assert.equal(ready.phaseId, "phase-1");

  assert.equal(evaluateBuildTasksReadiness({
    can_start: false,
    all_completed: false,
    current_phase: { id: "phase-1" },
    runnable_tasks: [{ id: "task-1" }],
  }, planningComplete).canStart, false);
  assert.equal(evaluateBuildTasksReadiness({
    can_start: true,
    all_completed: false,
    current_phase: null,
    runnable_tasks: [{ id: "task-1" }],
  }, planningComplete).canStart, false);
  assert.equal(evaluateBuildTasksReadiness({
    can_start: true,
    all_completed: false,
    current_phase: { id: "phase-1" },
    runnable_tasks: [],
  }, planningComplete).canStart, false);
  assert.equal(evaluateBuildTasksReadiness({
    can_start: true,
    all_completed: true,
    current_phase: { id: "phase-1" },
    runnable_tasks: [{ id: "task-1" }],
  }, planningComplete).canStart, false);
  assert.equal(evaluateBuildTasksReadiness({
    can_start: true,
    all_completed: false,
    current_phase: { id: "phase-1" },
    runnable_tasks: [{ id: "task-1" }],
  }, { is_active: true, pm_step_status: "done" }).canStart, false);
  assert.equal(evaluateBuildTasksReadiness({
    can_start: true,
    all_completed: false,
    current_phase: { id: "phase-1" },
    runnable_tasks: [{ id: "task-1" }],
  }, { is_active: false, pm_step_status: "running" }).canStart, false);
});

test("execution-state is checked and Build Tasks posts the current phase to /build", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/chat/planning-status")) {
      return Response.json({ is_active: false, pm_step_status: "done" });
    }
    if (url.includes("/build-phases/execution-state")) {
      return Response.json({
        can_start: true,
        blocking_reason: null,
        all_completed: false,
        current_phase: { id: "phase-1" },
        runnable_tasks: [{ id: "task-1" }],
      });
    }
    if (url.endsWith("/projects/project-123/build")) {
      return Response.json({ status: "started", queued_tasks: 1 });
    }
    return new Response("Not found", { status: 404 });
  };

  const client = createApiClient({
    apiKey: "test-key",
    apiBaseUrl: "https://api.example/api/v1",
  });
  const [planningStatus, state] = await Promise.all([
    client.getPlanningStatus("project-123"),
    client.getBuildPhaseExecutionState("project-123", "super_large"),
  ]);
  const readiness = evaluateBuildTasksReadiness(state, planningStatus);
  assert.equal(readiness.canStart, true);

  await client.startBuilding("project-123", "super_large", readiness.phaseId);

  const planningRequest = requests.find((request) => request.url.includes("/chat/planning-status"));
  const stateRequest = requests.find((request) => request.url.includes("/build-phases/execution-state"));
  const buildRequest = requests.find((request) => request.url.endsWith("/projects/project-123/build"));
  assert.match(planningRequest?.url ?? "", /\/chat\/planning-status\?project_id=project-123$/);
  assert.equal(planningRequest?.init?.method, "GET");
  assert.match(stateRequest?.url ?? "", /\/projects\/project-123\/build-phases\/execution-state\?model_tier=super_large$/);
  assert.equal(stateRequest?.init?.method, "GET");
  assert.equal(buildRequest?.url, "https://api.example/api/v1/projects/project-123/build");
  assert.equal(buildRequest?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(buildRequest?.init?.body)), {
    default_model: "super_large",
    force_execution_task_ids: [],
    phase_id: "phase-1",
  });
});
