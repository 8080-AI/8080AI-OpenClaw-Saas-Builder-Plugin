import test from "node:test";
import assert from "node:assert";
import { checkGenerateFirstPageCondition, determineContinueButtonLabel, type AgentLog } from "./api-client.ts";
import { createProjectStatusTool } from "./project-status-tool.ts";
import { createContinueProjectTool } from "./continue-project-tool.ts";
import { extractEventSuggestion } from "./suggested-agents.ts";

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

  await t.test("should return true if both System Requirements and User Flow Planner are completed", async () => {
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
    assert.strictEqual(result, true);
  });

  await t.test("should return true when completed status is in summary prefix", async () => {
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
    assert.strictEqual(result, true);
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

test("determineContinueButtonLabel", async (t) => {
  await t.test("should return 'Continue' if logs are empty", async () => {
    const mockClient = {
      getAgentLogs: async () => [] as AgentLog[],
    };
    const result = await determineContinueButtonLabel(mockClient, "test-project");
    assert.strictEqual(result, "Continue");
  });

  await t.test("should return 'Generate First Page' if requirements and flows are completed and Design Agent has not run", async () => {
    const mockClient = {
      getAgentLogs: async () => [
        {
          agent_type: "System Requirements Agent",
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
    const result = await determineContinueButtonLabel(mockClient, "test-project");
    assert.strictEqual(result, "Generate First Page");
  });

  await t.test("should return 'Generate Architecture' if Design Agent is completed and all design pages are completed", async () => {
    const mockClient = {
      getAgentLogs: async () => [
        {
          agent_type: "Design Agent",
          action: "completed",
          summary: "Finished design",
          created_at: new Date().toISOString(),
          message_id: "msg3",
        },
      ] as AgentLog[],
      getDesignPages: async () => [
        {
          page_name: "Todo",
          generation_in_progress: false,
          sections_done: 3,
          sections_total: 3,
          generation_phase: "complete",
          screenshot_url: "http://screenshot",
        },
      ],
    };
    const result = await determineContinueButtonLabel(mockClient, "test-project");
    assert.strictEqual(result, "Generate Architecture");
  });

  await t.test("should return 'Generate All Pages' if Design Agent is completed but some design pages are not completed", async () => {
    const mockClient = {
      getAgentLogs: async () => [
        {
          agent_type: "Design Agent",
          action: "completed",
          summary: "Finished design",
          created_at: new Date().toISOString(),
          message_id: "msg3",
        },
      ] as AgentLog[],
      getDesignPages: async () => [
        {
          page_name: "Todo",
          generation_in_progress: false,
          sections_done: 3,
          sections_total: 3,
          generation_phase: "complete",
          screenshot_url: "http://screenshot",
        },
        {
          page_name: "Settings",
          generation_in_progress: true,
          sections_done: 1,
          sections_total: 3,
          generation_phase: "generating",
          screenshot_url: "",
        },
      ],
    };
    const result = await determineContinueButtonLabel(mockClient, "test-project");
    assert.strictEqual(result, "Generate All Pages");
  });

  await t.test("should return 'Generate All Pages' if first design page is ready and more pages are expected", async () => {
    const mockClient = {
      getAgentLogs: async () => [
        {
          agent_type: "Design Agent",
          action: "started",
          summary: "Found 2 pages: Home, To-Do App. Starting design...",
          created_at: new Date().toISOString(),
          message_id: "resume-design",
        },
        {
          agent_type: "Design Agent",
          action: "started",
          summary: "Designing Home (new, 1/2)...",
          created_at: new Date().toISOString(),
          message_id: "resume-design",
        },
      ] as AgentLog[],
      getDesignPages: async () => [
        {
          page_name: "Home",
          generation_in_progress: false,
          sections_done: 6,
          sections_total: 6,
          generation_phase: "complete",
          screenshot_url: "http://screenshot",
        },
      ],
    };
    const result = await determineContinueButtonLabel(mockClient, "test-project");
    assert.strictEqual(result, "Generate All Pages");
  });

  await t.test("should return 'Continue' if Design Agent is started but not completed", async () => {
    const mockClient = {
      getAgentLogs: async () => [
        {
          agent_type: "Design Agent",
          action: "started",
          summary: "Designing first page",
          created_at: new Date().toISOString(),
          message_id: "msg3",
        },
      ] as AgentLog[],
    };
    const result = await determineContinueButtonLabel(mockClient, "test-project");
    assert.strictEqual(result, "Continue");
  });
});

import { getLabelForAgent, type BackendButton } from "./review-continue.ts";

test("getLabelForAgent", (t) => {
  t.test("should fall back to default label when no buttons are provided", () => {
    assert.strictEqual(getLabelForAgent("continue", false), "Continue");
    assert.strictEqual(getLabelForAgent("continue", true), "Generate First Page");
    assert.strictEqual(getLabelForAgent("review"), "Review");
    assert.strictEqual(getLabelForAgent("plan_all"), "🚀 Run Plan All");
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
    assert.strictEqual(getLabelForAgent("plan_all", false, buttons), "Run Plan All");
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
import { createSelectButtonTool } from "./select-button-tool.ts";
import { writeLatestSuggestions } from "./suggestions-state.ts";
import { writeApiKey } from "./api-key.ts";

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

  await t.test("should resolve choice and execute continue tool successfully", async () => {
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
        return new Response("data: " + JSON.stringify({ type: "message", content: "Resume success" }) + "\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      if (urlStr.includes("/projects/test-proj/events")) {
        return new Response("data: " + JSON.stringify({ type: "message", content: "Event message" }) + "\n\n", {
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
    const result1 = await tool.execute("id-1", { choice: "1" }, undefined, () => {});
    assert.ok(result1);

    // Test choice: label "Generate Architecture" (case insensitive/normalized)
    const result2 = await tool.execute("id-2", { choice: "Generate Architecture" }, undefined, () => {});
    assert.ok(result2);

    // Test choice: ultimate fallback "continue"
    const result3 = await tool.execute("id-3", { choice: "continue" }, undefined, () => {});
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

  await t.test("should recover design suggestions when Design Agent is completed and pages are done but pending suggestions is null", async () => {
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
    // Check that recovered suggestions are included in text
    assert.ok(result.content[0].text.includes("Generate Architecture"));
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

    await t.test("should extract suggested agents from streamProjectEvents raw event on pause_for_review", async () => {
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
            pending_suggested_agents: null
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      };

      const tool = createContinueProjectTool({
        stateDir: () => testStateDir,
        apiBaseUrl: "http://localhost",
        sessionId: "test-session"
      } as any);

      const result = await tool.execute("id-6", { projectId: "test-proj" }, undefined, () => {});
      assert.ok(result);
      assert.ok(resumeCalled);
      
      // Should contain the button we returned from SSE in presentation/text
      const text = result.content[0].text;
      assert.ok(text.includes("Generate First Page"));
    });

    await t.test("should throw error if an agent failure occurs during event stream", async () => {
      // Mock suggestions file state
      await writeLatestSuggestions(testStateDir, "test-session", {
        projectId: "test-proj",
        agents: ["continue", "review"],
        messageId: "msg123",
      });

      globalThis.fetch = async (url) => {
        const urlStr = String(url);
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

      await assert.rejects(async () => {
        try {
          const res = await tool.execute("id-7", { projectId: "test-proj" }, undefined, () => {});
          console.log("EXECUTE_RESULT:", JSON.stringify(res));
        } catch (e) {
          console.log("EXECUTE_THROWN:", e);
          throw e;
        }
      }, /Agent Design Agent failed: Insufficient credits or prompt block/);
    });
  });
});
