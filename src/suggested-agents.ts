export type PendingSuggestion = {
  agents: string[];
  messageId: string;
  sessionId: string;
  buttons?: any[];
};

function isAutoRunButton(button: unknown): boolean {
  return Boolean(
    button &&
    typeof button === "object" &&
    (button as Record<string, unknown>).kind === "auto_run"
  );
}

function isSameButton(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return a.key === b.key && a.action === b.action && a.label === b.label;
}

/**
 * Combines buttons emitted by the event stream with buttons from the latest
 * project status. Project status is authoritative for auto-runs because it is
 * enriched from GET /auto-runs and reflects the currently scheduled Wait.
 */
export function mergeSuggestedButtons(
  eventButtons?: any[],
  statusButtons?: any[]
): any[] | undefined {
  if (eventButtons === undefined) return statusButtons;
  if (statusButtons === undefined) return eventButtons;

  const normalButtons = [...eventButtons, ...statusButtons]
    .filter((button) => !isAutoRunButton(button))
    .filter((button, index, buttons) =>
      buttons.findIndex((candidate) => isSameButton(candidate, button)) === index
    );
  const currentAutoRunButtons = statusButtons.filter(isAutoRunButton);
  return [...normalButtons, ...currentAutoRunButtons];
}

const RESERVED_PENDING_KEYS = new Set(["agents", "message_id", "messageId", "session_id", "sessionId", "buttons"]);

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function extractAgentList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((agent): agent is string => typeof agent === "string");
  }

  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.agents)) {
    return record.agents.filter((agent): agent is string => typeof agent === "string");
  }

  const agents: string[] = [];
  for (const [key, entry] of Object.entries(record)) {
    if (RESERVED_PENDING_KEYS.has(key)) continue;
    if (typeof entry === "string") agents.push(entry);
    else if (entry === true) agents.push(key);
  }
  return agents;
}

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

  const buttons = Array.isArray(record.buttons) ? record.buttons : undefined;

  const explicitAgents = extractAgentList(record.agents);
  if (explicitAgents.length > 0) {
    return {
      agents: explicitAgents,
      messageId,
      sessionId,
      buttons,
    };
  }

  return { agents: extractAgentList(record), messageId, sessionId, buttons };
}

export function extractEventSuggestion(event: unknown): PendingSuggestion {
  if (!event || typeof event !== "object") {
    return { agents: [], messageId: "", sessionId: "" };
  }

  const record = event as Record<string, unknown>;
  const pending = extractPendingSuggestion(record.pending_suggested_agents);
  const agents = uniqueStrings([
    ...extractAgentList(record.agents),
    ...extractAgentList(record.suggested_agents),
    ...extractAgentList(record.suggestedAgents),
    ...extractAgentList(record.pending_suggested_agents),
    ...pending.agents,
  ]);
  const buttons =
    Array.isArray(record.buttons)
      ? record.buttons
      : Array.isArray(record.suggested_buttons)
        ? record.suggested_buttons
        : Array.isArray(record.pending_suggested_buttons)
          ? record.pending_suggested_buttons
          : pending.buttons;
  const messageId =
    typeof record.message_id === "string"
      ? record.message_id
      : typeof record.messageId === "string"
        ? record.messageId
        : pending.messageId;
  const sessionId =
    typeof record.session_id === "string"
      ? record.session_id
      : typeof record.sessionId === "string"
        ? record.sessionId
        : pending.sessionId;

  return { agents, messageId, sessionId, buttons };
}
