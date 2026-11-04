import test from "node:test";
import assert from "node:assert/strict";
import { registerExactResponseHooks } from "../src/exact-response-hooks.ts";
import { exactToolResult } from "../src/exact-response.ts";
import { buildSuggestedAgentsPresentation } from "../src/review-continue.ts";

test("generation text and buttons survive a follow-up status result and reach reply delivery", () => {
  const hooks = new Map<string, Function>();
  registerExactResponseHooks({
    on: (name, handler) => { hooks.set(name, handler); },
  } as Parameters<typeof registerExactResponseHooks>[0]);
  const ctx = { sessionKey: "generation-delivery-test" };
  const presentation = buildSuggestedAgentsPresentation("project", ["generate_architecture", "review"]);
  hooks.get("after_tool_call")!({
    toolName: "ai8080_select_button",
    result: exactToolResult("Generate Architecture / Review", { protectFromStatusLookup: true }, presentation),
  }, ctx);
  const blocked = hooks.get("before_tool_call")!({ toolName: "ai8080_get_project_status" }, ctx);
  assert.equal(blocked.block, true);
  assert.equal(hooks.get("before_tool_call")!({ toolName: "ai8080_task_list" }, ctx), undefined);
  // Even a runtime that ignores the guard must preserve the generation reply.
  hooks.get("after_tool_call")!({ toolName: "ai8080_get_project_status", result: exactToolResult("Generic status") }, ctx);
  const response = hooks.get("before_message_write")!({ message: { role: "assistant", content: [{ type: "text", text: "Model prose" }] } }, ctx);
  assert.equal(response.message.content[0].text, "Generate Architecture / Review");
  const delivery = hooks.get("reply_payload_sending")!({ payload: { text: "Model paraphrased this as a sentence", replyToId: "original" } }, ctx);
  assert.equal(delivery.payload.text, "Generate Architecture / Review");
  assert.equal(delivery.payload.replyToId, "original");
  assert.ok(delivery.payload.presentation.blocks.length > 0);
  // Once delivered, a later explicit status request is permitted.
  assert.equal(hooks.get("before_tool_call")!({ toolName: "ai8080_get_project_status" }, ctx), undefined);
  assert.equal(hooks.get("reply_payload_sending")!({ payload: {} }, ctx), undefined);
});

test("project creation delivers exact next steps instead of a model summary", () => {
  const hooks = new Map<string, Function>();
  registerExactResponseHooks({ on: (name, handler) => { hooks.set(name, handler); } } as Parameters<typeof registerExactResponseHooks>[0]);
  const ctx = { sessionKey: "start-project-exact-delivery" };
  const text = "Your calculator project is ready.\n\n### Suggested Next Steps:\n\n1. Wait\n2. Start";
  hooks.get("after_tool_call")!({ toolName: "ai8080_start_project", result: exactToolResult(text) }, ctx);
  hooks.get("before_message_write")!({ message: { role: "assistant", content: "Planning will start soon." } }, ctx);
  const delivery = hooks.get("reply_payload_sending")!({ payload: { text: "You can click Start." } }, ctx);
  assert.equal(delivery.payload.text, text);
  assert.equal(hooks.get("reply_payload_sending")!({ payload: { text: "Next turn" } }, ctx), undefined);
});

test("status cannot overwrite manual buttons after assistant write but before delivery", () => {
  const hooks = new Map<string, Function>();
  registerExactResponseHooks({ on: (name, handler) => { hooks.set(name, handler); } } as Parameters<typeof registerExactResponseHooks>[0]);
  const ctx = { sessionKey: "manual-checkpoint-delivery-gap" };
  const text = "### Suggested Next Steps:\n1. Generate All Pages";
  const presentation = buildSuggestedAgentsPresentation("project", ["generate_all_pages"]);
  hooks.get("after_tool_call")!({ toolName: "ai8080_start_project", result: exactToolResult(text, { protectFromStatusLookup: true }, presentation) }, ctx);
  hooks.get("before_message_write")!({ message: { role: "assistant", content: "model response" } }, ctx);
  assert.equal(hooks.get("before_tool_call")!({ toolName: "ai8080_get_project_status" }, ctx).block, true);
  // Older runtimes may ignore the block, so the fallback capture must also
  // refuse the status result during the write-to-delivery handoff.
  hooks.get("after_tool_call")!({ toolName: "ai8080_get_project_status", result: exactToolResult("Project Status: active") }, ctx);
  hooks.get("before_message_write")!({ message: { role: "assistant", content: "Project Status: active" } }, ctx);
  const delivered = hooks.get("reply_payload_sending")!({ payload: { text: "Project Status: active" } }, ctx);
  assert.equal(delivered.payload.text, text);
  assert.ok(delivered.payload.presentation);
  assert.equal(hooks.get("before_tool_call")!({ toolName: "ai8080_get_project_status" }, ctx), undefined);
});
