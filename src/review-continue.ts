
// Builds A2UI JSONL for the Review / Continue button pair shown after the
// requirement document is ready. Each line is a JSON object.
//
// Button values are prefixed with "8080_review_" or "8080_continue_" so
// the agent can recognise them when they arrive back as user messages.
import { AGENT_DISPLAY_NAMES, type Project } from "./api-client.ts";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";

export function buildRequirementsUrl(siteUrl: string, projectId: string, sessionId?: string): string {
  const base = siteUrl.replace(/\/$/, "");
  return sessionId
    ? `${base}/planning/${projectId}/${sessionId}/requirements`
    : `${base}/planning/${projectId}/requirements`;
}

export function buildReviewContinueJsonl(
  projectId: string,
  requirementDocUrl: string
): string {
  const lines = [
    JSON.stringify({
      type: "text",
      text: `Requirement document is ready for review.\nURL: ${requirementDocUrl}`,
    }),
    JSON.stringify({
      type: "buttons",
      buttons: [
        {
          label: "Review Document",
          value: `8080_review_${projectId}`,
          style: "secondary",
        },
        {
          label: "Continue Building",
          value: `8080_continue_${projectId}`,
          style: "primary",
        },
      ],
    }),
  ];
  return lines.join("\n");
}

export function buildProjectSelectionJsonl(projects: Project[]): string {
  const buttons = projects.map((p, i) => ({
    label: `${i + 1}. ${p.title} (${p.id})`,
    value: `8080_select_${p.id}`,
    style: "secondary"
  }));

  return JSON.stringify({
    type: "buttons",
    buttons: buttons
  });
}

/**
 * Builds a native OpenClaw MessagePresentation for project selection.
 * Used by tools in OpenClaw v2026.5+.
 */
export function buildProjectSelectionPresentation(projects: Project[]): MessagePresentation {
  return {
    title: "8080.ai Projects",
    blocks: [{
      type: "select",
      placeholder: "Choose a project...",
      options: projects.map((p) => ({
        label: `${p.title} (${p.id})`,
        value: `8080_select_${p.id}`,
        action: { type: "callback", value: `8080_select_${p.id}` },
      })),
    }],
  };
}

export type BackendButton = {
  key: string;
  kind: string;
  label: string;
  action: string;
  payload?: any;
};

type ScheduledAutoRun = {
  entry_id: string;
  button_key: string;
  label: string;
  status: "scheduled";
  fire_at: string;
  server_now?: string;
};

function normalizeActionLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Generate All Pages is included defensively for an exact backend entry, even
// though the backend does not currently schedule it. getScheduledAutoRun's
// label check prevents a Generate Architecture timer from leaking onto it.
const SUPPORTED_TIMED_ACTION_LABELS = new Set([
  "start",
  "generate first page",
  "generate all pages",
  "generate architecture",
]);

function getAutoRunButtonKey(agent: string): "start" | "continue" | undefined {
  if (agent === "plan_all" || (agent.startsWith("GROUP:") && agent.slice(6).split("|").includes("plan_all"))) {
    return "start";
  }
  if (
    agent === "continue" ||
    agent === "generate_first_page" ||
    agent === "generate_all_pages" ||
    agent === "generate_architecture"
  ) return "continue";
  return undefined;
}

function getScheduledAutoRun(agent: string, label: string | undefined, backendButtons?: BackendButton[]): ScheduledAutoRun | undefined {
  const expectedButtonKey = getAutoRunButtonKey(agent);
  if (!expectedButtonKey) return undefined;
  const normalizedLabel = label ? normalizeActionLabel(label) : undefined;
  for (const button of backendButtons ?? []) {
    if (button.kind !== "auto_run" || button.action !== "wait_auto_run") continue;
    const payload = button.payload as Partial<ScheduledAutoRun> | undefined;
    if (
      !payload ||
      payload.status !== "scheduled" ||
      typeof payload.entry_id !== "string" ||
      typeof payload.button_key !== "string" ||
      payload.button_key !== expectedButtonKey ||
      typeof payload.label !== "string" ||
      typeof payload.fire_at !== "string" ||
      !Number.isFinite(Date.parse(payload.fire_at))
    ) continue;
    if (!normalizedLabel || normalizeActionLabel(payload.label) === normalizedLabel) {
      return payload as ScheduledAutoRun;
    }
  }
  return undefined;
}

function buildWaitButtonValue(projectId: string, autoRun: ScheduledAutoRun): string {
  return `8080_wait_${encodeURIComponent(JSON.stringify({
    projectId,
    entryId: autoRun.entry_id,
    label: autoRun.label,
    fireAt: autoRun.fire_at,
    serverNow: autoRun.server_now,
  }))}`;
}

function buildAutoRunNote(autoRun: ScheduledAutoRun | undefined): string {
  if (!autoRun) return "";
  const label = normalizeActionLabel(autoRun.label);
  if (!SUPPORTED_TIMED_ACTION_LABELS.has(label)) return "";

  const fireAt = Date.parse(autoRun.fire_at);
  const serverNow = autoRun.server_now ? Date.parse(autoRun.server_now) : Number.NaN;
  const seconds = Number.isFinite(serverNow)
    ? Math.max(0, Math.ceil((fireAt - serverNow) / 1000))
    : 30;
  return `Note: ${autoRun.label} will trigger automatically on 8080.ai in ${seconds} second${seconds === 1 ? "" : "s"}. To run it manually, choose Wait first, then choose ${autoRun.label}.`;
}

export function getLabelForAgent(
  agent: string,
  continueButtonLabel?: string | boolean,
  backendButtons?: BackendButton[]
): string {
  // Keep the plan-all action name concise regardless of the legacy label
  // returned by the backend.
  if (
    agent === "plan_all" ||
    (agent.startsWith("GROUP:") && agent.slice(6).split("|").includes("plan_all"))
  ) return "Start";

  if (backendButtons && backendButtons.length > 0) {
    if (
      agent === "continue" ||
      agent === "generate_first_page" ||
      agent === "generate_all_pages" ||
      agent === "generate_architecture"
    ) {
      const btn = backendButtons.find(b =>
        b.action === "continue" ||
        b.action === "resume_design" ||
        b.key === "run_agents" ||
        (b.payload && b.payload.agents && (
          b.payload.agents.includes("continue") ||
          b.payload.agents.includes("generate_first_page") ||
          b.payload.agents.includes("generate_all_pages") ||
          b.payload.agents.includes("generate_architecture")
        ))
      );
      if (btn) return btn.label;

      // Saved suggestions do not persist continueButtonLabel separately. If
      // no regular action button exists, retain the auto-run payload label so
      // direct `wait` can match timed Continue actions without readiness lookups.
      const expectedButtonKey = getAutoRunButtonKey(agent);
      const autoRunPayload = backendButtons
        .find((button) =>
          button.kind === "auto_run" &&
          button.action === "wait_auto_run" &&
          button.payload?.button_key === expectedButtonKey &&
          typeof button.payload?.label === "string"
        )?.payload as Partial<ScheduledAutoRun> | undefined;
      if (typeof autoRunPayload?.label === "string") return autoRunPayload.label;
    } else if (agent === "review") {
      const btn = backendButtons.find(b =>
        b.action === "review" ||
        b.key === "review" ||
        b.key === "review_document" ||
        b.label.toLowerCase().includes("review")
      );
      if (btn) return btn.label;
    } else {
      const btn = backendButtons.find(b =>
        b.payload && b.payload.agents &&
        (b.payload.agents.includes(agent) ||
         (agent.startsWith("GROUP:") && agent.slice(6).split('|').every((a: string) => b.payload.agents.includes(a))))
      );
      if (btn) return btn.label;
    }
  }

  // Fallback to default labels
  if (agent.startsWith("GROUP:")) {
    const subAgents = agent.slice(6).split('|');
    const subLabels = subAgents.map(a => {
      const rawLabel = AGENT_DISPLAY_NAMES[a] ?? a;
      return rawLabel.includes(" ") ? rawLabel.split(" ").slice(1).join(" ") : rawLabel;
    });
    return `🚀 Run ${subLabels.join(", ")}`;
  }

  if (
    agent === "continue" ||
    agent === "generate_first_page" ||
    agent === "generate_all_pages" ||
    agent === "generate_architecture"
  ) {
    if (typeof continueButtonLabel === "string") {
      return continueButtonLabel;
    }
    if (agent === "generate_first_page") return "Generate First Page";
    if (agent === "generate_all_pages") return "Generate All Pages";
    if (agent === "generate_architecture") return "Generate Architecture";
    return continueButtonLabel ? "Generate First Page" : "Continue";
  }
  if (agent === "review") {
    return "Review";
  }
  return AGENT_DISPLAY_NAMES[agent] ?? agent;
}

export type SuggestedAgentChoice = {
  kind: "agent" | "wait";
  label: string;
  value: string;
  agent?: string;
  entryId?: string;
};

function choiceStyle(choice: SuggestedAgentChoice): "primary" | "secondary" {
  if (choice.kind === "wait") return "secondary";
  const agent = choice.agent ?? "";
  return (
    agent === "plan_all" ||
    agent.includes("plan_all") ||
    agent === "continue" ||
    agent === "generate_first_page" ||
    agent === "generate_all_pages" ||
    agent === "generate_architecture"
  ) ? "primary" : "secondary";
}

function buildAgentButtonValue(projectId: string, agent: string): string {
  if (agent === "review") return `8080_review_${projectId}`;
  if (
    agent === "continue" ||
    agent === "generate_first_page" ||
    agent === "generate_all_pages" ||
    agent === "generate_architecture"
  ) return `8080_continue_${projectId}`;

  const agentsList = agent.startsWith("GROUP:") ? agent.slice(6).split("|") : [agent];
  return `8080_trigger_agents_${projectId}_${encodeURIComponent(JSON.stringify(agentsList))}`;
}

/**
 * Returns choices in the same order shown in the plain-text response.
 * Start remains the primary first step when it has a scheduled auto-run;
 * Wait follows it as the cancellation option. Other scheduled actions retain
 * the existing Wait-first ordering.
 */
export function buildSuggestedAgentChoices(
  projectId: string,
  agents: string[],
  continueButtonLabel?: string | boolean,
  backendButtons?: BackendButton[]
): SuggestedAgentChoice[] {
  return agents.flatMap((agent) => {
    const label = getLabelForAgent(agent, continueButtonLabel, backendButtons);
    const actionChoice: SuggestedAgentChoice = {
      kind: "agent",
      label,
      value: buildAgentButtonValue(projectId, agent),
      agent,
    };
    const autoRun = getScheduledAutoRun(agent, label, backendButtons);
    if (!autoRun) return [actionChoice];
    const waitChoice: SuggestedAgentChoice = {
      kind: "wait" as const,
      label: "Wait",
      value: buildWaitButtonValue(projectId, autoRun),
      entryId: autoRun.entry_id,
    };
    return normalizeActionLabel(label) === "start"
      ? [actionChoice, waitChoice]
      : [waitChoice, actionChoice];
  });
}

export function buildSuggestedAgentsJsonl(
  projectId: string,
  agents: string[],
  continueButtonLabel?: string | boolean,
  backendButtons?: any[]
): string {
  const buttons = buildSuggestedAgentChoices(projectId, agents, continueButtonLabel, backendButtons)
    .map((choice) => ({
      label: choice.label,
      value: choice.value,
      style: choiceStyle(choice),
    }));

  return JSON.stringify({
    type: "buttons",
    buttons: buttons
  });
}

/**
 * Builds a native OpenClaw MessagePresentation for suggested agents.
 * Used by tools in OpenClaw v2026.5+.
 */
export function buildSuggestedAgentsPresentation(
  projectId: string,
  agents: string[],
  responseText: string = "",
  continueButtonLabel?: string | boolean,
  backendButtons?: any[]
): MessagePresentation | null {
  if (responseText.trim().endsWith("?")) return null;

  const matchedAutoRuns: ScheduledAutoRun[] = [];
  const choices = buildSuggestedAgentChoices(projectId, agents, continueButtonLabel, backendButtons);
  const buttons = choices.map((choice, index) => ({
    label: choice.label,
    value: choice.value,
    // Commands are handled by the plugin before agent invocation, so pressing
    // Wait does not spend part of the countdown waiting for an LLM turn.
    action: { type: "command" as const, command: `/ai8080 select-button ${index + 1}` },
    style: choiceStyle(choice),
  }));

  for (const agent of agents) {
    const label = getLabelForAgent(agent, continueButtonLabel, backendButtons);
    const autoRun = getScheduledAutoRun(agent, label, backendButtons);
    if (autoRun) matchedAutoRuns.push(autoRun);
  }

  const note = matchedAutoRuns.map(buildAutoRunNote).find(Boolean);
  const baseMessage = agents.length === 2 && agents[0] === "continue" && agents[1] === "review"
    ? "Choose what to do next:"
    : "Choose an agent to trigger:";

  return {
    title: "8080.ai",
    blocks: [
      { type: "text", text: note ? `${baseMessage}\n\n${note}` : baseMessage },
      { type: "buttons", buttons },
    ],
  };
}

// Parse a button value back to its action and projectId.
// Returns null if the value is not from this plugin.
export function parseButtonValue(
  value: string
): { action: "review" | "continue" | "trigger_agents" | "select" | "wait"; projectId: string; agents?: string[]; entryId?: string; label?: string } | null {
  if (value.startsWith("8080_wait_")) {
    try {
      const payload = JSON.parse(decodeURIComponent(value.slice("8080_wait_".length))) as Record<string, unknown>;
      if (typeof payload.projectId !== "string" || typeof payload.entryId !== "string") return null;
      return {
        action: "wait",
        projectId: payload.projectId,
        entryId: payload.entryId,
        ...(typeof payload.label === "string" ? { label: payload.label } : {}),
      };
    } catch {
      return null;
    }
  }
  if (value.startsWith("8080_review_")) {
    return { action: "review", projectId: value.slice("8080_review_".length) };
  }
  if (value.startsWith("8080_continue_")) {
    return {
      action: "continue",
      projectId: value.slice("8080_continue_".length),
    };
  }
  if (value.startsWith("8080_trigger_agents_")) {
    // Format: 8080_trigger_agents_<projectId>_<agents_json>
    const rest = value.slice("8080_trigger_agents_".length);
    const separatorIndex = rest.indexOf("_");
    if (separatorIndex === -1) return null;
    const projectId = rest.slice(0, separatorIndex);
    const agentsJson = rest.slice(separatorIndex + 1);
    try {
      const agents = JSON.parse(decodeURIComponent(agentsJson));
      return { action: "trigger_agents", projectId, agents };
    } catch {
      return null;
    }
  }
  if (value.startsWith("8080_select_")) {
    return {
      action: "select",
      projectId: value.slice("8080_select_".length),
    };
  }
  return null;
}

export function buildSuggestedAgentsText(
  projectId: string,
  agents: string[],
  responseText: string = "",
  continueButtonLabel?: string | boolean,
  backendButtons?: any[]
): string {
  if (responseText.trim().endsWith("?")) {
    return "";
  }

  const choices = buildSuggestedAgentChoices(projectId, agents, continueButtonLabel, backendButtons);
  const lines = choices.map((choice, index) => `${index + 1}. ${choice.label}`);
  const waitIndex = choices.findIndex((choice) => choice.kind === "wait");
  const directWaitHint = waitIndex >= 0
    ? `OpenClaw Chat fallback: \`/ai8080 select-button ${waitIndex + 1}\` cancels the automatic action directly without waiting for the model.`
    : "";
  const note = agents
    .map((agent) => {
      const label = getLabelForAgent(agent, continueButtonLabel, backendButtons);
      return buildAutoRunNote(getScheduledAutoRun(agent, label, backendButtons));
    })
    .find(Boolean);

  return `### Suggested Next Steps:\n${lines.join("\n")}\n${note ? `\n${note}\n` : ""}${directWaitHint ? `\n${directWaitHint}\n` : ""}`;
}
