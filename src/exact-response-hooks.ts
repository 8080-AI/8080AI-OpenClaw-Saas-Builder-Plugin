import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { log } from "../logger.ts";

type HookHandler = (event: any, ctx: HookContext) => unknown;
type HookApi = Pick<OpenClawPluginApi, "registerHook"> & {
  on?: (hookName: string, handler: HookHandler, opts?: { priority?: number }) => void;
};
type HookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolName?: string;
  toolCallId?: string;
};
type MessageRecord = Record<string, unknown> & {
  role?: string;
  content?: unknown;
  details?: unknown;
  toolName?: unknown;
};
type PendingReply =
  | { mode: "exact"; text: string; expiresAt: number; toolName?: string }
  | { mode: "silent"; expiresAt: number; toolName?: string };

const AI8080_TOOL_PREFIX = "ai8080_";
const PENDING_TTL_MS = 120_000;
const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);
const pendingReplies = new Map<string, PendingReply>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sessionKey(ctx: HookContext = {}, event?: Record<string, unknown>): string {
  return (
    asString(ctx.sessionKey) ??
    asString(event?.sessionKey) ??
    asString(ctx.sessionId) ??
    asString(ctx.agentId) ??
    "_global"
  );
}

function pruneExpired(now = Date.now()): void {
  for (const [key, pending] of pendingReplies.entries()) {
    if (pending.expiresAt <= now) pendingReplies.delete(key);
  }
}

function remember(ctx: HookContext, pending: Omit<PendingReply, "expiresAt">): void {
  pruneExpired();
  pendingReplies.set(sessionKey(ctx), {
    ...pending,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

function consume(ctx: HookContext, event?: Record<string, unknown>): PendingReply | undefined {
  pruneExpired();
  const key = sessionKey(ctx, event);
  const pending = pendingReplies.get(key);
  if (pending) pendingReplies.delete(key);
  return pending;
}

function collectTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      const record = asRecord(block);
      if (!record) return "";
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractMarkedResponse(text: string): string | undefined {
  const match = text.match(
    /=== START OF RESPONSE TO COPY ===\s*([\s\S]*?)\s*=== END OF RESPONSE TO COPY ===/
  );
  return match?.[1]?.trim() || undefined;
}

function messageHasToolCall(message: MessageRecord): boolean {
  const { content } = message;
  if (!Array.isArray(content)) return false;

  return content.some((block) => {
    const record = asRecord(block);
    return (
      Boolean(record) &&
      typeof record?.id === "string" &&
      typeof record?.type === "string" &&
      TOOL_CALL_BLOCK_TYPES.has(record.type)
    );
  });
}

function toolNameFrom(event: Record<string, unknown>, message?: MessageRecord): string | undefined {
  return (
    asString(event.toolName) ??
    (typeof message?.toolName === "string" ? message.toolName : undefined)
  );
}

function modeFromResult(toolName: string | undefined, result: unknown): Omit<PendingReply, "expiresAt"> | undefined {
  if (!toolName?.startsWith(AI8080_TOOL_PREFIX)) return undefined;

  const record = asRecord(result);
  if (!record) return undefined;

  const details = asRecord(record.details);
  const contentText = collectTextContent(record.content);
  const markedText = extractMarkedResponse(contentText);
  const explicitExactText = asString(details?.exactUserResponse);
  const responseMode = asString(details?.responseMode);
  const isSilent =
    responseMode === "silent" ||
    details?.silent === true ||
    details?.suppressUserResponse === true;

  if (isSilent && !contentText.trim()) {
    return { mode: "silent", toolName };
  }

  const exactText = explicitExactText ?? markedText ?? contentText.trim();
  if (!exactText) return undefined;

  return { mode: "exact", text: exactText, toolName };
}

function replaceAssistantText(message: MessageRecord, text: string): MessageRecord {
  return {
    ...message,
    content: [{ type: "text", text }],
  };
}

export function registerExactResponseHooks(api: HookApi): void {
  const register = (
    hookName: string,
    handler: HookHandler,
    legacyOptions: { name: string; description: string }
  ): void => {
    if (typeof api.on === "function") {
      api.on(hookName, handler, { priority: 100 });
      log.info("registered typed exact response hook", { hookName });
      return;
    }

    if (typeof api.registerHook !== "function") return;
    api.registerHook(hookName, handler, legacyOptions);
    log.info("registered legacy exact response hook", { hookName });
  };

  register(
    "tool_result_persist",
    (event: { message?: unknown; toolName?: string }, ctx: HookContext) => {
      const message = asRecord(event.message) as MessageRecord | undefined;
      if (!message || message.role !== "toolResult") return;

      const toolName = toolNameFrom(event as Record<string, unknown>, message);
      const pending = modeFromResult(toolName, message);
      if (!pending) return;

      remember({ ...ctx, toolName }, pending);
      log.info("exact response captured from tool_result_persist", {
        toolName,
        mode: pending.mode,
      });
    },
    {
      name: "8080.ai exact response capture",
      description: "Capture 8080.ai tool output before assistant rewrite.",
    }
  );

  register(
    "after_tool_call",
    (event: { result?: unknown; toolName?: string }, ctx: HookContext) => {
      const toolName = asString(event.toolName) ?? ctx.toolName;
      const pending = modeFromResult(toolName, event.result);
      if (!pending) return;

      remember({ ...ctx, toolName }, pending);
      log.info("exact response captured from after_tool_call", {
        toolName,
        mode: pending.mode,
      });
    },
    {
      name: "8080.ai exact response fallback capture",
      description: "Fallback capture for 8080.ai tool output after execution.",
    }
  );

  register(
    "before_message_write",
    (event: { message?: unknown }, ctx: HookContext) => {
      const message = asRecord(event.message) as MessageRecord | undefined;
      if (!message || message.role !== "assistant") return;
      if (messageHasToolCall(message)) return;

      const pending = consume(ctx, event as Record<string, unknown>);
      if (!pending) return;

      log.info("exact response applied before assistant message write", {
        toolName: pending.toolName,
        mode: pending.mode,
      });

      if (pending.mode === "silent") {
        return { block: true };
      }

      return { message: replaceAssistantText(message, pending.text) };
    },
    {
      name: "8080.ai exact assistant response",
      description: "Replace assistant prose with exact 8080.ai tool output.",
    }
  );
}
