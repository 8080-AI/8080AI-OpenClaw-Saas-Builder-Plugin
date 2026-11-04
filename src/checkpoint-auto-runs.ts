import type { AutoRunsResponse } from "./api-client.ts";
import { buildSuggestedAgentChoices } from "./review-continue.ts";
import { hasScheduledAutoRunButton, mergeSuggestedButtons } from "./suggested-agents.ts";

// A suggestion event can precede the transaction that creates its countdown.
// Fetch the schedule directly, including when project detail has no pending agents.
export async function getCheckpointButtons(
  client: { getAutoRuns(projectId: string): Promise<AutoRunsResponse> },
  projectId: string,
  agents: string[],
  buttons?: any[],
  options: { attempts?: number; intervalMs?: number } = {}
): Promise<any[] | undefined> {
  let latest = buttons;
  const choices = buildSuggestedAgentChoices(projectId, agents, undefined, buttons);
  const timed = choices.some(choice => ["Start", "Generate First Page", "Generate Architecture"].includes(choice.label));
  for (let attempt = 0; attempt < (timed ? options.attempts ?? 4 : 1); attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 500));
    const schedule = await client.getAutoRuns(projectId).catch(() => null);
    if (!schedule || schedule.lookup_failed) continue;
    const autoButtons = schedule.auto_runs.map(entry => ({
      key: entry.button_key, kind: "auto_run", label: "Wait", action: "wait_auto_run",
      payload: { ...entry, server_now: schedule.server_now },
    }));
    latest = mergeSuggestedButtons(buttons, autoButtons);
    if (hasScheduledAutoRunButton(latest)) break;
    if (!timed) break;
  }
  return latest;
}
