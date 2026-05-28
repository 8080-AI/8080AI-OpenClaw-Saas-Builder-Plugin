export type PendingSuggestion = {
  agents: string[];
  messageId: string;
  sessionId: string;
};

const RESERVED_PENDING_KEYS = new Set(["agents", "message_id", "messageId", "session_id", "sessionId"]);

export function extractPendingSuggestion(pending: unknown): PendingSuggestion {
  if (!pending || typeof pending !== "object") {
    return { agents: [], messageId: "", sessionId: "" };
  }

  const record = pending as Record<string, unknown>;
  const messageId =
    typeof record.message_id === "string"
      ? record.message_id
      : typeof record.messageId === "string"
        ? record.messageId
        : "";
  const sessionId =
    typeof record.session_id === "string"
      ? record.session_id
      : typeof record.sessionId === "string"
        ? record.sessionId
        : "";

  if (Array.isArray(record.agents)) {
    return {
      agents: record.agents.filter((agent): agent is string => typeof agent === "string"),
      messageId,
      sessionId,
    };
  }

  const agents: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED_PENDING_KEYS.has(key)) continue;
    if (typeof value === "string") agents.push(value);
    else if (value === true) agents.push(key);
  }

  return { agents, messageId, sessionId };
}
