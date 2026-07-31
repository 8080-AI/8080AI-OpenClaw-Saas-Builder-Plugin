const UPGRADE_TO_BUILD_TEXT =
  `🚀 **Want to build this project end-to-end?**\n` +
  `Visit [8080.ai](https://8080.ai) and upgrade to a **Premium plan** to unlock full project building — ` +
  `from architecture to deployment, powered by AI agents.\n\n`;

type TaskLike = {
  id?: unknown;
  task_number?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  effort_days?: unknown;
};

export function getTaskArray(data: unknown): TaskLike[] {
  if (Array.isArray(data)) return data as TaskLike[];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.tasks)) return record.tasks as TaskLike[];
    if (Array.isArray(record.data)) return record.data as TaskLike[];
  }
  return [];
}

function cleanValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeStatus(value: unknown): string {
  return cleanValue(value, "unknown").toLowerCase().replace(/[^a-z0-9]/g, "");
}



export function getUpgradeToBuildText(siteUrl = "https://8080.ai"): string {
  return UPGRADE_TO_BUILD_TEXT.replace("https://8080.ai", siteUrl.replace(/\/$/, ""));
}

function extractString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function matchPlanTier(planId: string | undefined, plans: unknown): string | undefined {
  if (!planId || !Array.isArray(plans)) return undefined;

  for (const plan of plans) {
    if (!plan || typeof plan !== "object") continue;
    const record = plan as Record<string, unknown>;
    const candidateId = extractString(record, ["id", "plan_id", "slug", "key"]);
    if (candidateId !== planId) continue;

    return extractString(record, ["tier", "name", "plan_name", "slug", "key"]);
  }

  return undefined;
}

export function detectSubscriptionTier(subscription: unknown, profile?: unknown, plans?: unknown): string {
  if (profile && typeof profile === "object") {
    const tier = extractString(profile as Record<string, unknown>, ["subscription_tier", "tier", "plan", "plan_name"]);
    if (tier) return tier.toLowerCase();
  }

  if (subscription && typeof subscription === "object") {
    const record = subscription as Record<string, unknown>;
    const planId = extractString(record, ["plan_id"]);
    const planTier = matchPlanTier(planId, plans);
    if (planTier) return planTier.toLowerCase();

    const tier = extractString(record, ["subscription_tier", "tier", "plan_id", "plan_name", "name"]);
    if (tier) return tier.toLowerCase();

    const planConfig = record.plan_config;
    if (planConfig && typeof planConfig === "object") {
      const configTier = extractString(planConfig as Record<string, unknown>, ["name", "tier", "plan_id"]);
      if (configTier) return configTier.toLowerCase();
    }
  }

  return "free";
}

export function formatStartBuildingTasks(data: unknown, projectId?: string, siteUrl = "https://8080.ai"): string {
  const tasks = getTaskArray(data).filter((task) => normalizeStatus(task.status) === "todo");
  const planningUrl = projectId
    ? `${siteUrl.replace(/\/$/, "")}/planning/${projectId}`
    : "";
  if (tasks.length === 0) {
    return [
      "No to-do tasks are available to queue right now.",
      planningUrl
        ? `Click the link below to review the Kanban board, adjust tasks, and follow the end-to-end build:\n${planningUrl}`
        : "",
    ].filter(Boolean).join("\n\n");
  }

  const lines = tasks.map((task, index) => {
    const taskNumber = typeof task.task_number === "number"
      ? String(task.task_number)
      : cleanValue(task.task_number, String(index + 1));
    const title = cleanValue(task.title, `Task ${index + 1}`);
    const description = cleanValue(task.description, "No description provided.");
    const priority = cleanValue(task.priority, "unknown");
    const effort = typeof task.effort_days === "number"
      ? `${task.effort_days} day${task.effort_days === 1 ? "" : "s"}`
      : cleanValue(task.effort_days, "unknown");

    return [
      `${index + 1}. **${title}**`,
      `Task Number: ${taskNumber}`,
      `Description: ${description}`,
      `Priority: ${priority}`,
      `Effort: ${effort}`,
    ].join("\n");
  });

  return [  
    `The following task${tasks.length === 1 ? "" : "s"} ${tasks.length === 1 ? "is" : "are"} now in queue for execution and will be picked up by the build agents in order.`,
    lines.join("\n\n"),
    planningUrl
      ? `Click the link below to review the Kanban board, adjust tasks, and follow the end-to-end build process:\n${planningUrl}`
      : "",
  ].filter(Boolean).join("\n\n");
}
