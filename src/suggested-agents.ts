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
 * project status. Stream workflow buttons are authoritative; status only
 * enriches auto-runs because it is
 * enriched from GET /auto-runs and reflects the current automatic schedule.
 */
export function mergeSuggestedButtons(
  eventButtons?: any[],
  statusButtons?: any[]
): any[] | undefined {
  if (eventButtons === undefined) return statusButtons;
  if (statusButtons === undefined) return eventButtons;

  const normalButtons = eventButtons
    .filter((button) => !isAutoRunButton(button))
    .filter((button, index, buttons) =>
      buttons.findIndex((candidate) => isSameButton(candidate, button)) === index
    );
  const currentAutoRunButtons = statusButtons.filter(isAutoRunButton);
  return [...normalButtons, ...currentAutoRunButtons];
}

export function hasScheduledAutoRunButton(buttons?: any[], buttonKey?: string): boolean {
  return Boolean(buttons?.some((button) =>
    isAutoRunButton(button) &&
    button.action === "wait_auto_run" &&
    button.payload?.status === "scheduled" &&
    (!buttonKey || button.payload?.button_key === buttonKey) &&
    typeof button.payload?.fire_at === "string" &&
    Number.isFinite(Date.parse(button.payload.fire_at))
  ));
}

export function isSuggestedActionReady(options: {
  hasBackendAction: boolean;
  checkpointReady: boolean;
  requiresScheduledAutoRun: boolean;
  buttons?: any[];
}): boolean {
  if (!options.hasBackendAction || !options.checkpointReady) return false;
  return !options.requiresScheduledAutoRun || hasScheduledAutoRunButton(options.buttons);
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

// Normalize actions explicitly supplied by backend buttons, including auto-runs.
// Artifact state and completion messages are deliberately not action sources.
function extractButtonAgents(buttons?: any[]): string[] {
  return (buttons ?? []).flatMap((button) => {
    if (!button || button.enabled === false) return [];
    if (button.kind === "auto_run") {
      if (!hasScheduledAutoRunButton([button])) return [];
      const labels: Record<string, string> = {
        "start": "plan_all",
        "generate first page": "generate_first_page",
        "generate all pages": "generate_all_pages",
        "generate architecture": "generate_architecture",
      };
      const agent = labels[String(button.payload?.label ?? "").trim().toLowerCase()];
      return agent ? [agent] : [];
    }
    if (button.action === "trigger_agents") return extractAgentList(button.payload?.agents);
    if (button.action === "continue" || button.action === "resume_design") return ["continue"];
    return [];
  });
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

  const legacyAgents = extractAgentList(record);
  return { agents: legacyAgents.length > 0 ? legacyAgents : uniqueStrings(extractButtonAgents(buttons)), messageId, sessionId, buttons };
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

  return { agents: agents.length > 0 ? agents : uniqueStrings(extractButtonAgents(buttons)), messageId, sessionId, buttons };
}

/** Preserve the backend review gate; labels alone do not identify its resume phase. */
export function getResumeDesignPhase(buttons?: any[]): string | undefined {
  const button = buttons?.find(button => button?.action === "resume_design" && button.enabled !== false && typeof button.payload?.phase === "string");
  return button?.payload.phase;
}

/** Recover the action explicitly offered by the latest backend reply when
 * pending_suggested_agents is cleared at a manual review gate. Never infer an
 * action from completed logs, artifacts, or older conversation messages. */
export function extractLatestReplySuggestion(messages: unknown, since = 0): PendingSuggestion {
  if (!Array.isArray(messages)) return { agents: [], messageId: "", sessionId: "" };
  const latest = [...messages].reverse().find(message => message && typeof message === "object" &&
    ["assistant", "system"].includes(message.author ?? message.role));
  if (!latest) return { agents: [], messageId: "", sessionId: "" };
  const rawTime = latest.created_at ?? latest.createdAt;
  if (typeof rawTime === "string") {
    const time = Date.parse(/(?:z|[+-]\d{2}:?\d{2})$/i.test(rawTime) ? rawTime : `${rawTime}Z`);
    if (Number.isFinite(time) && time < since - 5_000) return { agents: [], messageId: "", sessionId: "" };
  }
  const messageId = String(latest.message_id ?? latest.id ?? "");
  const explicit = extractEventSuggestion({ ...latest, message_id: messageId });
  if (explicit.agents.length) return explicit;
  // Only structured suggested-agent/button data authorizes a manual action.
  // Never manufacture a button by parsing prose in an assistant reply.
  return { agents: [], messageId: "", sessionId: "" };
}
