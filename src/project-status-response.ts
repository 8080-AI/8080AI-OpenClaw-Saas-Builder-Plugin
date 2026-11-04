import type { ChatMessage, createApiClient } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { extractEventSuggestion, extractPendingSuggestion, type PendingSuggestion } from "./suggested-agents.ts";
import { canOfferBuildTasksAction, getBuildTasksReadiness } from "./build-readiness.ts";
import { getArtifactShareText, type ArtifactShareClient } from "./artifact-shares.ts";
import { writeLatestSuggestions } from "./suggestions-state.ts";

type Client = Pick<ReturnType<typeof createApiClient>, "getProjectStatus" | "getProjectChatMessages" | "getPlanningStatus" | "getBuildPhaseExecutionState"> & Partial<ArtifactShareClient>;
const timestamp = (value: string) => Date.parse(/(?:z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`) || 0;

/** Assistant messages are the Tech Lead replies in the messages API. Explicit
 * agent metadata, when supplied, must also identify the Tech Lead. */
export function latestTechLeadMessage(messages: ChatMessage[], projectId: string): ChatMessage | undefined {
  return messages.filter(message => {
    if (message.project_id && message.project_id !== projectId) return false;
    if (!message.content?.trim() || message.author === "user") return false;
    const agent = message.agent_type ?? message.agent_name;
    if (agent) return /^tech[ _-]*lead(?:[ _-]*agent)?$/i.test(agent.trim());
    if (message.author === "assistant") return true;
    // The platform also stores orchestrator progress/review gates as system messages.
    return message.author === "system" && (Boolean(message.buttons?.length) ||
      /^(?:(?:Planning your project|Continue planning|Warming Up)(?:\.{3}|…)|Warmup completed\.|Currently changing the selected design component)/i.test(message.content.trim()) ||
      /^(?:System Requirements Agent|User Flow Planner|System Architect|Project Manager|Design Agent) is done(?:\s+with\s+.+?)?(?:\s+in\s+\d+:\d{2})?\.$/i.test(message.content.trim()));
  }).sort((left, right) => timestamp(right.created_at) - timestamp(left.created_at))[0];
}

function suggestionFromMessage(message: ChatMessage | undefined): PendingSuggestion {
  if (!message) return { agents: [], messageId: "", sessionId: "" };
  const clicked = new Set([...(message.clicked_buttons ?? []), message.clicked_button].filter(Boolean));
  const buttons = message.buttons?.filter(button => button.enabled !== false && !clicked.has(button.key) &&
    (!message.allowed_buttons || message.allowed_buttons.includes(button.key)));
  // Only current structured metadata can offer an action. Do not parse reply prose.
  return extractEventSuggestion({ message_id: message.id, session_id: message.session_id, buttons });
}

export async function buildProjectStatusResponse(client: Client, options: {
  projectId: string; stateDir: string; sessionId: string; modelTier: string; siteUrl?: string;
}) {
  const { projectId } = options;
  const [status, messages, readiness] = await Promise.all([
    client.getProjectStatus(projectId),
    client.getProjectChatMessages(projectId).catch(() => null),
    getBuildTasksReadiness(client, projectId, options.modelTier).catch(() => null),
  ]);
  const latest = latestTechLeadMessage(messages ?? [], projectId);
  const lines = ["### 📊 Project Status"];
  if (status.title) lines.push(`**Project:** ${status.title}`);
  lines.push(`**ID:** ${projectId}`, `**Phase:** ${status.phase ?? status.status ?? "unknown"}`);
  if (status.activeAgent) lines.push(`**Agent:** ${status.activeAgent}`);
  if (status.progress !== undefined) lines.push(`**Progress:** ${status.progress}%`);
  if (latest) lines.push("", "### Latest Tech Lead message", latest.content);
  else lines.push("", messages === null ? "The latest Tech Lead message could not be loaded." : "No Tech Lead message is available yet.");
  if (status.steps?.length) {
    lines.push("", "**Build Steps:**");
    for (const step of status.steps) {
      const icon = step.status === "completed" ? "✅" : step.status === "in_progress" ? "🔄" : step.status === "failed" ? "❌" : "⏳";
      lines.push(`${icon} ${step.name}`);
    }
  } else if (status.current_step) lines.push("", `**Current Step:** ${status.current_step}`);
  if (status.error) lines.push("", `❌ **Error:** ${status.error}`);

  let pending = extractPendingSuggestion(status.pending_suggested_agents);
  if (pending.buttons?.some(button => button.kind !== "auto_run")) {
    const buttons = pending.buttons.filter(button => button.enabled !== false);
    const enabled = extractEventSuggestion({ buttons }).agents;
    // Explicit agent arrays must not resurrect disabled structured actions.
    pending = { ...pending, agents: pending.agents.filter(agent => enabled.includes(agent) ||
      (agent === "review" && buttons.some(button => button.action === "review"))), buttons };
  }
  const messageSuggestion = suggestionFromMessage(latest);
  if (latest && pending.messageId === latest.id && Array.isArray(latest.buttons)) {
    // The message gate carries click/allow-list state missing from legacy pending arrays.
    pending = { ...pending, agents: messageSuggestion.agents, buttons: messageSuggestion.buttons };
  }
  // Project-level pending suggestions are authoritative. Recover a review gate
  // from only the newest Tech Lead reply when pending suggestions are cleared.
  let suggestion = pending.agents.length ? pending : messageSuggestion;
  const state = readiness?.state;
  const taskCount = state?.blocking_reason === "insufficient_credits" && Array.isArray(state.phase_tasks)
    ? state.phase_tasks.length : state?.runnable_tasks?.length ?? 0;
  const buildReady = readiness && canOfferBuildTasksAction(readiness, taskCount);
  const planning = readiness?.planningStatus;
  const paused = /paused|awaiting_review/.test(String(planning?.pipeline_run_status ?? planning?.run_status ?? status.status ?? ""));
  if (buildReady) {
    suggestion = { agents: ["start_building", "review"], messageId: latest?.id ?? pending.messageId, sessionId: pending.sessionId };
  } else {
    // Readiness must authorize Build Tasks; completed artifacts alone cannot.
    let agents = suggestion.agents.filter(agent => agent !== "start_building" && agent !== "start_build");
    if ((planning?.is_active && !paused) || state?.blocking_reason === "build_in_progress" || state?.all_completed) agents = [];
    suggestion = { ...suggestion, agents };
  }
  // Clear old selectable actions too, so a subsequent "select 1" cannot use an
  // obsolete action left behind by a previous status response.
  await writeLatestSuggestions(options.stateDir, options.sessionId, {
    projectId, agents: suggestion.agents, messageId: suggestion.messageId, buttons: suggestion.buttons,
  });
  const links = await getArtifactShareText(client, projectId, options.siteUrl);
  if (links) lines.push("", links);
  if (suggestion.agents.length) lines.push("", buildSuggestedAgentsText(projectId, suggestion.agents, "", undefined, suggestion.buttons));
  return {
    text: lines.join("\n"),
    presentation: suggestion.agents.length ? buildSuggestedAgentsPresentation(projectId, suggestion.agents, "", undefined, suggestion.buttons) : undefined,
    projectId, messageId: latest?.id, suggestions: suggestion.agents,
  };
}
