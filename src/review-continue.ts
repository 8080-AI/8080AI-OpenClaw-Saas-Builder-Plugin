
// Builds A2UI JSONL for the Review / Continue button pair shown after the
// requirement document is ready. Each line is a JSON object.
//
// Button values are prefixed with "8080_review_" or "8080_continue_" so
// the agent can recognise them when they arrive back as user messages.
import { AGENT_DISPLAY_NAMES } from "./api-client.ts";

export function buildReviewContinueJsonl(
  projectId: string,
  requirementDocUrl: string
): string {
  const lines = [
    JSON.stringify({
      type: "text",
      text: `Requirement document is ready for review.\nURL: ${requirementDocUrl}`,
    }),
    JSON.stringify({
      type: "buttons",
      buttons: [
        {
          label: "Review Document",
          value: `8080_review_${projectId}`,
          style: "secondary",
        },
        {
          label: "Continue Building",
          value: `8080_continue_${projectId}`,
          style: "primary",
        },
      ],
    }),
  ];
  return lines.join("\n");
}

// Parse a button value back to its action and projectId.
// Returns null if the value is not from this plugin.
export function parseButtonValue(
  value: string
): { action: "review" | "continue" | "trigger_agents"; projectId: string; agents?: string[] } | null {
  if (value.startsWith("8080_review_")) {
    return { action: "review", projectId: value.slice("8080_review_".length) };
  }
  if (value.startsWith("8080_continue_")) {
    return {
      action: "continue",
      projectId: value.slice("8080_continue_".length),
    };
  }
  if (value.startsWith("8080_trigger_agents_")) {
    // Format: 8080_trigger_agents_<projectId>_<agents_json>
    const rest = value.slice("8080_trigger_agents_".length);
    const separatorIndex = rest.indexOf("_");
    if (separatorIndex === -1) return null;
    const projectId = rest.slice(0, separatorIndex);
    const agentsJson = rest.slice(separatorIndex + 1);
    try {
      const agents = JSON.parse(decodeURIComponent(agentsJson));
      return { action: "trigger_agents", projectId, agents };
    } catch {
      return null;
    }
  }
  return null;
}

export function buildSuggestedAgentsText(
  agents: string[]
): string {
  const lines = agents.map((agent, i) => {
    const label = AGENT_DISPLAY_NAMES[agent] ?? agent;
    // Remove emojis for a cleaner list if preferred, or keep them. 
    // I'll keep them as they look good in the TUI.
    return `${i + 1}. ${label}`;
  });
  
  return `\n\n**Suggested Next Steps:**\n${lines.join("\n")}`;
}
