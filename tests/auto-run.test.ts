import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../src/api-client.ts";
import { exactToolResult } from "../src/exact-response.ts";
import { registerExactResponseHooks } from "../src/exact-response-hooks.ts";
import { extractPendingSuggestion, hasScheduledAutoRunButton, isSuggestedActionReady, mergeSuggestedButtons } from "../src/suggested-agents.ts";
import {
  buildSuggestedAgentChoices,
  buildSuggestedAgentsJsonl,
  buildSuggestedAgentsPresentation,
  buildSuggestedAgentsText,
  isContinueActionAgent,
  parseButtonValue,
} from "../src/review-continue.ts";

const scheduledServerNow = Date.now();
const scheduledStartButton = {
  key: "start",
  kind: "auto_run",
  label: "Wait",
  action: "wait_auto_run",
  payload: {
    entry_id: "offer",
    button_key: "start",
    label: "Start",
    status: "scheduled",
    fire_at: new Date(scheduledServerNow + 30_000).toISOString(),
    server_now: new Date(scheduledServerNow).toISOString(),
  },
};

test("scheduled Start renders only Start and its countdown without Wait", () => {
  const buttons = [scheduledStartButton];
  const presentation = buildSuggestedAgentsPresentation("project-123", ["plan_all"], "", undefined, buttons);
  const text = buildSuggestedAgentsText("project-123", ["plan_all"], "", undefined, buttons);
  const jsonl = JSON.parse(buildSuggestedAgentsJsonl("project-123", ["plan_all"], undefined, buttons));
  const buttonBlock = presentation?.blocks.find((block) => block.type === "buttons");
  const textBlock = presentation?.blocks.find((block) => block.type === "text");

  assert.ok(buttonBlock?.type === "buttons");
  assert.deepEqual(buttonBlock.buttons.map((button) => button.label), ["Start"]);
  assert.deepEqual(buttonBlock.buttons.map((button) => button.action), [
    { type: "command", command: "/ai8080 select-button 1" },
  ]);
  assert.ok(textBlock?.type === "text");
  assert.match(textBlock.text, /Start will trigger automatically on 8080\.ai in 30 seconds/);
  assert.match(text, /1\. Start/);
  assert.doesNotMatch(text, /Wait/);
  assert.doesNotMatch(text, /cancels the automatic action/);
  assert.deepEqual(jsonl.buttons.map((button: { label: string }) => button.label), ["Start"]);

  const parsed = parseButtonValue(buttonBlock.buttons[0].value ?? "");
  assert.deepEqual(parsed, {
    action: "trigger_agents",
    projectId: "project-123",
    agents: ["plan_all"],
  });
});

test("saved first-page schedule preserves its label without rendering Wait", () => {
  const buttons = [{
    ...scheduledStartButton,
    key: "continue",
    payload: {
      ...scheduledStartButton.payload,
      entry_id: "gate-generate-first-page",
      button_key: "continue",
      label: "Generate First Page",
    },
  }];
  const presentation = buildSuggestedAgentsPresentation(
    "project-123",
    ["continue"],
    "",
    undefined,
    buttons
  );
  const buttonBlock = presentation?.blocks.find((block) => block.type === "buttons");
  const textBlock = presentation?.blocks.find((block) => block.type === "text");

  assert.ok(buttonBlock?.type === "buttons");
  assert.deepEqual(buttonBlock.buttons.map((button) => button.label), ["Generate First Page"]);
  assert.ok(textBlock?.type === "text");
  assert.match(textBlock.text, /Generate First Page will trigger automatically/);
  const choices = buildSuggestedAgentChoices(
    "project-123",
    ["continue"],
    undefined,
    buttons
  );
  assert.equal(parseButtonValue(choices[0]?.value ?? "")?.action, "continue");
  assert.equal(choices.length, 1);
});

test("event buttons retain the scheduled Wait enriched by project status", () => {
  const eventButtons = [{
    key: "run_agents",
    kind: "agent",
    label: "Generate Architecture",
    action: "resume_design",
  }];
  const scheduledGenerateArchitecture = {
    ...scheduledStartButton,
    key: "continue",
    payload: {
      ...scheduledStartButton.payload,
      entry_id: "gate-generate-architecture",
      button_key: "continue",
      label: "Generate Architecture",
    },
  };
  const buttons = mergeSuggestedButtons(eventButtons, [
    ...eventButtons,
    scheduledGenerateArchitecture,
  ]);

  const choices = buildSuggestedAgentChoices(
    "project-123",
    ["continue", "review"],
    "Generate Architecture",
    buttons
  );

  assert.deepEqual(choices.map((choice) => choice.label), [
    "Generate Architecture",
    "Review",
  ]);
});

test("ready-to-build suggestions are labeled Build Tasks instead of Generate Architecture", () => {
  const choices = buildSuggestedAgentChoices(
    "project-123",
    ["start_building", "review"]
  );

  assert.deepEqual(choices.map((choice) => choice.label), ["Build Tasks", "Review"]);
});

test("completed design waits for the backend timer before showing Generate Architecture", () => {
  const regularButton = {
    key: "run_agents",
    kind: "agent",
    label: "Generate Architecture",
    action: "resume_design",
  };
  const timerButton = {
    key: "continue",
    kind: "auto_run",
    label: "Wait",
    action: "wait_auto_run",
    payload: {
      entry_id: "architecture-entry",
      button_key: "continue",
      label: "Generate Architecture",
      status: "scheduled",
      fire_at: "2030-01-01T00:00:30Z",
    },
  };

  assert.equal(hasScheduledAutoRunButton([regularButton]), false);
  assert.equal(isSuggestedActionReady({
    hasBackendAction: true,
    checkpointReady: true,
    requiresScheduledAutoRun: true,
    buttons: [regularButton],
  }), false);
  assert.equal(isSuggestedActionReady({
    hasBackendAction: true,
    checkpointReady: true,
    requiresScheduledAutoRun: true,
    buttons: [regularButton, timerButton],
  }), true);
});

for (const timedLabel of ["Generate Architecture", "Generate All Pages"]) {
  test(`scheduled ${timedLabel} renders the action and countdown without Wait`, () => {
    const buttons = [
      {
        key: "run_agents",
        kind: "agent",
        label: timedLabel,
        action: "resume_design",
      },
      {
        ...scheduledStartButton,
        key: "continue",
        payload: {
          ...scheduledStartButton.payload,
          entry_id: `gate-${timedLabel.toLowerCase().replaceAll(" ", "-")}`,
          button_key: "continue",
          label: timedLabel,
        },
      },
    ];
    const presentation = buildSuggestedAgentsPresentation(
      "project-123",
      ["continue", "review"],
      "",
      undefined,
      buttons
    );
    const text = buildSuggestedAgentsText(
      "project-123",
      ["continue", "review"],
      "",
      undefined,
      buttons
    );
    const buttonBlock = presentation?.blocks.find((block) => block.type === "buttons");
    const textBlock = presentation?.blocks.find((block) => block.type === "text");

    assert.ok(buttonBlock?.type === "buttons");
    assert.deepEqual(
      buttonBlock.buttons.map((button) => button.label),
      [timedLabel, "Review"]
    );
    assert.ok(textBlock?.type === "text");
    assert.match(textBlock.text, new RegExp(`${timedLabel} will trigger automatically on 8080\\.ai in 30 seconds`));
    assert.match(text, new RegExp(`1\\. ${timedLabel}\\n2\\. Review`));
    assert.doesNotMatch(text, /Wait/);

    const parsed = parseButtonValue(buttonBlock.buttons[0].value ?? "");
    assert.deepEqual(parsed, {
      action: "continue",
      projectId: "project-123",
    });
  });
}

test("Generate All Pages does not reuse a scheduled Generate Architecture entry", () => {
  const buttons = [
    {
      key: "run_agents",
      kind: "agent",
      label: "Generate All Pages",
      action: "resume_design",
    },
    {
      ...scheduledStartButton,
      key: "continue",
      payload: {
        ...scheduledStartButton.payload,
        entry_id: "gate-generate-architecture",
        button_key: "continue",
        label: "Generate Architecture",
      },
    },
  ];
  const presentation = buildSuggestedAgentsPresentation(
    "project-123",
    ["continue", "review"],
    "",
    undefined,
    buttons
  );
  const text = buildSuggestedAgentsText(
    "project-123",
    ["continue", "review"],
    "",
    undefined,
    buttons
  );
  const buttonBlock = presentation?.blocks.find((block) => block.type === "buttons");

  assert.ok(buttonBlock?.type === "buttons");
  assert.deepEqual(
    buttonBlock.buttons.map((button) => button.label),
    ["Generate All Pages", "Review"]
  );
  assert.doesNotMatch(text, /Wait|trigger automatically/);
});

test("Wait is omitted when the auto-run is not scheduled or belongs to another action", () => {
  const cancelled = {
    ...scheduledStartButton,
    payload: { ...scheduledStartButton.payload, status: "cancelled" },
  };
  const wrongButtonKey = {
    ...scheduledStartButton,
    payload: { ...scheduledStartButton.payload, button_key: "continue" },
  };

  const cancelledPresentation = buildSuggestedAgentsPresentation("project-123", ["plan_all"], "", undefined, [cancelled]);
  const mismatchedPresentation = buildSuggestedAgentsPresentation("project-123", ["plan_all"], "", undefined, [wrongButtonKey]);
  const cancelledButtons = cancelledPresentation?.blocks.find((block) => block.type === "buttons");
  const mismatchedButtons = mismatchedPresentation?.blocks.find((block) => block.type === "buttons");
  assert.ok(cancelledButtons?.type === "buttons");
  assert.ok(mismatchedButtons?.type === "buttons");
  assert.deepEqual(cancelledButtons.buttons.map((button) => button.label), ["Start"]);
  assert.deepEqual(mismatchedButtons.buttons.map((button) => button.label), ["Start"]);
});

test("backend-scheduled Start does not render Wait even with a past deadline", () => {
  const expired = {
    ...scheduledStartButton,
    payload: {
      ...scheduledStartButton.payload,
      fire_at: new Date(Date.now() - 1_000).toISOString(),
      server_now: new Date(Date.now() - 31_000).toISOString(),
    },
  };

  const choices = buildSuggestedAgentChoices("project-123", ["plan_all"], undefined, [expired]);
  assert.deepEqual(choices.map((choice) => choice.label), ["Start"]);
  assert.equal(hasScheduledAutoRunButton([expired]), true);
});

test("all design continuation aliases use the resume-design action", () => {
  assert.equal(isContinueActionAgent("continue"), true);
  assert.equal(isContinueActionAgent("generate_first_page"), true);
  assert.equal(isContinueActionAgent("generate_all_pages"), true);
  assert.equal(isContinueActionAgent("generate_architecture"), true);
  assert.equal(isContinueActionAgent("plan_all"), false);
});

test("exact-response hooks attach MessagePresentation to the delivered assistant reply", () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  registerExactResponseHooks({
    registerHook: (() => {}) as any,
    on: ((name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler)) as any,
  });

  const presentation = buildSuggestedAgentsPresentation("project-123", ["plan_all"], "", undefined, [scheduledStartButton]);
  assert.ok(presentation);
  const toolResult = exactToolResult("Choose Start or Wait.", {}, presentation);
  const ctx = {
    sessionKey: "session-1",
    toolName: "ai8080_start_project",
    channel: "webchat",
    channelId: "main",
  };

  handlers.get("after_tool_call")?.({ toolName: "ai8080_start_project", result: toolResult }, ctx);
  const rewritten = handlers.get("before_message_write")?.({
    message: { role: "assistant", content: [{ type: "text", text: "model text" }] },
    sessionKey: "session-1",
  }, ctx);
  assert.equal(rewritten.message.content[0].text, "Choose Start or Wait.");

  const delivered = handlers.get("reply_payload_sending")?.({
    payload: { text: "Choose Start or Wait." },
    sessionKey: "session-1",
  }, ctx);
  assert.equal(delivered.payload.presentation.title, "8080.ai");
  const deliveredButtons = delivered.payload.presentation.blocks.find((block: { type: string }) => block.type === "buttons");
  assert.deepEqual(deliveredButtons.buttons.map((button: { label: string }) => button.label), ["Start"]);
});

test("terminal project responses release the chat turn without leaking into the next reply", () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  registerExactResponseHooks({
    registerHook: (() => {}) as any,
    on: ((name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler)) as any,
  });

  const presentation = buildSuggestedAgentsPresentation("project-123", ["plan_all"], "", undefined, [scheduledStartButton]);
  const toolResult = exactToolResult(
    "Choose Start or Wait.",
    { projectId: "project-123", phase: "started" },
    presentation,
    { terminate: true }
  );
  const ctx = {
    sessionKey: "terminal-session",
    toolName: "ai8080_start_project",
    channel: "webchat",
    channelId: "main",
  };

  assert.equal(toolResult.terminate, true);
  assert.equal(toolResult.details.turnComplete, true);

  handlers.get("after_tool_call")?.({ toolName: "ai8080_start_project", result: toolResult }, ctx);
  const nextReply = handlers.get("before_message_write")?.({
    message: { role: "assistant", content: [{ type: "text", text: "next turn" }] },
    sessionKey: "terminal-session",
  }, ctx);
  assert.equal(nextReply, undefined);
});

test("schedule reads remain available but Wait cancellation is absent", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/projects/project-123/auto-runs/offer/wait")) {
      return Response.json({ status: "cancelled" });
    }
    if (url.endsWith("/projects/project-123/auto-runs")) {
      return Response.json({
        server_now: "2026-10-19T10:00:00+00:00",
        auto_runs: [scheduledStartButton.payload],
      });
    }
    if (url.endsWith("/projects/project-123")) {
      return Response.json({
        project: { id: "project-123", status: "active" },
        pending_suggested_agents: {
          agents: ["plan_all"],
          message_id: "message-1",
          buttons: [],
        },
      });
    }
    return new Response("Not found", { status: 404 });
  };

  const client = createApiClient({ apiKey: "test-key", apiBaseUrl: "https://api.example/api/v1" });
  const status = await client.getProjectStatus("project-123");
  const pending = extractPendingSuggestion(status.pending_suggested_agents);
  assert.equal(pending.buttons?.[0]?.kind, "auto_run");
  assert.equal(pending.buttons?.[0]?.payload?.entry_id, "offer");

  assert.equal("waitForAutoRun" in client, false);
  assert.equal(parseButtonValue(`8080_wait_${encodeURIComponent(JSON.stringify({ projectId: "project-123", entryId: "offer" }))}`), null);
  assert.equal(requests.some(request => request.url.endsWith("/wait")), false);

});

test("project status retries a transient auto-run lookup before rendering suggestions", async (t) => {
  const originalFetch = globalThis.fetch;
  let autoRunAttempts = 0;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/projects/project-retry/auto-runs")) {
      autoRunAttempts += 1;
      if (autoRunAttempts === 1) throw new TypeError("temporary connection failure");
      return Response.json({
        server_now: scheduledStartButton.payload.server_now,
        auto_runs: [scheduledStartButton.payload],
      });
    }
    if (url.endsWith("/projects/project-retry")) {
      return Response.json({
        project: { id: "project-retry", status: "active" },
        pending_suggested_agents: { agents: ["plan_all"], buttons: [] },
      });
    }
    return new Response("Not found", { status: 404 });
  };

  const client = createApiClient({ apiKey: "test-key", apiBaseUrl: "https://api.example/api/v1" });
  const status = await client.getProjectStatus("project-retry");
  const pending = extractPendingSuggestion(status.pending_suggested_agents);

  assert.equal(autoRunAttempts, 2);
  assert.equal(status.auto_runs_lookup_failed, false);
  assert.equal(hasScheduledAutoRunButton(pending.buttons), true);
});

test("project status exposes an auto-run lookup failure after bounded retries", async (t) => {
  const originalFetch = globalThis.fetch;
  let autoRunAttempts = 0;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/projects/project-failure/auto-runs")) {
      autoRunAttempts += 1;
      throw new TypeError("connection unavailable");
    }
    if (url.endsWith("/projects/project-failure")) {
      return Response.json({
        project: { id: "project-failure", status: "active" },
        pending_suggested_agents: { agents: ["plan_all"], buttons: [] },
      });
    }
    return new Response("Not found", { status: 404 });
  };

  const client = createApiClient({ apiKey: "test-key", apiBaseUrl: "https://api.example/api/v1" });
  const status = await client.getProjectStatus("project-failure");

  assert.equal(autoRunAttempts, 2);
  assert.equal(status.auto_runs_lookup_failed, true);
});
