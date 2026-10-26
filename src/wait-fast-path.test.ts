import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWaitFastPathHandler } from "./wait-fast-path.ts";
import { writeApiKey } from "./api-key.ts";
import { readLatestSuggestions, writeLatestSuggestions } from "./suggestions-state.ts";
import { buildSuggestedAgentChoices } from "./review-continue.ts";

test("Wait fast path cancels before an LLM turn", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(process.cwd(), "test-wait-fast-path-"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const timestamp = new Date().toISOString();
  const encoded = Buffer.from(JSON.stringify({ uid: "test-user", ts: timestamp })).toString("base64url");
  await writeApiKey(stateDir, `sk-8080ai-${encoded}`, {
    uid: "test-user",
    issuedAt: Date.parse(timestamp),
    expiresAt: null,
  });
  await writeLatestSuggestions(stateDir, "session-1", {
    projectId: "project-1",
    messageId: "entry-1",
    agents: ["plan_all"],
    buttons: [{
      key: "start",
      kind: "auto_run",
      label: "Wait",
      action: "wait_auto_run",
      payload: {
        entry_id: "entry-1",
        button_key: "start",
        label: "Start",
        status: "scheduled",
        fire_at: "2099-01-01T00:00:30+00:00",
        server_now: "2099-01-01T00:00:00+00:00",
      },
    }],
  });

  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({ status: "cancelled" });
  };

  const handler = createWaitFastPathHandler({
    stateDir: () => stateDir,
    apiBaseUrl: "https://api.example/api/v1",
    sessionId: "session-1",
  });
  const result = await handler({ content: "wait" });

  assert.deepEqual(result, {
    handled: true,
    text:
      "Automatic Start was cancelled. Choose Start when you are ready to trigger it manually." +
      "\n\n### Suggested Next Steps:\n1. Start",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.example/api/v1/projects/project-1/auto-runs/entry-1/wait");
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(requests[0].init?.body, undefined);

  const updated = await readLatestSuggestions(stateDir, "session-1");
  assert.deepEqual(
    buildSuggestedAgentChoices(updated!.projectId, updated!.agents, undefined, updated!.buttons)
      .map((choice) => choice.label),
    ["Start"]
  );
  assert.equal(await handler({ content: "wait" }), undefined);
});

for (const timedLabel of ["Generate First Page", "Generate Architecture", "Generate All Pages"]) {
  test(`Wait fast path immediately cancels a saved ${timedLabel} auto-run`, async (t) => {
    const slug = timedLabel.toLowerCase().replaceAll(" ", "-");
    const stateDir = fs.mkdtempSync(path.join(process.cwd(), `test-wait-${slug}-`));
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    const timestamp = new Date().toISOString();
    const encoded = Buffer.from(JSON.stringify({ uid: "test-user", ts: timestamp })).toString("base64url");
    await writeApiKey(stateDir, `sk-8080ai-${encoded}`, {
      uid: "test-user",
      issuedAt: Date.parse(timestamp),
      expiresAt: null,
    });
    await writeLatestSuggestions(stateDir, "session-1", {
      projectId: "project-1",
      messageId: "message-1",
      agents: ["continue", "review"],
      buttons: [{
        key: "continue",
        kind: "auto_run",
        label: "Wait",
        action: "wait_auto_run",
        payload: {
          entry_id: `${slug}-entry-1`,
          button_key: "continue",
          label: timedLabel,
          status: "scheduled",
          fire_at: "2099-01-01T00:00:30+00:00",
          server_now: "2099-01-01T00:00:00+00:00",
        },
      }],
    });

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ status: "cancelled" });
    };

    const handler = createWaitFastPathHandler({
      stateDir: () => stateDir,
      apiBaseUrl: "https://api.example/api/v1",
      sessionId: "session-1",
    });
    const result = await handler({ content: "wait" });

    assert.deepEqual(result, {
      handled: true,
      text:
        `Automatic ${timedLabel} was cancelled. Choose ${timedLabel} when you are ready to trigger it manually.` +
        `\n\n### Suggested Next Steps:\n1. ${timedLabel}`,
    });
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      `https://api.example/api/v1/projects/project-1/auto-runs/${slug}-entry-1/wait`
    );

    const updated = await readLatestSuggestions(stateDir, "session-1");
    assert.deepEqual(
      buildSuggestedAgentChoices(updated!.projectId, updated!.agents, undefined, updated!.buttons)
        .map((choice) => choice.label),
      [timedLabel, "Review"]
    );
  });
}

test("Wait fast path ignores unrelated natural language", async () => {
  const handler = createWaitFastPathHandler({
    stateDir: () => "/unused",
    apiBaseUrl: "https://api.example/api/v1",
    sessionId: "session-1",
  });

  assert.equal(await handler({ content: "please wait while I explain" }), undefined);
});
