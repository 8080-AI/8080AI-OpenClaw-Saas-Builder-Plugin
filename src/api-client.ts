// ---------------------------------------------------------------------------
// 8080.ai API Client
//
// Base URL: https://api.8080.ai/api/v1 (paths below are relative to this).
// ---------------------------------------------------------------------------
import { createParser } from "eventsource-parser";
import { readAuth, writeToken } from "./auth.ts";
import { log } from "../logger.ts";

export function isStartBuildingAgent(agent: string): boolean {
  return agent === "start_building" || agent === "start_build";
}

export function filterStartBuildingAgents(agents: string[], allowStartBuilding: boolean): string[] {
  const filtered = allowStartBuilding ? agents : agents.filter(agent => !isStartBuildingAgent(agent));
  if (agents.some(isStartBuildingAgent) || filtered.length !== agents.length) {
    log.info("start_building filter", { allowStartBuilding, before: agents, after: filtered });
  }
  return filtered;
}

export function isPauseForReviewText(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const normalized = text.toLowerCase();
  const mentionsReview = /\breview\b/.test(normalized);
  const mentionsContinue = /\bcontinue\b/.test(normalized);
  const mentionsReadyForReview = /ready\s+for\s+review/.test(normalized);
  const mentionsClickActions = /click\s+review/.test(normalized) || /click\s+continue/.test(normalized);

  return mentionsReview && mentionsContinue && (mentionsReadyForReview || mentionsClickActions);
}

export function isReviewArchitectureStartBuildingChatMessage(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const event = data as Record<string, unknown>;
  return (
    event.type === "chat_message" &&
    typeof event.content === "string" &&
    /Review the design and architecture and start building/i.test(event.content)
  );
}

function getPauseForReviewStatus(data: Record<string, unknown>): { status: string; triggered_by?: string } | null {
  if (data.status === "paused_for_review") {
    return {
      status: "paused_for_review",
      triggered_by: typeof data.triggered_by === "string" ? data.triggered_by : undefined,
    };
  }

  if (
    isPauseForReviewText(data.content) ||
    isPauseForReviewText(data.message) ||
    isPauseForReviewText(data.summary)
  ) {
    return {
      status: "paused_for_review",
      triggered_by: typeof data.triggered_by === "string" ? data.triggered_by : undefined,
    };
  }

  return null;
}

function debugResponseSummary(label: string, data: unknown): string {
  if (data === null || data === undefined) return `${label}=null`;
  if (Array.isArray(data)) return `${label}=array length=${data.length}`;
  if (typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>);
    const arrayFields = keys
      .filter((key) => Array.isArray((data as Record<string, unknown>)[key]))
      .map((key) => `${key}:${((data as Record<string, unknown>)[key] as unknown[]).length}`)
      .join(",");
    return `${label}=object keys=${keys.length}${arrayFields ? ` arrays=[${arrayFields}]` : ""}`;
  }
  return `${label}=${typeof data}`;
}

function previewLogText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function summarizeAgentLogs(logs: AgentLog[], limit = 5) {
  return [...logs]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit)
    .map((entry) => ({
      action: entry.action,
      agent_type: entry.agent_type,
      summary: entry.summary,
      created_at: entry.created_at,
      message_id: entry.message_id,
    }));
}

function isCompletedAgentLog(entry: AgentLog | undefined): boolean {
  if (!entry) return false;
  if (entry.action === "completed") return true;
  if (typeof entry.summary !== "string") return false;
  return /^completed\b/i.test(entry.summary.trim());
}

function normalizeAiChatModel(model: string | undefined): string | undefined {
  if (model === "large" || model === "super_large") return undefined;
  return model;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AuthError extends ApiError {
  constructor(message = "Your 8080.ai session token expired. Run `/ai8080 login`, then continue the same project again.") {
    super(401, message);
    this.name = "AuthError";
  }
}

export type Subscription = {
  plan_id: string;
  plan_name: string;
  status: string;
  credits_balance: number;
  renews_at: string | null;
  plan_config: {
    name: string;
    monthly_price: number;
    annual_price: number;
    monthly_credits: number;
    cpu_limit: number;
    ram_limit_gb: number;
    max_users: number;
    topup_price_per_credit: number;
    topup_price_per_credit_inr: number;
    features: string[];
  };
};

export type SubscriptionPlan = Record<string, unknown>;

export type UserProfile = {
  id: string;
  email: string;
  subscription_tier?: string;
  credits_balance?: number;
  [key: string]: unknown;
};

export function isFreePlanProfile(profile: UserProfile | null | undefined): boolean {
  return (profile?.subscription_tier ?? "free").toLowerCase() === "free";
}

export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'System Requirements Agent': '📋 Requirements',
  'Design Agent': '🎨 Design',
  'Project Manager': '📊 Tasks',
  'System Architect Agent': '🏗️ Architecture',
  'System Architect': '🏗️ Architecture',
  'User Flow Planner Agent': '🔀 User Flows',
  'User Flow Planner': '🔀 User Flows',
  'plan_all': '🚀 Run Plan All',
  'start_build': '🛠️ Start Building',
  'start_building': '🛠️ Start Building',
  'continue': '▶️ Continue',
  'review': '🔍 Review',
};

export type Project = {
  id: string;
  title: string;
  status: string;
  created_at: string;
};

export type ProjectPhase =
  | "planning"
  | "requirements"
  | "building"
  | "complete"
  | "failed";

export type BuildStep = {
  name: string;
  status: "pending" | "in_progress" | "completed" | "failed" | string;
};

export type ChatMessage = {
  id: string;
  content: string;
  author: "user" | "assistant" | "system";
  created_at: string;
};

export type AgentLog = {
  id: string;
  project_id: string;
  message_id: string | null;
  agent_type: string;
  summary: string | null;
  action: string;
  created_at: string;
};

export type ProjectStatus = {
  id: string;
  phase: ProjectPhase;
  status?: string;
  title?: string;
  activeAgent?: string;
  agentMessage?: string;
  requirementDocUrl?: string;
  error?: string;
  messages?: ChatMessage[];
  // Build step tracking
  current_step?: string;
  steps?: BuildStep[];
  progress?: number;
  // Suggested next agents from API (from ProjectDetailResponse)
  pending_suggested_agents?: Record<string, unknown> | null;
  // Raw fields that might come from API
  [key: string]: unknown;
};

type ClientOpts = {
  token: string;
  apiBaseUrl: string;
  refreshToken?: string;
  onTokenRefresh?: (token: string) => Promise<void>;
};

export async function refreshAccessToken(opts: { apiBaseUrl: string; refreshToken: string }): Promise<string> {
  const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/auth/refresh-token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: opts.refreshToken }),
  });

  if (res.status === 401) throw new AuthError("Your 8080.ai refresh token expired. Run `/ai8080 login`, then save fresh tokens again.");
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      if (text) msg += `: ${text}`;
    } catch { }
    throw new ApiError(res.status, `Token refresh failed: ${msg}`);
  }

  const data = await res.json() as { access_token?: string };
  if (!data.access_token) {
    throw new ApiError(500, "Token refresh failed: missing access_token in response.");
  }
  return data.access_token;
}

async function refreshAndPersist(opts: ClientOpts): Promise<boolean> {
  if (!opts.refreshToken) return false;
  const token = await refreshAccessToken({
    apiBaseUrl: opts.apiBaseUrl,
    refreshToken: opts.refreshToken,
  });
  opts.token = token;
  await opts.onTokenRefresh?.(token);
  log.info("Access token refreshed successfully.");
  return true;
}

async function apiFetch(
  opts: ClientOpts,
  method: string,
  path: string,
  body?: unknown,
  alreadyRetried = false
): Promise<unknown> {
  const url = `${opts.apiBaseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401) {
    const refreshed = alreadyRetried ? false : await refreshAndPersist(opts);
    if (refreshed) return apiFetch(opts, method, path, body, true);
    throw new AuthError();
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      if (text) msg += `: ${text}`;
    } catch { }
    throw new ApiError(res.status, msg);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (path === "/projects/") {
    log.info("/projects/ response sample", data?.[0] ?? "null");
  }
  // Debug log for project detail calls
  if (path.match(/^\/projects\/[^/]+$/) && path !== "/projects/") {
    const project = (data?.project ?? data) as Record<string, unknown> | undefined;
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    log.info("Project detail response", {
      projectId: project?.id,
      status: project?.status,
      updatedAt: project?.updated_at,
      messagesCount: messages.length,
      pendingSuggestedAgents: data?.pending_suggested_agents ?? null,
    });
  }
  return data;
}

/**
 * Validate a token by hitting a lightweight authenticated endpoint.
 * Returns `true` if the token is accepted (HTTP 200), `false` on 401.
 * Throws on network / unexpected errors.
 */
export async function validateToken(opts: ClientOpts): Promise<boolean> {
  const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/subscription/current`;
  log.info("Validating token", { url });
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    log.info("Validation response", { status: res.status });
    if (res.status === 401) return false;
    if (!res.ok) {
      log.info("Validation failed", { status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    log.info("Validation request error", err);
    throw err;
  }
}

/**
 * Ensures the user has saved auth data. Requests refresh automatically on 401
 * when a refresh token is available.
 */
export async function requireAuthenticatedClient(stateDir: string, apiBaseUrl: string) {
  const auth = await readAuth(stateDir);
  if (!auth?.token) {
    throw new AuthError("Your 8080.ai session expired. Run /ai8080 login to re-authenticate.");
  }

  return createApiClient({
    token: auth.token,
    apiBaseUrl,
    refreshToken: auth.refreshToken,
    onTokenRefresh: async (token) => {
      await writeToken(stateDir, token, {
        refreshToken: auth.refreshToken,
        email: auth.email,
      });
    },
  });
}

export function createApiClient(opts: ClientOpts) {
  const get = (path: string) => apiFetch(opts, "GET", path);
  const post = (path: string, body?: unknown) =>
    apiFetch(opts, "POST", path, body);
  const fetchWithAuth = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${opts.token}`);
    const res = await fetch(url, { ...init, headers });
    if (res.status !== 401) return res;

    const refreshed = await refreshAndPersist(opts);
    if (!refreshed) return res;

    const retryHeaders = new Headers(init.headers);
    retryHeaders.set("Authorization", `Bearer ${opts.token}`);
    return fetch(url, { ...init, headers: retryHeaders });
  };

  return {
    async getSubscription(): Promise<Subscription> {
      return get("/subscription/current") as Promise<Subscription>;
    },

    async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
      const data = await get("/subscription/plans");
      return Array.isArray(data) ? data as SubscriptionPlan[] : [];
    },

    async getProfile(): Promise<UserProfile> {
      return get("/profile/") as Promise<UserProfile>;
    },

    // 8080.ai uses /projects/ (with slash) for listing
    async listProjects(): Promise<Project[]> {
      return get("/projects/") as Promise<Project[]>;
    },

    // 8080.ai creates projects by sending a first message to /chat/messages.
    // plan_auto: false means supervisor agents are NOT triggered automatically.
    // Users must manually trigger agents via /ai8080 select-button.
    async createProject(requirements: string): Promise<{ projectId: string }> {
      const res = (await post("/chat/messages", {
        content: requirements,
        plan_auto: false,
      })) as { project_id: string };

      return { projectId: res.project_id };
    },

    async streamProjectCreation(
      requirements: string,
      onToken: (text: string) => void,
      onRaw?: (raw: string) => void,
      onAgents?: (agents: string[], projectId: string, messageId: string) => void,
      options?: { model?: string; mediaUrls?: string[] }
    ): Promise<{ projectId: string }> {
      // 1. Create the project and initial message first
      const createRes = await post("/chat/messages", {
        content: requirements,
        plan_auto: false,
        media_urls: options?.mediaUrls,
      }) as { project_id: string };

      const projectId = createRes.project_id;
      log.info("Project created. Triggering AI stream...", { projectId });

      const triggerStream = async (model?: string): Promise<void> => {
        // 2. Trigger the AI response stream using the dedicated trigger endpoint
        const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/chat/messages/ai/stream-trigger`;
        const body = model ? { project_id: projectId, model } : { project_id: projectId };
        log.info("streamProjectCreation trigger request", { projectId, body });
        const res = await fetchWithAuth(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
        });

        if (res.status === 401) throw new AuthError();
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            msg += `: ${await res.text()}`;
          } catch { }
          throw new ApiError(res.status, msg);
        }

        if (!res.body) throw new Error("No response body in stream");

        await new Promise<void>((resolve, reject) => {
          let isDone = false;
          let accumulatedText = "";

          const parser = createParser({
            onEvent: (event) => {
              if (onRaw) onRaw(event.data);
              try {
                const data = JSON.parse(event.data);

                if (data.type === "token" && data.content) {
                  accumulatedText += data.content;
                  onToken(data.content);
                } else if (data.type === "error") {
                  const errorMsg = data.message || data.content || JSON.stringify(data);
                  log.info("streamProjectCreation SSE error", { projectId, model, error: errorMsg });
                  if (!isDone) {
                    isDone = true;
                    reject(new Error(String(errorMsg)));
                  }
                } else if ((data.type === "suggested_agents" || data.agents || data.suggestedAgents) && onAgents) {
                  const agentsData = data.agents || data.suggested_agents || data.suggestedAgents || [];
                  const agents = Array.isArray(agentsData) ? agentsData : Object.keys(agentsData);
                  if (agents.length > 0) {
                    onAgents(agents, projectId, data.message_id || data.messageId || "");
                  }
                }
              } catch (err) {
                log.info("Failed to parse streamProjectCreation SSE event data", event.data, err);
              }
            }
          });

          const reader = res.body!.getReader();
          const decoder = new TextDecoder("utf-8");

          function pump() {
            reader.read().then(({ done, value }) => {
              if (done) {
                if (!isDone) {
                  isDone = true;
                  resolve();
                }
                return;
              }
              if (value) {
                parser.feed(decoder.decode(value, { stream: true }));
              }
              if (!isDone) pump();
            }).catch(reject);
          }
          pump();
        });
      };

      const modelToSend = normalizeAiChatModel(options?.model);
      try {
        await triggerStream(modelToSend);
      } catch (err) {
        if (modelToSend) {
          log.info("streamProjectCreation retrying trigger with default model", {
            projectId,
            failedModel: modelToSend,
            error: err instanceof Error ? err.message : String(err),
          });
          await triggerStream(undefined);
        } else {
          throw err;
        }
      }

      return { projectId };
    },

    // 8080.ai uses /projects/{id} (no slash) for detail
    // API returns ProjectDetailResponse: { project: {...}, messages: [...], pending_suggested_agents: {...} }
    async getProjectStatus(projectId: string): Promise<ProjectStatus> {
      const raw = await get(`/projects/${projectId}`) as Record<string, unknown>;

      // The API wraps project data inside a `project` field (ProjectDetailResponse).
      // Fall back to raw itself if the wrapper isn't present.
      const projectData = (raw.project ?? raw) as Record<string, unknown>;

      const status: ProjectStatus = {
        ...raw,                               // preserve every top-level field (messages, pending_suggested_agents, etc.)
        ...projectData,                       // overlay the project-level fields
        id: (projectData.id as string) ?? projectId,
        phase: (projectData.phase ?? projectData.status ?? "unknown") as ProjectPhase,
        status: projectData.status as string | undefined,
        title: (projectData.title ?? projectData.name ?? projectData.project_name) as string | undefined,
        activeAgent: (projectData.activeAgent ?? projectData.active_agent) as string | undefined,
        agentMessage: (projectData.agentMessage ?? projectData.agent_message) as string | undefined,
        requirementDocUrl: (projectData.requirementDocUrl ?? projectData.requirement_doc_url) as string | undefined,
        error: projectData.error as string | undefined,
        current_step: (projectData.current_step ?? projectData.currentStep ?? projectData.step) as string | undefined,
        steps: projectData.steps as BuildStep[] | undefined,
        progress: projectData.progress as number | undefined,
        // Extract pending_suggested_agents from the top-level response
        pending_suggested_agents: raw.pending_suggested_agents as Record<string, unknown> | null ?? null,
      };
      return status;
    },

    // Resume the design pipeline after user review gate
    // POST /chat/resume-design with { project_id, phase }
    async resumeDesign(projectId: string): Promise<void> {
      const path = `/chat/resume-design`;
      const body = {
        project_id: projectId,
        // phase,
      };
      log.info("resume_design api request", { projectId, path, body });
      const response = await post(path, body);
      log.info("resume_design api response", { projectId, path, response });
    },

    async getDesignPages(projectId: string): Promise<unknown> {
      return get(`/projects/${projectId}/design-pages`);
    },

    async getTasks(projectId: string): Promise<unknown> {
      const data = await get(`/projects/${projectId}/tasks`);
      log.info("start_building readiness tasks", { projectId, summary: debugResponseSummary("tasks", data) });
      log.info("start_building tasks response", {
        projectId,
        count: Array.isArray(data) ? data.length : 0,
        latestFive: Array.isArray(data)
          ? data.slice(0, 5).map((task: Record<string, unknown>) => ({
            title: task.title,
            status: task.status,
            priority: task.priority,
            task_number: task.task_number,
          }))
          : [],
      });
      return data;
    },

    async getArchitecture(projectId: string): Promise<unknown> {
      const data = await get(`/projects/${projectId}/architecture`);
      log.info("start_building readiness architecture", { projectId, summary: debugResponseSummary("architecture", data) });
      return data;
    },

    async getAgentLogs(projectId: string): Promise<AgentLog[]> {
      const path = `/projects/${projectId}/agent-logs`;
      log.info("agent_logs api request", { projectId, path });
      const logs = await get(path) as AgentLog[];
      log.info("agent_logs api response", {
        projectId,
        path,
        count: Array.isArray(logs) ? logs.length : 0,
        latestFive: Array.isArray(logs) ? summarizeAgentLogs(logs) : [],
      });
      return logs;
    },

    async hasLatestCompletedAgentLog(projectId: string): Promise<boolean> {
      const logs = await this.getAgentLogs(projectId).catch(() => []);
      const latest = [...logs].sort((a, b) => {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })[0];

      const isCompleted = isCompletedAgentLog(latest);

      log.info("agent_logs latest action check", {
        projectId,
        logsCount: logs.length,
        latestAction: latest?.action,
        latestAgentType: latest?.agent_type,
        latestSummary: latest?.summary,
        latestCreatedAt: latest?.created_at,
        isCompleted,
        latestFive: summarizeAgentLogs(logs),
      });

      return isCompleted;
    },

    // 8080.ai uses /projects/{id}/build (no slash) to start/continue building
    async startBuilding(projectId: string, activeModel: string): Promise<void> {
      const path = `/projects/${projectId}/build`;
      const body = {
        default_model: "super_large",
      };
      log.info("start_building build api request", { projectId, path, activeModel, body });
      const response = await post(path, body);
      log.info("start_building build api response", { projectId, path, response });
    },

    // Create or get a public design share link for a project
    async createDesignShare(projectId: string): Promise<{ share_id: string; is_public: boolean; share_url?: string;[key: string]: unknown }> {
      const res = await post(`/projects/${projectId}/design-share`) as Record<string, unknown>;
      log.info("design-share response ", res);
      return res as { share_id: string; is_public: boolean; share_url?: string;[key: string]: unknown };
    },

    // Send follow-up message to AI and stream the response
    async streamSendMessage(
      projectId:  string,
      content: string,
      onToken: (text: string) => void,
      options?: {
        model?: string;
        mediaUrls?: string[];
        onSuggestedAgents?: (agents: string[], projectId: string, messageId: string) => void;
        onRaw?: (raw: string) => void;
      }
    ): Promise<{ suggestedAgents?: string[]; messageId?: string }> {
      const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/chat/messages/ai/stream`;
      log.info("POST streamSendMessage", { url });
      // let modelToSend = options?.model;
      // if (modelToSend === "large" || modelToSend === "super_large") {
      //   modelToSend = undefined;
      // }

      const body = {
        project_id: projectId,
        content: content,
        model: "gpt-4o",
        media_urls: options?.mediaUrls ?? [],
        plan_auto: false,
      };
      log.info("streamSendMessage request body", body);

      const res = await fetchWithAuth(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      });

      log.info("streamSendMessage response", { status: res.status, statusText: res.statusText });

      if (res.status === 401) throw new AuthError();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const errBody = await res.text();
          log.info("streamSendMessage error body", errBody);
          msg += `: ${errBody}`;
        } catch { }
        throw new ApiError(res.status, msg);
      }

      if (!res.body) throw new Error("No response body in stream");

      const suggestedAgents: string[] = [];
      let lastMessageId = "";
      let accumulatedText = "";

      return new Promise((resolve, reject) => {
        let isDone = false;

        const parser = createParser({
          onEvent: (event) => {
            if (options?.onRaw) options?.onRaw(event.data);
            if (event.data === "[DONE]") {
              log.info("SSE stream received [DONE]");
              if (!isDone) {
                isDone = true;
                resolve({ suggestedAgents: suggestedAgents.length > 0 ? suggestedAgents : undefined, messageId: lastMessageId });
              }
              return;
            }

            try {
              const data = JSON.parse(event.data);
              const token = data.content || data.text || (typeof data === 'string' ? data : null);
              if (token && (data.type === "token" || !data.type)) {
                accumulatedText += token;
                onToken(token);
              } else if (data.type === "error") {
                const errorMsg = data.message || data.content || JSON.stringify(data);
                log.info("SSE error event", errorMsg);
                if (!isDone) {
                  isDone = true;
                  reject(new Error(errorMsg));
                }
                return;
              } else if (data.type === "already_has_assistant") {
                log.info("already_has_assistant - AI is already processing.");
              }

              const agents = data.agents || data.suggested_agents || data.suggestedAgents || data.pending_suggested_agents;
              if ((data.type === "suggested_agents" || data.type === "agents") && agents) {
                let agentList: string[] = [];
                if (Array.isArray(agents)) agentList = agents;
                else if (typeof agents === "object" && agents !== null) {
                  for (const [key, value] of Object.entries(agents)) {
                    if (typeof value === "string") agentList.push(value);
                    else if (value === true) agentList.push(key);
                  }
                }

                if (agentList.length > 0) {
                  const msgId = data.message_id || data.messageId || "";
                  suggestedAgents.push(...agentList);
                  lastMessageId = msgId;
                  options?.onSuggestedAgents?.(agentList, projectId, msgId);
                }
              }

              if (data.type === "message_done" || data.type === "stop" || data.type === "done") {
                if (data.ai_message_id) lastMessageId = data.ai_message_id;
                log.info("SSE stream reached", data.type);
              }
            } catch (err) {
              log.info("Failed to parse SSE event data", event.data, err);
            }
          }
        });

        const reader = res.body!.getReader();
        const decoder = new TextDecoder("utf-8");

        async function pump() {
          try {
            const { done, value } = await reader.read();
            if (done) {
              log.info("SSE stream reader done");
              if (!isDone) {
                isDone = true;
                resolve({ suggestedAgents: suggestedAgents.length > 0 ? suggestedAgents : undefined, messageId: lastMessageId });
              }
              return;
            }
            if (value) {
              const chunk = decoder.decode(value, { stream: true });
              parser.feed(chunk);
            }
            if (!isDone) pump();
          } catch (err) {
            log.info("SSE pump error", err);
            reject(err);
          }
        }
        pump();
      });
    },

    // Trigger specific agents for a project (used when user clicks agent suggestion button)
    async triggerAgents(projectId: string, agents: string[], messageId: string, model?: string): Promise<void> {
      const body = {
        project_id: projectId,
        agents,
        message_id: messageId,
        // model: model ?? "super_large",
      };
      log.info("trigger_agents api request", { path: "/chat/trigger-agents", body });
      const response = await post("/chat/trigger-agents", body);
      log.info("trigger_agents api response", { projectId, agents, response });
    },

    // Stream events for a specific project
    async streamProjectEvents(
      projectId: string,
      callbacks: {
        onAgentLog?: (log: any) => void;
        onChatMessage?: (msg: any) => void;
        onSrdChunk?: (chunk: any) => void;
        onAiOverview?: (msg: any) => void;
        onPlanningComplete?: (data: { status: string; triggered_by?: string }) => void;
        onRaw?: (raw: string) => void;
        idleTimeoutMs?: number;
        maxTimeoutMs?: number;
        progressTimeoutMs?: number;
      }
    ): Promise<void> {
      const controller = new AbortController();
      const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/projects/${projectId}/events`;
      log.info("project_events api request", {
        projectId,
        url,
        method: "GET",
        accept: "text/event-stream",
        idleTimeoutMs: callbacks.idleTimeoutMs,
        progressTimeoutMs: callbacks.progressTimeoutMs,
        maxTimeoutMs: callbacks.maxTimeoutMs,
      });
      const res = await fetchWithAuth(url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      log.info("project_events api response", {
        projectId,
        url,
        status: res.status,
        statusText: res.statusText,
      });

      if (res.status === 401) throw new AuthError();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg += `: ${await res.text()}`;
        } catch { }
        throw new ApiError(res.status, msg);
      }

      if (!res.body) throw new Error("No response body");

      const body = res.body;
      let planningComplete = false;
      const parser = createParser({
        onEvent: (event) => {
          if (callbacks.onRaw) callbacks.onRaw(event.data);
          try {
            const data = JSON.parse(event.data);
            const pauseStatus = getPauseForReviewStatus(data);
            const isProgressEvent =
              data.type === "agent_log" ||
              data.type === "chat_message" ||
              data.type === "srd_stream_chunk" ||
              data.type === "ai_overview_text" ||
              data.type === "planning_complete" ||
              Boolean(pauseStatus);
            if (isProgressEvent) {
              lastProgressAt = Date.now();
            }
            if (data.type === "agent_log" && callbacks.onAgentLog) {
              callbacks.onAgentLog(data);
            } else if (data.type === "chat_message" && callbacks.onChatMessage) {
              callbacks.onChatMessage(data);
            } else if (data.type === "srd_stream_chunk" && callbacks.onSrdChunk) {
              callbacks.onSrdChunk(data);
            } else if (data.type === "ai_overview_text" && callbacks.onAiOverview) {
              callbacks.onAiOverview(data);
            } else if (data.type === "planning_complete") {
              planningComplete = true;
              callbacks.onPlanningComplete?.(pauseStatus ?? {
                status: String(data.status ?? "complete"),
                triggered_by: typeof data.triggered_by === "string" ? data.triggered_by : undefined,
              });
            }

            if (pauseStatus && data.type !== "planning_complete") {
              planningComplete = true;
              callbacks.onPlanningComplete?.(pauseStatus);
            }
          } catch (e) {
            // ignore
          }
        }
      });

      const reader = body.getReader();
      const decoder = new TextDecoder("utf-8");
      const idleTimeoutMs = callbacks.idleTimeoutMs ?? 120_000;
      const progressTimeoutMs = callbacks.progressTimeoutMs ?? 90_000;
      let lastProgressAt = Date.now();
      let maxTimedOut = false;
      let progressTimedOut = false;
      const maxTimeout = callbacks.maxTimeoutMs
        ? setTimeout(() => {
          maxTimedOut = true;
          log.info("streamProjectEvents max timeout reached", {
            projectId,
            maxTimeoutMs: callbacks.maxTimeoutMs,
          });
          reader.cancel().catch(() => { });
          controller.abort();
        }, callbacks.maxTimeoutMs)
        : undefined;

      const readWithIdleTimeout = () => {
        let timeout: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          timeout = setTimeout(() => {
            reader.cancel().catch(() => { });
            controller.abort();
            resolve({ done: true, value: undefined });
          }, idleTimeoutMs);
        });

        return Promise.race([reader.read(), timeoutPromise]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
      };

      try {
        while (true) {
          const { done, value } = await readWithIdleTimeout();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
          if (planningComplete) {
            reader.cancel().catch(() => { });
            break;
          }
          if (Date.now() - lastProgressAt > progressTimeoutMs) {
            progressTimedOut = true;
            log.info("streamProjectEvents progress timeout reached", {
              projectId,
              progressTimeoutMs,
            });
            reader.cancel().catch(() => { });
            controller.abort();
            break;
          }
        }
      } catch (err) {
        if (maxTimedOut) {
          log.info("Stream stopped after max timeout", { projectId });
        } else if (progressTimedOut) {
          log.info("Stream stopped after progress timeout", { projectId });
        } else {
          log.info("Stream error", err);
        }
      } finally {
        if (maxTimeout) clearTimeout(maxTimeout);
        log.info("project_events stream finished", {
          projectId,
          maxTimedOut,
          progressTimedOut,
          planningComplete,
        });
      }
    },

    // Upload files to 8080.ai and return their remote URLs
    async uploadMedia(filePaths: string[], projectId: string = "default"): Promise<string[]> {
      const { readFileSync } = await import("node:fs");
      const { basename } = await import("node:path");
      const { Blob } = await import("node:buffer");

      const formData = new FormData();
      for (const filePath of filePaths) {
        try {
          const buffer = readFileSync(filePath);
          const name = basename(filePath);
          // Simple mime type detection based on extension
          const ext = name.split('.').pop()?.toLowerCase();
          const type = ext === 'png' ? 'image/png' :
            ext === 'gif' ? 'image/gif' :
              ext === 'webp' ? 'image/webp' :
                ext === 'pdf' ? 'application/pdf' :
                  ext === 'txt' ? 'text/plain' :
                    'image/jpeg';

          const blob = new Blob([buffer], { type });
          formData.append("files", blob, name);
        } catch (err) {
          log.info("Failed to read file", filePath, err);
        }
      }
      formData.append("project_id", projectId);

      const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/chat/media/upload`;
      const res = await fetchWithAuth(url, {
        method: "POST",
        headers: {},
        body: formData,
      });

      if (res.status === 401) throw new AuthError();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg += `: ${await res.text()}`;
        } catch { }
        throw new ApiError(res.status, `Upload failed: ${msg}`);
      }

      const data = await res.json() as { urls: string[] };
      return data.urls;
    },
  };
}
