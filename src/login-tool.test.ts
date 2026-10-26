import test from "node:test";
import assert from "node:assert/strict";
import { createLoginTool } from "./login-tool.ts";

test("login tool advertises natural-language aliases and forbids automatic browsing", () => {
  const tool = createLoginTool({
    stateDir: () => "/tmp/unused-ai8080-login-test",
    siteUrl: "https://8080.ai",
    apiBaseUrl: "https://api.8080.ai/api/v1",
  });

  assert.match(tool.description, /8080ai/);
  assert.match(tool.description, /8089\.ai/);
  assert.match(tool.description, /Do not use browser automation/);
});

test("login action returns exact setup instructions and a user-clickable link", async () => {
  const tool = createLoginTool({
    stateDir: () => "/tmp/unused-ai8080-login-test",
    siteUrl: "https://8080.ai",
    apiBaseUrl: "https://api.8080.ai/api/v1",
  });

  const result = await tool.execute("login-test", { action: "login" }, undefined, () => {});
  const text = result.content[0]?.text ?? "";

  assert.match(text, /Generate an OpenClaw API Key/);
  assert.match(text, /set api-key <api-key>/);
  assert.equal(result.details.responseMode, "exact");
  assert.equal(result.details.exactUserResponse, text);
  assert.deepEqual(result.presentation, {
    title: "8080.ai",
    blocks: [{
      type: "buttons",
      buttons: [{
        label: "Open 8080.ai Login",
        url: "https://8080.ai",
        style: "primary",
      }],
    }],
  });
});
