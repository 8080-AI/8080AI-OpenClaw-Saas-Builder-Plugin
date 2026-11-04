  import type { WorkflowSnapshot } from "./workflow-sync.ts";

const descriptions: Record<string, string> = {
  Start: "Planning the project: defining requirements, personas, and user flows.",
  "Generate First Page": "Designing the first page and reviewing its layout and visual output.",
  "Generate All Pages": "Designing the remaining pages and reviewing their visual output.",
  "Generate Architecture": "Preparing the system architecture and implementation task plan.",
};
type ProgressAgent = { name: string; action: string; startedAt?: number; updatedAt: number; summary?: string | null };
type ProgressStage = { label: string; agents: Record<string, ProgressAgent> };
export type WorkflowProgressState = {
  startedAt: number;
  stages: ProgressStage[];
  pending?: { label: string; expiresAt: number };
};
const parseTime = (value: string) => Date.parse(/(?:z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
const seconds = (start: number, end: number) => Math.max(0, Math.floor((end - start) / 1000));

/** Keep the accumulated stage text across bounded observation calls. Times
 * come from backend logs and schedules; these are elapsed times, not ETAs. */
export class WorkflowProgress {
  readonly state: WorkflowProgressState;
  constructor(startedAt: number, initialStage = "Start", saved?: WorkflowProgressState) {
    this.state = saved ?? { startedAt, stages: [{ label: initialStage, agents: {} }] };
  }
  update(snapshot: WorkflowSnapshot): string {
    const current = () => this.state.stages.at(-1)!;
    for (const entry of [...snapshot.agents].sort((a, b) => parseTime(a.created_at) - parseTime(b.created_at))) {
      const updatedAt = parseTime(entry.created_at);
      if (!Number.isFinite(updatedAt) || updatedAt < this.state.startedAt - 5_000) continue;
      const key = `${entry.agent_type}:${entry.message_id ?? ""}:${entry.startedAt ?? updatedAt}`;
      const existing = this.state.stages.find(stage => key in stage.agents);
      let label = current().label;
      if (!existing) {
        if (/system requirements|user flow/i.test(entry.agent_type)) label = "Start";
        else if (/system architect|project manager/i.test(entry.agent_type)) label = "Generate Architecture";
        else if (/design agent|page designer|visual.*review|design.*review/i.test(entry.agent_type)) {
          const pending = this.state.pending;
          label = pending && /Generate (First Page|All Pages)/.test(pending.label) && pending.expiresAt <= snapshot.now
            ? pending.label : /Generate (First Page|All Pages)/.test(label) ? label : "Generate First Page";
        }
      }
      let stage = existing ?? this.state.stages.find(item => item.label === label);
      if (!stage) { stage = { label, agents: {} }; this.state.stages.push(stage); }
      stage.agents[key] = { name: entry.agent_type, action: entry.action, startedAt: entry.startedAt,
        updatedAt, summary: entry.summary };
    }
    const hasStarted = (pending: { label: string; expiresAt: number }) =>
      this.state.stages.some(stage => stage.label === pending.label && Object.values(stage.agents)
        .some(agent => (agent.startedAt ?? agent.updatedAt) >= pending.expiresAt - 1_000));
    const next = snapshot.schedules.find(schedule => descriptions[schedule.label] && !hasStarted(schedule));
    if (next) this.state.pending = { label: next.label, expiresAt: next.expiresAt };
    else if (this.state.pending && (hasStarted(this.state.pending) || this.state.pending.expiresAt > snapshot.now)) {
      // An empty authoritative schedule cancels an unexpired countdown; a
      // started agent confirms an expired countdown has already advanced.
      this.state.pending = undefined;
    }
    return this.render(snapshot.now, next);
  }
  render(now: number, next?: { label: string; expiresAt: number }, complete = false, manual = false): string {
    const lines = [`### ${complete ? "Generation complete" : manual ? "Generation paused for your action" : "Automatic generation progress"}`,
      `Elapsed: ${seconds(this.state.startedAt, now)} seconds.`];
    for (const stage of this.state.stages) {
      lines.push(`\n**${stage.label}**`, descriptions[stage.label] ?? "Observing the current generation stage.");
      const agents = Object.values(stage.agents);
      if (!agents.length) lines.push("Waiting for backend agent activity.");
      for (const agent of agents) {
        const running = ["started", "running"].includes(agent.action);
        const duration = agent.startedAt === undefined ? "" : ` — ${seconds(agent.startedAt, running ? now : agent.updatedAt)} seconds${running ? " elapsed" : ""}`;
        const status = running ? (complete || manual) ? "last reported running" : "running" : agent.action;
        lines.push(`- ${agent.name}: ${status}${duration}${agent.summary ? `. ${agent.summary}` : ""}`);
      }
    }
    if (manual) {
      lines.push("\n8080.ai has not scheduled the next action automatically. Choose a suggested action below to continue.");
    } else if (!complete) {
      const pending = next ?? this.state.pending;
      if (pending && pending.expiresAt > now) {
        lines.push(`\n**Next: ${pending.label}** — automatically triggers in ${Math.max(0, Math.ceil((pending.expiresAt - now) / 1000))} seconds.`,
          descriptions[pending.label] ?? "8080.ai will start the next stage automatically.");
      } else if (pending) lines.push(`\nWaiting for 8080.ai to confirm ${pending.label} has started.`);
      lines.push("\nFollowing 8080.ai automatically. No further generation clicks are needed.");
    }
    return lines.join("\n");
  }
}
