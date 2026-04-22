// ---------------------------------------------------------------------------
// 8080.ai API Client
//
// Base URL: https://api.8080.ai/api/v1 (paths below are relative to this).
// ---------------------------------------------------------------------------

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

export type ProjectStatus = {
  id: string;
  phase: ProjectPhase;
  activeAgent?: string;
  agentMessage?: string;
  requirementDocUrl?: string;
  error?: string;
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
    // plan_auto: true triggers the supervisor agents immediately.
    async createProject(requirements: string): Promise<{ projectId: string }> {
      const res = (await post("/chat/messages", {
        content: requirements,
        plan_auto: true,
      })) as { project_id: string };

      return { projectId: res.project_id };
    },

    // 8080.ai uses /projects/{id} (no slash) for detail
    async getProjectStatus(projectId: string): Promise<ProjectStatus> {
      return get(`/projects/${projectId}`) as Promise<ProjectStatus>;
    },

    // 8080.ai uses /projects/{id}/build (no slash) to start/continue building
    async continueProject(projectId: string, activeModel: string): Promise<void> {
      await post(`/projects/${projectId}/build`, {
        default_model: "super_large",
      });
    },
  };
}
