// ---------------------------------------------------------------------------
// 8080.ai API Client
//
// Base URL: https://api.8080.ai/api/v1 (paths below are relative to this).
// ---------------------------------------------------------------------------
import { createParser } from "eventsource-parser";

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
  constructor() {
    super(401, "Session expired. Run `/ai8080 login` to re-authenticate.");
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

export type ProjectStatus = {
  id: string;
  phase: ProjectPhase;
  status?: string;
  title?: string;
  activeAgent?: string;
  agentMessage?: string;
  requirementDocUrl?: string;
  error?: string;
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
};

async function apiFetch(
  opts: ClientOpts,
  method: string,
  path: string,
  body?: unknown
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

  if (res.status === 401) throw new AuthError();

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
    console.log("[8080.ai API] /projects/ response sample:", JSON.stringify(data?.[0] ?? "null"));
  }
  // Debug log for project detail calls
  if (path.match(/^\/projects\/[^/]+$/) && path !== "/projects/") {
    console.log("[8080.ai API] Project detail response:", JSON.stringify(data, null, 2));
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
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${opts.token}` },
  });
  if (res.status === 401) return false;
  if (!res.ok) {
    throw new ApiError(res.status, `Validation request failed: HTTP ${res.status}`);
  }
  return true;
}

export function createApiClient(opts: ClientOpts) {
  const get = (path: string) => apiFetch(opts, "GET", path);
  const post = (path: string, body?: unknown) =>
    apiFetch(opts, "POST", path, body);

  return {
    async getSubscription(): Promise<Subscription> {
      return get("/subscription/current") as Promise<Subscription>;
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
      onAgents?: (agents: string[], messageId: string) => void,
      options?: { model?: string }
    ): Promise<{ projectId: string }> {
      // 1. Create the project first to get the ID
      const initRes = (await post("/chat/messages", {
        content: requirements,
        plan_auto: false,
      })) as { project_id: string };

      const projectId = initRes.project_id;

      // 2. Start the stream using the returned project ID
      const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/chat/messages/ai/stream-trigger`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          project_id: projectId
        }),
      });

      if (res.status === 401) throw new AuthError();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg += `: ${await res.text()}`;
        } catch { }
        throw new ApiError(res.status, msg);
      }

      console.log(`[8080.ai] Stream connection established for project: ${projectId}`);

      if (!res.body) {
        throw new Error("No response body in stream");
      }

      const body = res.body;

      return new Promise((resolve, reject) => {
        const parser = createParser({
          onEvent: (event) => {
            if (onRaw) onRaw(event.data);
            try {
              const data = JSON.parse(event.data);
              if (data.type === "token" && data.content) {
                onToken(data.content);
              } else if (data.type === "suggested_agents" && data.agents && onAgents) {
                onAgents(data.agents, data.message_id || "");
              }
            } catch (err) {
              // ignore unparseable chunks
            }
          }
        });

        const reader = body.getReader();
        const decoder = new TextDecoder("utf-8");

        function pump() {
          reader.read().then(({ done, value }) => {
            if (done) {
              resolve({ projectId });
              return;
            }
            if (value) {
              parser.feed(decoder.decode(value, { stream: true }));
            }
            pump();
          }).catch(reject);
        }
        pump();
      });
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
    async resumeDesign(projectId: string, phase: string = "all_pages"): Promise<void> {
      await post(`/chat/resume-design`, {
        project_id: projectId,
        phase,
      });
    },

    async getDesignPages(projectId: string): Promise<unknown> {
      return get(`/projects/${projectId}/design-pages`);
    },

    async getTasks(projectId: string): Promise<unknown> {
      return get(`/projects/${projectId}/tasks`);
    },

    async getArchitecture(projectId: string): Promise<unknown> {
      return get(`/projects/${projectId}/architecture`);
    },

    // 8080.ai uses /projects/{id}/build (no slash) to start/continue building
    async startBuilding(projectId: string, activeModel: string): Promise<void> {
      await post(`/projects/${projectId}/build`, {
        default_model: "super_large",
      });
    },

    // Create or get a public design share link for a project
    async createDesignShare(projectId: string): Promise<{ share_id: string; is_public: boolean; share_url?: string; [key: string]: unknown }> {
      const res = await post(`/projects/${projectId}/design-share`) as Record<string, unknown>;
      return res as { share_id: string; is_public: boolean; share_url?: string; [key: string]: unknown };
    },

    // Send follow-up message to AI and stream the response
    async streamSendMessage(
      projectId: string,
      content: string,
      onToken: (text: string) => void,
      options?: {
        model?: string;
        mediaUrls?: string[];
        onSuggestedAgents?: (agents: string[], messageId: string) => void;
        onRaw?: (raw: string) => void;
      }
    ): Promise<{ suggestedAgents?: string[]; messageId?: string }> {
      const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/chat/messages/ai/stream`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          content,
          project_id: projectId,
          model: (options?.model && !["large", "super_large"].includes(options.model)) ? options.model : "gpt-4o",
          media_urls: options?.mediaUrls ?? [],
          plan_auto: false,
        }),
      });

      if (res.status === 401) throw new AuthError();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          msg += `: ${await res.text()}`;
        } catch { }
        throw new ApiError(res.status, msg);
      }

      if (!res.body) {
        throw new Error("No response body in stream");
      }

      const body = res.body;
      const suggestedAgents: string[] = [];
      let lastMessageId = "";

      return new Promise((resolve, reject) => {
        const parser = createParser({
          onEvent: (event) => {
            if (options?.onRaw) options.onRaw(event.data);
            try {
              const data = JSON.parse(event.data);
              // Debug: log all non-token events to help troubleshoot
              if (data.type !== "token") {
                console.log("[8080.ai stream] event:", JSON.stringify(data));
              }
              if (data.type === "token" && data.content) {
                onToken(data.content);
              }

              // Detect suggested_agents in various possible formats
              const agents = data.agents || data.suggested_agents || data.suggestedAgents || data.pending_suggested_agents;

              if (data.type === "suggested_agents" && agents) {
                console.log("[8080.ai stream] suggested_agents found:", JSON.stringify(agents));
                // Handle both array and object formats
                let agentList: string[] = [];
                if (Array.isArray(agents)) {
                  agentList = agents;
                } else if (typeof agents === "object" && agents !== null) {
                  // If it's an object, try to extract agent names from values
                  agentList = Object.values(agents).filter((v): v is string => typeof v === "string");
                }

                if (agentList.length > 0) {
                  const msgId = data.message_id || data.messageId || "";
                  suggestedAgents.push(...agentList);
                  lastMessageId = msgId;
                  options?.onSuggestedAgents?.(agentList, msgId);
                }
              }
            } catch (err) {
              // ignore unparseable chunks
            }
          },
        });

        const reader = body.getReader();
        const decoder = new TextDecoder("utf-8");

        function pump() {
          reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                resolve({
                  suggestedAgents: suggestedAgents.length > 0 ? suggestedAgents : undefined,
                  messageId: lastMessageId
                });
                return;
              }
              if (value) {
                parser.feed(decoder.decode(value, { stream: true }));
              }
              pump();
            })
            .catch(reject);
        }
        pump();
      });
    },

    // Trigger specific agents for a project (used when user clicks agent suggestion button)
    async triggerAgents(projectId: string, agents: string[], messageId: string, model?: string): Promise<void> {
      await post("/chat/trigger-agents", {
        project_id: projectId,
        agents,
        message_id: messageId,
        model: (model && !["large", "super_large"].includes(model)) ? model : "gpt-4o",
      });
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
      }
    ): Promise<void> {
      const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/projects/${projectId}/events`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: "text/event-stream",
        },
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
              callbacks.onPlanningComplete?.({ status: data.status, triggered_by: data.triggered_by });
            }
          } catch (e) {
            // ignore
          }
        },
      });

      const reader = body.getReader();
      const decoder = new TextDecoder("utf-8");

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
          if (planningComplete) {
            reader.cancel().catch(() => {});
            break;
          }
        }
      } catch (err) {
        console.error("[8080.ai API] Stream error:", err);
      }
    },
  };
}
