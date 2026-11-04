import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeApiKey } from "../src/api-key.ts";
import { writeLatestSuggestions } from "../src/suggestions-state.ts";
import { createTriggerAgentsTool } from "../src/trigger-agents-tool.ts";

test("automatic generation ends with Build Tasks and backend tasks", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai8080-trigger-tasks-"));
  const issuedAt = new Date().toISOString();
  const apiKey = `sk-8080ai-${Buffer.from(JSON.stringify({
    uid: "test-user",
    ts: issuedAt,
  })).toString("base64url")}`;

  await writeApiKey(stateDir, apiKey, {
    uid: "test-user",
    issuedAt: Date.parse(issuedAt),
    expiresAt: null,
  });
  await writeLatestSuggestions(stateDir, "test-session", {
    projectId: "test-project",
    agents: ["plan_all"],
    messageId: "message-1",
  });

  const originalFetch = globalThis.fetch;
  let taskRequestCount = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  globalThis.fetch = async (input, init) => {
    const url = String(input);

    if (url.endsWith("/chat/trigger-agents") && init?.method === "POST") {
      return Response.json({ status: "triggered" });
    }
    if (url.endsWith("/projects/test-project/events")) {
      const event = {
        type: "suggested_agents",
        status: "paused_for_review",
        agents: ["generate_architecture", "review"],
        message_id: "message-2",
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (url.includes("planning-status")) return Response.json({ is_active: false, pm_step_status: "done" });
    if (url.includes("execution-state")) return Response.json({ can_start: true, all_completed: false,
      current_phase: { id: "phase" }, runnable_tasks: [{ task_number: 1, title: "Build calculator interface", status: "todo" }] });
    if (url.endsWith("/projects/test-project/tasks")) {
      taskRequestCount += 1;
      return Response.json([
        {
          task_number: 1,
          title: "Build calculator interface",
          status: "todo",
          priority: "medium",
        },
      ]);
    }
    if (url.endsWith("/projects/test-project/architecture")) {
      return Response.json({ service_network: [] });
    }
    if (url.endsWith("/projects/test-project/agent-logs")) {
      return Response.json([
        {
          agent_type: "Design Agent",
          action: "completed",
          summary: "Designed calculator page",
          created_at: new Date().toISOString(),
        },
      ]);
    }
    if (url.endsWith("/projects/test-project/design-pages")) {
      return Response.json([
        {
          page_name: "Calculator",
          generation_in_progress: false,
          sections_done: 1,
          sections_total: 1,
          generation_phase: "complete",
          screenshot_url: "https://example.invalid/calculator.png",
        },
      ]);
    }
    if (url.endsWith("/projects/test-project")) {
      return Response.json({
        id: "test-project",
        phase: "design",
        status: "active",
        pending_suggested_agents: null,
        messages: [],
      });
    }

    return new Response("Not found", { status: 404 });
  };

  const tool = createTriggerAgentsTool({
    stateDir: () => stateDir,
    apiBaseUrl: "http://localhost",
    sessionId: "test-session",
  });
  const result = await tool.execute(
    "tool-call-1",
    { projectId: "test-project", agents: ["plan_all"] },
    undefined,
    () => {}
  );

  const text = result.content[0]?.text ?? "";
  assert.ok(taskRequestCount >= 1);
  assert.match(text, /### Task List/);
  assert.match(text, /Build calculator interface/);
  assert.match(text, /### Suggested Next Steps/);
  assert.match(text, /Build Tasks/);
});

test("review polling waits for backend actions after planning has already completed", async () => {
  const { waitForReviewActions } = await import("../src/trigger-agents-tool.ts");
  let checks = 0;
  const client = {
    getProjectStatus: async () => ({
      id: "project", messages: [{ content: "Please review the design." }],
      pending_suggested_agents: ++checks < 3 ? null : {
        buttons: [{ action: "resume_design", label: "Generate First Page" }],
      },
    }),
    hasLatestCompletedAgentLog: async () => true,
  };
  const result = await waitForReviewActions(client as any, "project", {
    pausedForReview: true, timeoutMs: 1000, intervalMs: 1,
  });
  assert.equal(checks, 3);
  assert.equal(result.backendHasContinue, true);
});

test("review polling expires without inventing actions", async () => {
  const { waitForReviewActions } = await import("../src/trigger-agents-tool.ts");
  const { extractPendingSuggestion } = await import("../src/suggested-agents.ts");
  const result = await waitForReviewActions({
    getProjectStatus: async () => ({ id: "project", pending_suggested_agents: null }),
    hasLatestCompletedAgentLog: async () => true,
  } as any, "project", { pausedForReview: true, timeoutMs: 5, intervalMs: 1 });
  assert.deepEqual(extractPendingSuggestion(result.status.pending_suggested_agents).agents, []);
});

test("scheduled backend buttons supply their action and retain Wait metadata", async () => {
  const { extractPendingSuggestion } = await import("../src/suggested-agents.ts");
  const { buildSuggestedAgentChoices } = await import("../src/review-continue.ts");
  const button = { kind: "auto_run", action: "wait_auto_run", payload: {
    entry_id: "first-page", button_key: "continue", label: "Generate First Page",
    status: "scheduled", fire_at: "2030-01-01T00:00:30Z",
  } };
  const pending = extractPendingSuggestion({ buttons: [button] });
  assert.deepEqual(buildSuggestedAgentChoices("project", pending.agents, undefined, pending.buttons).map(choice => choice.label), ["Generate First Page"]);
  assert.deepEqual(extractPendingSuggestion({ buttons: [{ ...button, payload: { ...button.payload, status: "cancelled" } }] }).agents, []);
});
