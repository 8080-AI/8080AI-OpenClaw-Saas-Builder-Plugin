import test from "node:test";
import assert from "node:assert";
import { checkGenerateFirstPageCondition, determineContinueButtonLabel, type AgentLog } from "../src/api-client.ts";
import { createProjectStatusTool } from "../src/project-status-tool.ts";
import { createContinueProjectTool, findFailedAgentLogSince } from "../src/continue-project-tool.ts";
import { extractEventSuggestion } from "../src/suggested-agents.ts";

test("extractEventSuggestion", () => {
  const suggestion = extractEventSuggestion({
    type: "suggested_agents",
    agents: ["generate_architecture"],
    message_id: "msg-generate-architecture",
    session_id: "session-1",
    buttons: [
      {
        key: "run_agents",
        kind: "agent",
        label: "Generate Architecture",
        action: "resume_design",
      },
    ],
  });

  assert.deepStrictEqual(suggestion.agents, ["generate_architecture"]);
  assert.strictEqual(suggestion.messageId, "msg-generate-architecture");
  assert.strictEqual(suggestion.sessionId, "session-1");
  assert.strictEqual(suggestion.buttons?.[0]?.label, "Generate Architecture");
});

test("architecture retries ignore failures from an older run", () => {
  const actionStartedAt = Date.parse("2026-10-27T10:00:00Z");
  const logs = [
    {
      action: "error",
      agent_type: "System Architect",
      summary: "Architecture generation could not complete",
      created_at: "2026-10-27T09:50:00Z",
    },
  ];

  assert.equal(findFailedAgentLogSince(logs, actionStartedAt), undefined);
  assert.equal(
    findFailedAgentLogSince([
      ...logs,
      { ...logs[0], created_at: "2026-10-27T10:00:02Z" },
    ], actionStartedAt)?.created_at,
    "2026-10-27T10:00:02Z"
  );
});

test("checkGenerateFirstPageCondition", async (t) => {
  await t.test("should return false if logs are empty", async () => {
    const mockClient = {
      getAgentLogs: async (projectId: string) => [] as AgentLog[],
    };
    const result = await checkGenerateFirstPageCondition(mockClient, "test-project");
    assert.strictEqual(result, false);
  });

  await t.test("should return false if only System Requirements is completed", async () => {
    const mockClient = {
      getAgentLogs: async (projectId: string) => [
        {
          agent_type: "System Requirements Agent",
          action: "completed",
          summary: "Finished requirements",
          created_at: new Date().toISOString(),
          message_id: "msg1",
        },
      ] as AgentLog[],
    };
    const result = await checkGenerateFirstPageCondition(mockClient, "test-project");
    assert.strictEqual(result, false);
  });

  await t.test("should return false if only User Flow Planner is completed", async () => {
    const mockClient = {
      getAgentLogs: async (projectId: string) => [
        {
          agent_type: "User Flow Planner",
          action: "completed",
          summary: "Finished user flow",
          created_at: new Date().toISOString(),
          message_id: "msg2",
        },
      ] as AgentLog[],
    };
    const result = await checkGenerateFirstPageCondition(mockClient, "test-project");
    assert.strictEqual(result, false);
  });

  await t.test("does not offer first-page generation from completed historical planning logs", async () => {
    const mockClient = {
      getAgentLogs: async (projectId: string) => [
        {
          agent_type: "System Requirements",
          action: "completed",
          summary: "Finished requirements",
          created_at: new Date().toISOString(),
          message_id: "msg1",
        },
        {
          agent_type: "User Flow Planner Agent",
          action: "completed",
          summary: "Finished user flow",
          created_at: new Date().toISOString(),
          message_id: "msg2",
        },
      ] as AgentLog[],
    };
    const result = await checkGenerateFirstPageCondition(mockClient, "test-project");
    assert.strictEqual(result, false);
  });

  await t.test("does not offer first-page generation from historical completion summaries", async () => {
    const mockClient = {
      getAgentLogs: async (projectId: string) => [
        {
          agent_type: "System Requirements Agent",
          action: "running",
          summary: "Completed requirements compilation successfully",
          created_at: new Date().toISOString(),
          message_id: "msg1",
        },
        {
          agent_type: "User Flow Planner",
          action: "running",
          summary: "completed user flows step",
          created_at: new Date().toISOString(),
          message_id: "msg2",
        },
      ] as AgentLog[],
    };
    const result = await checkGenerateFirstPageCondition(mockClient, "test-project");
    assert.strictEqual(result, false);
  });

  await t.test("should return false if getAgentLogs rejects", async () => {
    const mockClient = {
      getAgentLogs: async (projectId: string) => {
        throw new Error("API network error");
      },
    };
    const result = await checkGenerateFirstPageCondition(mockClient, "test-project");
    assert.strictEqual(result, false);
  });

  await t.test("should return false if both requirements/flow are completed but Design Agent has started or completed", async () => {
    const mockClient = {
      getAgentLogs: async (projectId: string) => [
        {
          agent_type: "System Requirements",
          action: "completed",
          summary: "Finished requirements",
          created_at: new Date().toISOString(),
          message_id: "msg1",
        },
        {
          agent_type: "User Flow Planner",
          action: "completed",
          summary: "Finished user flow",
          created_at: new Date().toISOString(),
          message_id: "msg2",
        },
        {
          agent_type: "Design Agent",
          action: "started",
          summary: "Designing first page",
          created_at: new Date().toISOString(),
          message_id: "msg3",
        },
      ] as AgentLog[],
    };
  });
});

test("continue labels are not inferred from historical logs or artifacts", async () => {
  const client = {
    getAgentLogs: async () => { throw new Error("must not inspect old logs"); },
    getDesignPages: async () => { throw new Error("must not infer actions from artifacts"); },
  };
  assert.equal(await determineContinueButtonLabel(client, "project"), "Continue");
});

import { getLabelForAgent, type BackendButton } from "../src/review-continue.ts";

test("getLabelForAgent", (t) => {
  t.test("should fall back to default label when no buttons are provided", () => {
    assert.strictEqual(getLabelForAgent("continue", false), "Continue");
    assert.strictEqual(getLabelForAgent("continue", true), "Generate First Page");
    assert.strictEqual(getLabelForAgent("review"), "Review");
    assert.strictEqual(getLabelForAgent("plan_all"), "Start");
    assert.strictEqual(getLabelForAgent("GROUP:agent_a|agent_b"), "🚀 Run agent_a, agent_b");
  });

  t.test("should match continue agent to resume_design or continue action/button label", () => {
    const buttons: BackendButton[] = [
      { key: "keep_talking", kind: "agent", label: "Keep Talking", action: "focus_chat" },
      { key: "run_agents", kind: "agent", label: "Generate Architecture", action: "resume_design" },
    ];
    assert.strictEqual(getLabelForAgent("continue", false, buttons), "Generate Architecture");
  });

  t.test("should match review agent to review button label", () => {
    const buttons: BackendButton[] = [
      { key: "review_document", kind: "agent", label: "Review Requirements", action: "review" },
    ];
    assert.strictEqual(getLabelForAgent("review", false, buttons), "Review Requirements");
  });

  t.test("should match specific agent based on payload contents", () => {
    const buttons: BackendButton[] = [
      { key: "run_agents", kind: "agent", label: "Run Plan All", action: "trigger_agents", payload: { agents: ["plan_all"] } },
    ];
    assert.strictEqual(getLabelForAgent("plan_all", false, buttons), "Start");
  });

  t.test("should use Start for a grouped plan-all action", () => {
    const buttons: BackendButton[] = [
      {
        key: "run_agents",
        kind: "agent",
        label: "Run Plan All",
        action: "trigger_agents",
        payload: { agents: ["System Requirements Agent", "plan_all"] },
      },
    ];
    assert.strictEqual(
      getLabelForAgent("GROUP:System Requirements Agent|plan_all", false, buttons),
      "Start"
    );
  });

  t.test("should match group agents based on payload contents", () => {
    const buttons: BackendButton[] = [
      { key: "run_agents", kind: "agent", label: "🚀 Run coding & testing", action: "trigger_agents", payload: { agents: ["code_gen", "unit_test"] } },
    ];
    assert.strictEqual(getLabelForAgent("GROUP:code_gen|unit_test", false, buttons), "🚀 Run coding & testing");
  });
});

import fs from "node:fs";
import path from "node:path";
import { createSelectButtonTool } from "../src/select-button-tool.ts";
import { create8080Command } from "../src/command.ts";
import { writeLatestSuggestions } from "../src/suggestions-state.ts";
import { writeApiKey } from "../src/api-key.ts";

test("integration tests", async (t) => {
  await t.test("select-button-tool integration tests", async (t) => {
  const testStateDir = fs.mkdtempSync(path.join(process.cwd(), "test-state-"));

  // Create valid API key
  const ts = new Date().toISOString();
  const payload = { uid: "test-user", ts };
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mockApiKey = `sk-8080ai-${base64Payload}`;
  await writeApiKey(testStateDir, mockApiKey, {
    uid: "test-user",
    issuedAt: Date.parse(ts),
    expiresAt: null,
  });

  // Mock global fetch
  const originalFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(testStateDir, { recursive: true, force: true });
  });

  const scheduledWaitSuggestions = {
    projectId: "test-proj",
    agents: ["plan_all"],
    messageId: "offer",
    buttons: [{
      key: "start",
      kind: "auto_run",
      label: "Wait",
      action: "wait_auto_run",
      payload: {
        entry_id: "offer",
        button_key: "start",
        label: "Start",
        status: "scheduled",
        fire_at: "2099-01-01T00:00:30+00:00",
        server_now: "2099-01-01T00:00:00+00:00",
      },
    }],
  };

  async function assertDirectWaitRequest(run: () => Promise<unknown>) {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ status: "cancelled" });
    };

    await writeLatestSuggestions(testStateDir, "test-session", scheduledWaitSuggestions);
    await run();

    assert.strictEqual(requests.length, 0, "Disabled Wait must not call the API");
  }

  await t.test("natural-language Wait is disabled without an API request", async () => {
    const tool = createSelectButtonTool({
      stateDir: () => testStateDir,
      siteUrl: "http://localhost",
      apiBaseUrl: "http://localhost",
      sessionId: "test-session",
    });

    await assertDirectWaitRequest(() => tool.execute("id-wait", { choice: "wait" }, undefined, () => {}));
  });

  await t.test("slash-command Wait is disabled without an API request", async () => {
    const command = create8080Command(
      { runtime: { state: { resolveStateDir: () => testStateDir } } },
      { siteUrl: "http://localhost", apiBaseUrl: "http://localhost", sessionId: "test-session" }
    );

    await assertDirectWaitRequest(() => command.handler({ args: "select-button wait" }));
  });

  await t.test("should resolve choice and execute continue tool successfully", async () => {
    let resumeCalls = 0;
    let triggerAgentCalls = 0;
    // Write suggestions state
    await writeLatestSuggestions(testStateDir, "test-session", {
      projectId: "test-proj",
      agents: ["continue", "review"],
      messageId: "msg123",
      buttons: [
        { key: "run_agents", kind: "agent", label: "Generate Architecture", action: "resume_design" }
      ]
    });

    // Mock responses
    globalThis.fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("/chat/resume-design")) {
        resumeCalls += 1;
        return Response.json({ status: "resumed" });
      }
      if (urlStr.includes("/chat/trigger-agents")) {
        triggerAgentCalls += 1;
        return Response.json({ status: "triggered" });
      }
      if (urlStr.includes("/projects/test-proj/events")) {
        const events = [
          { type: "suggested_agents", agents: ["generate_architecture", "review"] },
          { type: "planning_complete", status: "paused_for_review" },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
        return new Response(events, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      if (urlStr.includes("/projects/test-proj")) {
        return new Response(JSON.stringify({
          id: "test-proj",
          phase: "design",
          pending_suggested_agents: {
            sessionId: "test-session",
            agents: ["continue"],
            buttons: [{ key: "run_agents", kind: "agent", label: "Generate Architecture", action: "resume_design" }]
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    };

    const tool = createSelectButtonTool({
      stateDir: () => testStateDir,
      siteUrl: "http://localhost",
      apiBaseUrl: "http://localhost",
      sessionId: "test-session"
    });

    // Test choice: "1"
    const result1 = await tool.execute("id-1", { choice: "1", timeoutMs: 5_050 }, undefined, () => {});
    assert.ok(result1);

    // An explicit stage agent must still use resume-design, never trigger-agents.
    await writeLatestSuggestions(testStateDir, "test-session", {
      projectId: "test-proj",
      agents: ["generate_architecture", "review"],
      messageId: "msg-architecture",
      buttons: [
        { key: "run_agents", kind: "agent", label: "Generate Architecture", action: "resume_design" }
      ],
    });
    const result2 = await tool.execute("id-2", { choice: "Generate Architecture", timeoutMs: 5_050 }, undefined, () => {});
    assert.ok(result2);
    assert.equal(triggerAgentCalls, 0);
    assert.ok(resumeCalls >= 2);

    // Test choice: ultimate fallback "continue"
    const result3 = await tool.execute("id-3", { choice: "continue", timeoutMs: 5_050 }, undefined, () => {});
    assert.ok(result3);
  });

  await t.test("should return error for invalid choice", async () => {
    const tool = createSelectButtonTool({
      stateDir: () => testStateDir,
      siteUrl: "http://localhost",
      apiBaseUrl: "http://localhost",
      sessionId: "test-session"
    });

    const result = await tool.execute("id-4", { choice: "invalid-action-name" }, undefined, () => {});
    assert.ok(result.content[0].text.includes("is not valid"));
  });
});



  await t.test("project-status-tool integration tests", async (t) => {
  const testStateDir = fs.mkdtempSync(path.join(process.cwd(), "test-status-"));

  // Create valid API key
  const ts = new Date().toISOString();
  const payload = { uid: "test-user", ts };
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mockApiKey = `sk-8080ai-${base64Payload}`;
  await writeApiKey(testStateDir, mockApiKey, {
    uid: "test-user",
    issuedAt: Date.parse(ts),
    expiresAt: null,
  });

  const originalFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(testStateDir, { recursive: true, force: true });
  });

  await t.test("does not invent design suggestions when pages are done but pending suggestions is null", async () => {
    globalThis.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/projects/test-proj/agent-logs")) {
        return new Response(JSON.stringify([
          {
            agent_type: "Design Agent",
            action: "completed",
            summary: "Finished design",
            created_at: new Date().toISOString(),
          }
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/projects/test-proj/design-pages")) {
        return new Response(JSON.stringify({
          design_pages: [
            {
              page_name: "Todo",
              generation_in_progress: false,
              sections_done: 3,
              sections_total: 3,
              generation_phase: "complete",
              screenshot_url: "http://screenshot",
            }
          ]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/projects/test-proj")) {
        return new Response(JSON.stringify({
          id: "test-proj",
          phase: "design",
          title: "My App",
          status: "paused_for_review",
          pending_suggested_agents: null
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    };

    const tool = createProjectStatusTool({
      stateDir: () => testStateDir,
      apiBaseUrl: "http://localhost",
      sessionId: "test-session"
    } as any);

    const result = await tool.execute("id-5", { projectId: "test-proj" }, undefined, () => {});
    assert.ok(result);
    // Completed artifacts do not authorize another pipeline action.
    assert.ok(!result.content[0].text.includes("Generate Architecture"));
    assert.ok(!result.presentation);
  });
});

  await t.test("continue-project-tool integration tests", async (t) => {
    const testStateDir = fs.mkdtempSync(path.join(process.cwd(), "test-continue-"));

    // Create valid API key
    const ts = new Date().toISOString();
    const payload = { uid: "test-user", ts };
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mockApiKey = `sk-8080ai-${base64Payload}`;
    await writeApiKey(testStateDir, mockApiKey, {
      uid: "test-user",
      issuedAt: Date.parse(ts),
      expiresAt: null,
    });

    const originalFetch = globalThis.fetch;

    t.after(() => {
      globalThis.fetch = originalFetch;
      fs.rmSync(testStateDir, { recursive: true, force: true });
    });

    await t.test("continues observing after an intermediate review pause", async () => {
      // Mock suggestions file state
      await writeLatestSuggestions(testStateDir, "test-session", {
        projectId: "test-proj",
        agents: ["continue", "review"],
        messageId: "msg123",
      });

      let resumeCalled = false;
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/chat/resume-design")) {
          resumeCalled = true;
          return new Response("{}", { status: 200 });
        }
        if (urlStr.includes("/projects/test-proj/events")) {
          // Send an event with status paused_for_review and suggested_agents
          const sseContent = 
            `data: ${JSON.stringify({
              type: "chat_message",
              status: "paused_for_review",
              content: "Please review the design.",
              agents: ["generate_first_page", "review"],
              message_id: "event-msg-456",
              buttons: [{ key: "run_agents", kind: "agent", label: "Generate First Page", action: "trigger_agents", payload: { agents: ["generate_first_page"] } }]
            })}\n\n`;
          return new Response(sseContent, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" }
          });
        }
        if (urlStr.includes("/projects/test-proj/agent-logs")) {
          return new Response(JSON.stringify([
            {
              agent_type: "Design Agent",
              action: "completed",
              summary: "Finished design",
              created_at: new Date().toISOString(),
            }
          ]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (urlStr.includes("/projects/test-proj/design-pages")) {
          return new Response(JSON.stringify({ design_pages: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (urlStr.includes("/projects/test-proj")) {
          return new Response(JSON.stringify({
            id: "test-proj",
            phase: "design",
            title: "My App",
            status: "paused_for_review",
            pending_suggested_agents: { agents: ["continue", "review"] }
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      };

      const tool = createContinueProjectTool({
        stateDir: () => testStateDir,
        apiBaseUrl: "http://localhost",
        sessionId: "test-session"
      } as any);

      const result = await tool.execute("id-6", { projectId: "test-proj", timeoutMs: 5_050 }, undefined, () => {});
      assert.ok(result);
      assert.ok(resumeCalled);
      
      // Should contain the button we returned from SSE in presentation/text
      const text = result.content[0].text;
      assert.ok(text.includes("Generate First Page"));
    });

    await t.test("returns the agent failure as an error response", async () => {
      // Mock suggestions file state
      await writeLatestSuggestions(testStateDir, "test-session", {
        projectId: "test-proj",
        agents: ["continue", "review"],
        messageId: "msg123",
      });

      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/projects/test-proj")) {
          return Response.json({ id: "test-proj", pending_suggested_agents: { agents: ["continue"], buttons: [{ action: "resume_design", label: "Generate First Page" }] } });
        }
        if (urlStr.includes("/chat/resume-design")) {
          return new Response("{}", { status: 200 });
        }
        if (urlStr.includes("/projects/test-proj/events")) {
          // Send an agent log failure event
          const sseContent = 
            `data: ${JSON.stringify({
              type: "agent_log",
              agent_type: "Design Agent",
              action: "failed",
              summary: "Insufficient credits or prompt block"
            })}\n\n`;
          return new Response(sseContent, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" }
          });
        }
        return new Response("Not found", { status: 404 });
      };

      const tool = createContinueProjectTool({
        stateDir: () => testStateDir,
        apiBaseUrl: "http://localhost",
        sessionId: "test-session"
      } as any);

      const result = await tool.execute("id-7", { projectId: "test-proj" }, undefined, () => {});
      assert.match(result.content[0].text, /Agent Design Agent failed: Insufficient credits or prompt block/);
    });
  });
});


test("active visual review is not completed design output", async () => {
  const { hasCompletedDesignPages } = await import("../src/api-client.ts");
  assert.equal(hasCompletedDesignPages([{ generation_in_progress: true, generation_phase: "reviewing", sections_done: 3, sections_total: 3, compiled_html: "<html/>" }]), false);
});
