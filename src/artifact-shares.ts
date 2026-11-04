import { buildSuggestedAgentsText } from "./review-continue.ts";

export type ArtifactType = "requirements" | "user-flow" | "design" | "architecture" | "tasks";
type RecordValue = Record<string, unknown>;
export type ArtifactShareSnapshot = {
  requirements?: unknown;
  flows?: unknown;
  pages?: unknown;
  diagrams?: unknown;
  tasks?: unknown;
  planning?: unknown;
  logs?: unknown;
  timeline?: unknown;
};
export type ArtifactShareClient = {
  getArtifactShareSnapshot(projectId: string): Promise<ArtifactShareSnapshot>;
  createArtifactShare(projectId: string, artifactType: ArtifactType): Promise<{ share_id: string; is_public: boolean }>;
};

const labels: Record<ArtifactType, string> = {
  requirements: "SRD document", "user-flow": "User flow", design: "Design", architecture: "Architecture", tasks: "Tasks",
};
const generatingAgents: Partial<Record<ArtifactType, string>> = {
  requirements: "System Requirements Agent", "user-flow": "User Flow Planner", architecture: "System Architect",
};
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const time = (value: unknown): number => {
  const raw = text(value);
  return raw ? Date.parse(/(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`) || 0 : 0;
};
const latest = (values: unknown[]): number => Math.max(0, ...values.map(time));
function rows(value: unknown, keys: string[] = []): RecordValue[] {
  if (Array.isArray(value)) return value.filter((item): item is RecordValue => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  return keys.flatMap(key => rows(record(value)[key]));
}

/** New writes need completion evidence; a saved artifact from an older run remains usable. */
function completed(type: ArtifactType, savedAt: number, snapshot: ArtifactShareSnapshot): boolean {
  const agent = generatingAgents[type];
  if (!agent) return true;
  // A failed log read must not be mistaken for evidence that no run has started.
  if (!Array.isArray(snapshot.logs)) return false;
  const logs = rows(snapshot.logs).filter(log => log.agent_type === agent);
  const startedAt = latest(logs.filter(log => log.action === "started").map(log => log.created_at));
  const completedAt = latest(logs.filter(log => log.action === "completed").map(log => log.created_at));
  if (!startedAt || ((savedAt || completedAt) > 0 && (savedAt || completedAt) < startedAt)) return true;
  if (type === "requirements" && logs.some(log => log.action === "awaiting_review" && time(log.created_at) >= startedAt)) return true;
  const markerAt = type === "requirements" ? 0 : latest(rows(snapshot.timeline).filter(item => item.artifact_type === type)
    .map(item => item.created_at || item.timestamp));
  return Math.max(completedAt, markerAt) >= startedAt;
}

function readyDesign(page: RecordValue): boolean {
  const id = text(page.id);
  const missing = Array.isArray(page.missing_sections_json) ? page.missing_sections_json.length > 0 : Boolean(page.missing_sections_json);
  return Boolean(page.compiled_html || page.has_compiled_html || page.jsx_content || page.has_jsx_content) &&
    !page.planned && !id.startsWith("virtual:") && !id.startsWith("planned-") &&
    !(page.generation_phase === "planned" && !page.jsx_content && !page.has_jsx_content) &&
    !page.generation_in_progress && !page.generation_failed && !page.credit_blocked && !missing &&
    (!(Number(page.sections_total) > 0) || Number(page.sections_done || 0) >= Number(page.sections_total));
}

export function availableArtifactTypes(snapshot: ArtifactShareSnapshot): ArtifactType[] {
  const available: ArtifactType[] = [];
  const requirements = record(snapshot.requirements);
  if (text(requirements.content).replace(/<!--[\s\S]*?-->/g, "").trim() &&
      completed("requirements", latest([requirements.updated_at, requirements.created_at]), snapshot)) available.push("requirements");
  const flows = rows(snapshot.flows, ["user_flows", "flows"]).filter(flow => text(flow.mermaid_content).trim());
  if (flows.length && completed("user-flow", latest(flows.map(flow => flow.updated_at || flow.created_at)), snapshot)) available.push("user-flow");
  if (rows(snapshot.pages, ["pages", "design_pages"]).some(readyDesign)) available.push("design");
  const diagrams = rows(snapshot.diagrams, ["diagrams", "service_network", "sequence", "er_diagram", "backend_modules", "frontend_modules"])
    .filter(diagram => text(diagram.content).trim());
  if (diagrams.length && completed("architecture", latest(diagrams.map(diagram => diagram.updated_at)), snapshot)) available.push("architecture");
  // Do not interpret an unsuccessful planning read as a null (completed) PM step.
  const planning = record(snapshot.planning);
  if (snapshot.planning && typeof snapshot.planning === "object" && !Array.isArray(snapshot.planning) &&
      [undefined, null, "done", "skipped"].some(status => status === planning.pm_step_status) &&
      rows(snapshot.tasks, ["tasks"]).some(task => task.task_type !== "planning" && task.creation_source === "system")) available.push("tasks");
  return available;
}

export async function getArtifactShareText(client: Partial<ArtifactShareClient>, projectId: string, siteUrl = "https://8080.ai"): Promise<string> {
  if (!client.getArtifactShareSnapshot || !client.createArtifactShare) return "";
  try {
    const origin = new URL(siteUrl).origin;
    const snapshot = await client.getArtifactShareSnapshot(projectId);
    const types = availableArtifactTypes(snapshot);
    const results = await Promise.allSettled(types.map(async type => {
      const share = await client.createArtifactShare!(projectId, type);
      if (share.is_public !== true || !text(share.share_id).trim()) return "";
      const url = `${origin}/shared/artifacts/${encodeURIComponent(share.share_id)}`;
      return `- [${labels[type]}](${url})`;
    }));
    const links = results.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
    return links.length ? `### Public artifact links\n${links.join("\n")}` : "";
  } catch {
    // Sharing is supplemental. Unavailable artifacts/permissions never block the next action.
    return "";
  }
}

export async function buildSuggestedAgentsTextWithShares(
  client: object & Partial<ArtifactShareClient>, siteUrl: string | undefined,
  ...args: Parameters<typeof buildSuggestedAgentsText>
): Promise<string> {
  const suggestions = buildSuggestedAgentsText(...args);
  if (!suggestions || !args[1].length) return suggestions;
  const links = await getArtifactShareText(client, args[0], siteUrl);
  return links ? `${links}\n\n${suggestions}` : suggestions;
}
