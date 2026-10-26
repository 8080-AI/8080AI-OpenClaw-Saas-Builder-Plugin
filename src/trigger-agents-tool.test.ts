import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeApiKey } from "./api-key.ts";
import { writeLatestSuggestions } from "./suggestions-state.ts";
import { createTriggerAgentsTool } from "./trigger-agents-tool.ts";

test("trigger agent checkpoints include tasks returned by /tasks", async (t) => {
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
        agents: ["generate_architecture", "review"],
        message_id: "message-2",
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
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
  assert.match(text, /Generate Architecture/);
});
