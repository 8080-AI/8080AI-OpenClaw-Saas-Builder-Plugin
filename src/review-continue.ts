
// Builds A2UI JSONL for the Review / Continue button pair shown after the
// requirement document is ready. Each line is a JSON object.
//
// Button values are prefixed with "8080_review_" or "8080_continue_" so
// the agent can recognise them when they arrive back as user messages.
import { AGENT_DISPLAY_NAMES, type Project } from "./api-client.ts";
import { type MessagePresentation } from "openclaw/plugin-sdk";

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

export function buildProjectSelectionJsonl(projects: Project[]): string {
  const buttons = projects.map((p, i) => ({
    label: `${i + 1}. ${p.title} (${p.id})`,
    value: `8080_select_${p.id}`,
    style: "secondary"
  }));

  return JSON.stringify({
    type: "buttons",
    buttons: buttons
  });
}

/**
 * Builds a native OpenClaw MessagePresentation for project selection.
 * Used by tools in OpenClaw v2026.5+.
 */
export function buildProjectSelectionPresentation(projects: Project[]): any {
  return {
    type: "radio",
    placeholder: "Choose a project...",
    options: projects.map((p) => ({
      label: `${p.title} (${p.id})`,
      value: `8080_select_${p.id}`,
      description: p.status,
    })),
  };
}

export function buildSuggestedAgentsJsonl(projectId: string, agents: string[]): string {
  const buttons = agents.map(agent => {
    let label = "";
    if (agent.startsWith("GROUP:")) {
      const subAgents = agent.slice(6).split('|');
      const subLabels = subAgents.map(a => {
        const rawLabel = AGENT_DISPLAY_NAMES[a] ?? a;
        // Strip emojis/icons for the label
        return rawLabel.includes(" ") ? rawLabel.split(" ").slice(1).join(" ") : rawLabel;
      });
      label = `🚀 Run ${subLabels.join(", ")}`;
    } else {
      label = AGENT_DISPLAY_NAMES[agent] ?? agent;
    }

    let value = "";
    if (agent === "review") {
      value = `8080_review_${projectId}`;
    } else if (agent === "continue") {
      value = `8080_continue_${projectId}`;
    } else {
      const agentsList = agent.startsWith("GROUP:") ? agent.slice(6).split('|') : [agent];
      value = `8080_trigger_agents_${projectId}_${encodeURIComponent(JSON.stringify(agentsList))}`;
    }

    return {
      label,
      value,
      style: (agent === "plan_all" || agent.includes("plan_all") || agent === "continue") ? "primary" : "secondary"
    };
  });

  return JSON.stringify({
    type: "buttons",
    buttons: buttons
  });
}

/**
 * Builds a native OpenClaw MessagePresentation for suggested agents.
 * Used by tools in OpenClaw v2026.5+.
 */
export function buildSuggestedAgentsPresentation(
  projectId: string,
  agents: string[],
  responseText: string = ""
): any {
  if (responseText.trim().endsWith("?")) return null;

  const buttons = agents.map(agent => {
    let label = "";
    if (agent.startsWith("GROUP:")) {
      const subAgents = agent.slice(6).split('|');
      const subLabels = subAgents.map(a => {
        const rawLabel = AGENT_DISPLAY_NAMES[a] ?? a;
        return rawLabel.includes(" ") ? rawLabel.split(" ").slice(1).join(" ") : rawLabel;
      });
      label = `🚀 Run ${subLabels.join(", ")}`;
    } else {
      label = AGENT_DISPLAY_NAMES[agent] ?? agent;
    }

    let value = "";
    if (agent === "review") {
      value = `8080_review_${projectId}`;
    } else if (agent === "continue") {
      value = `8080_continue_${projectId}`;
    } else {
      const agentsList = agent.startsWith("GROUP:") ? agent.slice(6).split('|') : [agent];
      value = `8080_trigger_agents_${projectId}_${encodeURIComponent(JSON.stringify(agentsList))}`;
    }

    return {
      label,
      value,
      style: (agent === "plan_all" || agent.includes("plan_all") || agent === "continue") ? "primary" : "secondary"
    };
  });

  return {
    type: "buttons",
    title: "8080.ai Agents",
    message: "Choose an agent to trigger:",
    buttons
  };
}

// Parse a button value back to its action and projectId.
// Returns null if the value is not from this plugin.
export function parseButtonValue(
  value: string
): { action: "review" | "continue" | "trigger_agents" | "select"; projectId: string; agents?: string[] } | null {
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
  if (value.startsWith("8080_select_")) {
    return {
      action: "select",
      projectId: value.slice("8080_select_".length),
    };
  }
  return null;
}

export function buildSuggestedAgentsText(
  projectId: string,
  agents: string[],
  responseText: string = ""
): string {
  if (responseText.trim().endsWith("?")) {
    return "";
  }

  const lines = agents.map((agent, i) => {
    let label = "";
    if (agent.startsWith("GROUP:")) {
      const subAgents = agent.slice(6).split('|');
      const subLabels = subAgents.map(a => {
        const rawLabel = AGENT_DISPLAY_NAMES[a] ?? a;
        // Strip emojis/icons (anything before the first space) for the combined list
        return rawLabel.includes(" ") ? rawLabel.split(" ").slice(1).join(" ") : rawLabel;
      });
      label = `🚀 Run ${subLabels.join(", ")}`;
    } else {
      label = AGENT_DISPLAY_NAMES[agent] ?? agent;
    }
    return `${i + 1}. ${label}`;
  });

  return `### Suggested Next Steps:\n${lines.join("\n")}\n\nType the name of a step (e.g. "Continue") or its number to proceed.`;
}
