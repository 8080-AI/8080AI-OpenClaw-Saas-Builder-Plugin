// ---------------------------------------------------------------------------
// 8080.ai API Client
//
// Base URL: https://api.8080.ai/api/v1 (paths below are relative to this).
// ---------------------------------------------------------------------------
import { createParser } from "eventsource-parser";
import { requireToken, AuthRequiredError } from "./auth.ts";

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

export type ChatMessage = {
  id: string;
  content: string;
  author: "user" | "assistant" | "system";
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
    process.stderr.write(`[8080.ai API] /projects/ response sample: ${JSON.stringify(data?.[0] ?? "null")}\n`);
  }
  // Debug log for project detail calls
  if (path.match(/^\/projects\/[^/]+$/) && path !== "/projects/") {
    process.stderr.write(`[8080.ai API] Project detail response: ${JSON.stringify(data, null, 2)}\n`);
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
  process.stderr.write(`[8080.ai API] Validating token at: ${url}` + "\n");
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    process.stderr.write(`[8080.ai API] Validation response status: ${res.status}` + "\n");
    if (res.status === 401) return false;
    if (!res.ok) {
      process.stderr.write(`[8080.ai API] Validation failed with HTTP ${res.status}` + "\n");
      return false;
    }
    return true;
  } catch (err) {
    process.stderr.write(`[8080.ai API] Validation request error: ${err instanceof Error ? err.message : String(err)}` + "\n");
    throw err;
  }
}

/**
 * Ensures the user is logged in AND the token is valid.
 * Throws AuthRequiredError if no token, or AuthError if token is invalid.
 */
export async function requireAuthenticatedClient(stateDir: string, apiBaseUrl: string) {
  try {
    const token = await requireToken(stateDir);
    return createApiClient({ token, apiBaseUrl });
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      throw new AuthError("Your 8080.ai session expired. Run /ai8080 login to re-authenticate.");
    }
    throw err;
  }
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
      process.stderr.write(`[8080.ai] Project created: ${projectId}. Triggering AI stream...` + "\n");

      // 2. Trigger the AI response stream using the dedicated trigger endpoint
      const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/chat/messages/ai/stream-trigger`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          project_id: projectId,
          model: options?.model,
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

      if (!res.body) throw new Error("No response body in stream");

      return new Promise((resolve, reject) => {
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
              } else if ((data.type === "suggested_agents" || data.agents || data.suggestedAgents) && onAgents) {
                const agentsData = data.agents || data.suggested_agents || data.suggestedAgents || [];
                const agents = Array.isArray(agentsData) ? agentsData : Object.keys(agentsData);
                if (agents.length > 0) {
                  onAgents(agents, projectId, data.message_id || data.messageId || "");
                }
              }
            } catch (err) { }
          }
        });

        const reader = res.body!.getReader();
        const decoder = new TextDecoder("utf-8");

        function pump() {
          reader.read().then(({ done, value }) => {
            if (done) {
              if (!isDone) {
                isDone = true;
                resolve({ projectId });
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
    async createDesignShare(projectId: string): Promise<{ share_id: string; is_public: boolean; share_url?: string;[key: string]: unknown }> {
      const res = await post(`/projects/${projectId}/design-share`) as Record<string, unknown>;
      process.stderr.write(`[8080.ai API] design-share response: ${JSON.stringify(res, null, 2)}\n`);
      return res as { share_id: string; is_public: boolean; share_url?: string;[key: string]: unknown };
    },

    // Send follow-up message to AI and stream the response
    async streamSendMessage(
      projectId: string,
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
      process.stderr.write(`[8080.ai API] POST ${url}` + "\n");
      let modelToSend = options?.model;
      if (modelToSend === "large" || modelToSend === "super_large") {
        modelToSend = undefined;
      }

      const body = {
        project_id: projectId,
        content: content,
        model: modelToSend,
        media_urls: options?.mediaUrls ?? [],
        plan_auto: true,
      };
      console.log(`[8080.ai API] streamSendMessage request body: ${JSON.stringify(body)}`);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      });

      console.log(`[8080.ai API] Response: ${res.status} ${res.statusText}`);

      if (res.status === 401) throw new AuthError();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const errBody = await res.text();
          console.log(`[8080.ai API] Error body: ${errBody}`);
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
              process.stderr.write("[8080.ai API] SSE stream received [DONE]" + "\n");
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
                console.log(`[8080.ai API] SSE error event: ${errorMsg}`);
                if (!isDone) {
                  isDone = true;
                  reject(new Error(errorMsg));
                }
                return;
              } else if (data.type === "already_has_assistant") {
                console.log("[8080.ai API] already_has_assistant - AI is already processing.");
              }

              const agents = data.agents || data.suggested_agents || data.suggestedAgents || data.pending_suggested_agents;
              if ((data.type === "suggested_agents" || data.type === "agents") && agents) {
                let agentList: string[] = [];
                if (Array.isArray(agents)) agentList = agents;
                else if (typeof agents === "object" && agents !== null) {
                  agentList = Object.values(agents).filter((v): v is string => typeof v === "string");
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
                process.stderr.write(`[8080.ai API] SSE stream reached ${data.type}` + "\n");
              }
            } catch (err) {
              process.stderr.write(`[8080.ai API] Failed to parse SSE event data: ${event.data} ${err instanceof Error ? err.stack : String(err)}\n`);
            }
          }
        });

        const reader = res.body!.getReader();
        const decoder = new TextDecoder("utf-8");

        async function pump() {
          try {
            const { done, value } = await reader.read();
            if (done) {
              process.stderr.write("[8080.ai API] SSE stream reader done" + "\n");
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
            process.stderr.write(`[8080.ai API] SSE pump error: ${err instanceof Error ? err.stack : String(err)}\n`);
            reject(err);
          }
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
        model: model ?? "super_large",
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
        }
      });

      const reader = body.getReader();
      const decoder = new TextDecoder("utf-8");

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
          if (planningComplete) {
            reader.cancel().catch(() => { });
            break;
          }
        }
      } catch (err) {
        process.stderr.write(`[8080.ai API] Stream error: ${err instanceof Error ? err.stack : String(err)}\n`);
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
          process.stderr.write(`[8080.ai] Failed to read file ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      formData.append("project_id", projectId);

      const url = `${opts.apiBaseUrl.replace(/\/$/, "")}/chat/media/upload`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
        },
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
