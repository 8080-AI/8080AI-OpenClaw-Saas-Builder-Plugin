import { type ChatMessage, checkGenerateFirstPageCondition, determineContinueButtonLabel } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { writeLatestSuggestions } from "./suggestions-state.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { log } from "../logger.ts";

const FIRST_PAGE_RE = /page design and user flow are ready for review|review the user flow and the .+ page design/i;
const ALL_PAGES_RE = /All \d+ page designs are ready|Please review them.*click \*\*Continue\*\*/i;
const USER_FLOW_RE = /user flows are ready for review|Click \*\*Continue\*\* to generate design pages/i;
const REVIEW_BUILD_RE = /Review the design and architecture and start building/i;
const INSUFFICIENT_CREDITS_RE = /Insufficient credits|cannot afford/i;

type ActivationClient = {
  getProjectStatus(projectId: string): Promise<{ pending_suggested_agents?: unknown; messages?: ChatMessage[] } | null>;
  getChatMessages(projectId: string): Promise<ChatMessage[]>;
  getProjectChatMessages(projectId: string, chatSessionId: string): Promise<ChatMessage[]>;
  getTasks(projectId: string): Promise<unknown>;
  getArchitecture(projectId: string): Promise<unknown>;
  getAgentLogs(projectId: string): Promise<any[]>;
};

type ActivationResult = {
  latestMessageText: string;
  agents: string[];
  messageId: string;
  presentation: unknown;
};

function latestByCreatedAt(messages: ChatMessage[]): ChatMessage | null {
  if (messages.length === 0) return null;
  return [...messages].sort((a, b) => {
    const bTime = new Date(b.created_at ?? "").getTime();
    const aTime = new Date(a.created_at ?? "").getTime();
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  })[0] ?? null;
}

function latestActivationMessage(messages: ChatMessage[]): ChatMessage | null {
  const latestActionable = latestByCreatedAt(messages.filter((message) => {
    const content = message.content ?? "";
    return (
      INSUFFICIENT_CREDITS_RE.test(content) ||
      USER_FLOW_RE.test(content) ||
      FIRST_PAGE_RE.test(content) ||
      ALL_PAGES_RE.test(content) ||
      REVIEW_BUILD_RE.test(content)
    );
  }));
  if (latestActionable) return latestActionable;

  return latestByCreatedAt(messages.filter((message) => message.author === "user" || message.author === "assistant")) ??
    latestByCreatedAt(messages);
}

function messageLabel(author: ChatMessage["author"]): string {
  if (author === "user") return "User";
  if (author === "assistant") return "Assistant";
  return "System";
}

function hasGeneratedData(data: unknown): boolean {
  if (!data) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === "object") {
    return Object.values(data).some((value) => Array.isArray(value) && value.length > 0);
  }
  return false;
}

function groupPlanningAgents(agents: string[]): string[] {
  const planningAgents = [
    "System Requirements Agent",
    "Design Agent",
    "Project Manager",
    "System Architect",
    "User Flow Planner",
    "plan_all",
  ];
  const groupedAgents = agents.filter((agent) => planningAgents.includes(agent));
  const otherAgents = agents.filter((agent) => !planningAgents.includes(agent));
  return groupedAgents.length > 1
    ? [`GROUP:${groupedAgents.join("|")}`, ...otherAgents]
    : agents;
}

function checkpointAgentsFromMessage(content: string): string[] {
  const agents: string[] = [];
  if (/run\s+plan\s+all/i.test(content) || /(?:click|type)\s+(?:\*\*)?["']?start\b/i.test(content)) {
    agents.push("plan_all");
  }
  if (/\bcontinue\b/i.test(content)) agents.push("continue");
  if (/\breview\b/i.test(content) && !/click\s+\*\*continue\*\*/i.test(content)) agents.push("review");
  return agents.length > 0 ? agents : ["continue"];
}

function statusMessages(status: { messages?: ChatMessage[] } | null, projectId: string): ChatMessage[] {
  if (!Array.isArray(status?.messages)) return [];
  return status.messages.filter((message) => !message.project_id || message.project_id === projectId);
}

async function fetchActivationMessages(
  client: ActivationClient,
  projectId: string,
  status: { messages?: ChatMessage[] } | null,
  chatSessionId: string
): Promise<ChatMessage[]> {
  const scopedMessages = await client.getProjectChatMessages(projectId, chatSessionId).catch((err) => {
    log.info("project_activation scoped chat message fetch failed", {
      projectId,
      chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  });
  if (scopedMessages.length > 0) return scopedMessages;

  const projectDetailMessages = statusMessages(status, projectId);
  if (projectDetailMessages.length > 0) {
    log.info("project_activation using project detail messages", {
      projectId,
      messagesCount: projectDetailMessages.length,
    });
    return projectDetailMessages;
  }

  const allMessages = await client.getChatMessages(projectId).catch((err) => {
    log.info("project_activation project-wide chat message fetch failed", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  });
  const projectMessages = allMessages.filter((message) => !message.project_id || message.project_id === projectId);
  log.info("project_activation using project-wide chat messages", {
    projectId,
    messagesCount: projectMessages.length,
  });
  return projectMessages;
}

async function activationAgents(
  client: ActivationClient,
  projectId: string,
  message: ChatMessage | null,
  suggestedAgents: string[]
): Promise<string[]> {
  if (!message) return [];

  const content = message.content ?? "";
  if (
    INSUFFICIENT_CREDITS_RE.test(content) ||
    USER_FLOW_RE.test(content) ||
    FIRST_PAGE_RE.test(content) ||
    ALL_PAGES_RE.test(content)
  ) {
    return checkpointAgentsFromMessage(content);
  }

  if (REVIEW_BUILD_RE.test(content)) {
    const [tasks, architecture] = await Promise.all([
      client.getTasks(projectId).catch(() => null),
      client.getArchitecture(projectId).catch(() => null),
    ]);
    return hasGeneratedData(tasks) && hasGeneratedData(architecture)
      ? ["review", "start_building"]
      : ["review"];
  }

  if (message.author === "assistant" && !content.trim().endsWith("?") && suggestedAgents.length > 0) {
    return groupPlanningAgents(suggestedAgents);
  }

  return [];
}

export async function buildProjectActivationResult(params: {
  client: ActivationClient;
  projectId: string;
  projectTitle: string;
  stateDir: string;
  openClawSessionId: string;
}): Promise<ActivationResult> {
  const { client, projectId, projectTitle, stateDir, openClawSessionId } = params;
  const status = await client.getProjectStatus(projectId).catch(() => null);
  const pending = extractPendingSuggestion(status?.pending_suggested_agents);
  const chatSessionId = pending.sessionId || openClawSessionId;
  const messages = await fetchActivationMessages(client, projectId, status, chatSessionId);
  const message = latestActivationMessage(messages);
  const agents = await activationAgents(client, projectId, message, pending.agents);
  const messageId = message?.id || pending.messageId || "";

  await writeLatestSuggestions(stateDir, openClawSessionId, {
    projectId,
    agents,
    messageId,
    buttons: pending.buttons,
  });

  const continueButtonLabel = agents.includes("continue") ? await determineContinueButtonLabel(client, projectId) : undefined;
  const latestMessageText = message
    ? `\n\n### Latest Message\n\n**${messageLabel(message.author)}:** ${message.content}`
    : "";
  const suggestionText = agents.length > 0
    ? `\n\n${buildSuggestedAgentsText(projectId, agents, "", continueButtonLabel, pending.buttons)}` +
      `\nType \`/ai8080 select-button <number>\` to proceed.`
    : "";
  const text =
    `✅ Project \`${projectTitle}\` is now active for this OpenClaw session. (${projectId})` +
    latestMessageText +
    suggestionText;

  log.info("project_activation result", {
    projectId,
    chatSessionId,
    latestMessageId: message?.id,
    latestAuthor: message?.author,
    agents,
  });

  return {
    latestMessageText: text,
    agents,
    messageId,
    presentation: agents.length > 0
      ? buildSuggestedAgentsPresentation(projectId, agents, "", continueButtonLabel, pending.buttons)
      : undefined,
  };
}
