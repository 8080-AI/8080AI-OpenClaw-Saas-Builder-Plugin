import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "./api-client.ts";
import { exactToolResult } from "./exact-response.ts";
import { registerExactResponseHooks } from "./exact-response-hooks.ts";
import { extractPendingSuggestion, mergeSuggestedButtons } from "./suggested-agents.ts";
import {
  buildSuggestedAgentChoices,
  buildSuggestedAgentsJsonl,
  buildSuggestedAgentsPresentation,
  buildSuggestedAgentsText,
  parseButtonValue,
} from "./review-continue.ts";

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
    fire_at: "2026-10-19T10:00:30+00:00",
    server_now: "2026-10-19T10:00:00+00:00",
  },
};

test("scheduled Start renders Start first, Wait second, and a 30-second note", () => {
  const buttons = [scheduledStartButton];
  const presentation = buildSuggestedAgentsPresentation("project-123", ["plan_all"], "", undefined, buttons);
  const text = buildSuggestedAgentsText("project-123", ["plan_all"], "", undefined, buttons);
  const jsonl = JSON.parse(buildSuggestedAgentsJsonl("project-123", ["plan_all"], undefined, buttons));
  const buttonBlock = presentation?.blocks.find((block) => block.type === "buttons");
  const textBlock = presentation?.blocks.find((block) => block.type === "text");

  assert.ok(buttonBlock?.type === "buttons");
  assert.deepEqual(buttonBlock.buttons.map((button) => button.label), ["Start", "Wait"]);
  assert.deepEqual(buttonBlock.buttons.map((button) => button.action), [
    { type: "command", command: "/ai8080 select-button 1" },
    { type: "command", command: "/ai8080 select-button 2" },
  ]);
  assert.ok(textBlock?.type === "text");
  assert.match(textBlock.text, /Start will trigger automatically on 8080\.ai in 30 seconds/);
  assert.match(text, /1\. Start\n2\. Wait/);
  assert.match(text, /To run it manually, choose Wait first, then choose Start/);
  assert.match(text, /`\/ai8080 select-button 2` cancels the automatic action directly/);
  assert.deepEqual(jsonl.buttons.map((button: { label: string }) => button.label), ["Start", "Wait"]);

  const parsed = parseButtonValue(buttonBlock.buttons[1].value ?? "");
  assert.deepEqual(parsed, {
    action: "wait",
    projectId: "project-123",
    entryId: "offer",
    label: "Start",
  });
});

test("saved scheduled Generate First Page derives its label and renders Wait as option 1", () => {
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
  assert.deepEqual(buttonBlock.buttons.map((button) => button.label), ["Wait", "Generate First Page"]);
  assert.ok(textBlock?.type === "text");
  assert.match(textBlock.text, /Generate First Page will trigger automatically/);
  const choices = buildSuggestedAgentChoices(
    "project-123",
    ["continue"],
    undefined,
    buttons
  );
  assert.equal(parseButtonValue(choices[0]?.value ?? "")?.action, "wait");
  assert.equal(parseButtonValue(choices[1]?.value ?? "")?.action, "continue");
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
    "Wait",
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

for (const timedLabel of ["Generate Architecture", "Generate All Pages"]) {
  test(`scheduled ${timedLabel} renders Wait, the action, and its countdown`, () => {
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
      ["Wait", timedLabel, "Review"]
    );
    assert.ok(textBlock?.type === "text");
    assert.match(textBlock.text, new RegExp(`${timedLabel} will trigger automatically on 8080\\.ai in 30 seconds`));
    assert.match(text, new RegExp(`1\\. Wait\\n2\\. ${timedLabel}\\n3\\. Review`));
    assert.match(text, new RegExp(`choose Wait first, then choose ${timedLabel}`));

    const parsed = parseButtonValue(buttonBlock.buttons[0].value ?? "");
    assert.deepEqual(parsed, {
      action: "wait",
      projectId: "project-123",
      entryId: `gate-${timedLabel.toLowerCase().replaceAll(" ", "-")}`,
      label: timedLabel,
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
  assert.deepEqual(deliveredButtons.buttons.map((button: { label: string }) => button.label), ["Start", "Wait"]);
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

test("project status enriches pending actions from GET auto-runs and Wait posts without a body", async (t) => {
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

  assert.deepEqual(await client.waitForAutoRun("project-123", "offer"), { status: "cancelled" });
  const waitRequest = requests.find((request) => request.url.endsWith("/auto-runs/offer/wait"));
  assert.equal(waitRequest?.init?.method, "POST");
  assert.equal(waitRequest?.init?.body, undefined);
  assert.equal(new Headers(waitRequest?.init?.headers).get("Content-Type"), "application/json");
});
