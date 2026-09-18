
// Builds A2UI JSONL for the Review / Continue button pair shown after the
// requirement document is ready. Each line is a JSON object.
//
// Button values are prefixed with "8080_review_" or "8080_continue_" so
// the agent can recognise them when they arrive back as user messages.
import { AGENT_DISPLAY_NAMES, type Project } from "./api-client.ts";
import { type MessagePresentation } from "openclaw/plugin-sdk";

export function buildRequirementsUrl(siteUrl: string, projectId: string, sessionId?: string): string {
  const base = siteUrl.replace(/\/$/, "");
  return sessionId
    ? `${base}/planning/${projectId}/${sessionId}/requirements`
    : `${base}/planning/${projectId}/requirements`;
}

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

export type BackendButton = {
  key: string;
  kind: string;
  label: string;
  action: string;
  payload?: any;
};

export function getLabelForAgent(
  agent: string,
  continueButtonLabel?: string | boolean,
  backendButtons?: BackendButton[]
): string {
  // Keep the plan-all action name concise regardless of the legacy label
  // returned by the backend.
  if (
    agent === "plan_all" ||
    (agent.startsWith("GROUP:") && agent.slice(6).split("|").includes("plan_all"))
  ) return "Start";

  if (backendButtons && backendButtons.length > 0) {
    if (
      agent === "continue" ||
      agent === "generate_first_page" ||
      agent === "generate_all_pages" ||
      agent === "generate_architecture"
    ) {
      const btn = backendButtons.find(b =>
        b.action === "continue" ||
        b.action === "resume_design" ||
        b.key === "run_agents" ||
        (b.payload && b.payload.agents && (
          b.payload.agents.includes("continue") ||
          b.payload.agents.includes("generate_first_page") ||
          b.payload.agents.includes("generate_all_pages") ||
          b.payload.agents.includes("generate_architecture")
        ))
      );
      if (btn) return btn.label;
    } else if (agent === "review") {
      const btn = backendButtons.find(b =>
        b.action === "review" ||
        b.key === "review" ||
        b.key === "review_document" ||
        b.label.toLowerCase().includes("review")
      );
      if (btn) return btn.label;
    } else {
      const btn = backendButtons.find(b =>
        b.payload && b.payload.agents &&
        (b.payload.agents.includes(agent) ||
         (agent.startsWith("GROUP:") && agent.slice(6).split('|').every((a: string) => b.payload.agents.includes(a))))
      );
      if (btn) return btn.label;
    }
  }

  // Fallback to default labels
  if (agent.startsWith("GROUP:")) {
    const subAgents = agent.slice(6).split('|');
    const subLabels = subAgents.map(a => {
      const rawLabel = AGENT_DISPLAY_NAMES[a] ?? a;
      return rawLabel.includes(" ") ? rawLabel.split(" ").slice(1).join(" ") : rawLabel;
    });
    return `🚀 Run ${subLabels.join(", ")}`;
  }

  if (
    agent === "continue" ||
    agent === "generate_first_page" ||
    agent === "generate_all_pages" ||
    agent === "generate_architecture"
  ) {
    if (typeof continueButtonLabel === "string") {
      return continueButtonLabel;
    }
    if (agent === "generate_first_page") return "Generate First Page";
    if (agent === "generate_all_pages") return "Generate All Pages";
    if (agent === "generate_architecture") return "Generate Architecture";
    return continueButtonLabel ? "Generate First Page" : "Continue";
  }
  if (agent === "review") {
    return "Review";
  }
  return AGENT_DISPLAY_NAMES[agent] ?? agent;
}

export function buildSuggestedAgentsJsonl(
  projectId: string,
  agents: string[],
  continueButtonLabel?: string | boolean,
  backendButtons?: any[]
): string {
  const buttons = agents.map(agent => {
    const label = getLabelForAgent(agent, continueButtonLabel, backendButtons);

    let value = "";
    if (agent === "review") {
      value = `8080_review_${projectId}`;
    } else if (
      agent === "continue" ||
      agent === "generate_first_page" ||
      agent === "generate_all_pages" ||
      agent === "generate_architecture"
    ) {
      value = `8080_continue_${projectId}`;
    } else {
      const agentsList = agent.startsWith("GROUP:") ? agent.slice(6).split('|') : [agent];
      value = `8080_trigger_agents_${projectId}_${encodeURIComponent(JSON.stringify(agentsList))}`;
    }

    return {
      label,
      value,
      style: (
        agent === "plan_all" ||
        agent.includes("plan_all") ||
        agent === "continue" ||
        agent === "generate_first_page" ||
        agent === "generate_all_pages" ||
        agent === "generate_architecture"
      ) ? "primary" : "secondary"
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
  responseText: string = "",
  continueButtonLabel?: string | boolean,
  backendButtons?: any[]
): any {
  if (responseText.trim().endsWith("?")) return null;

  const buttons = agents.map(agent => {
    const label = getLabelForAgent(agent, continueButtonLabel, backendButtons);

    let value = "";
    if (agent === "review") {
      value = `8080_review_${projectId}`;
    } else if (
      agent === "continue" ||
      agent === "generate_first_page" ||
      agent === "generate_all_pages" ||
      agent === "generate_architecture"
    ) {
      value = `8080_continue_${projectId}`;
    } else {
      const agentsList = agent.startsWith("GROUP:") ? agent.slice(6).split('|') : [agent];
      value = `8080_trigger_agents_${projectId}_${encodeURIComponent(JSON.stringify(agentsList))}`;
    }

    return {
      label,
      value,
      style: (
        agent === "plan_all" ||
        agent.includes("plan_all") ||
        agent === "continue" ||
        agent === "generate_first_page" ||
        agent === "generate_all_pages" ||
        agent === "generate_architecture"
      ) ? "primary" : "secondary"
    };
  });

  return {
    type: "buttons",
    title: "8080.ai",
    message: agents.length === 2 && agents[0] === "continue" && agents[1] === "review"
      ? "Choose what to do next:"
      : "Choose an agent to trigger:",
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
  responseText: string = "",
  continueButtonLabel?: string | boolean,
  backendButtons?: any[]
): string {
  if (responseText.trim().endsWith("?")) {
    return "";
  }

  const lines = agents.map((agent, i) => {
    const label = getLabelForAgent(agent, continueButtonLabel, backendButtons);
    return `${i + 1}. ${label}`;
  });

  return `### Suggested Next Steps:\n${lines.join("\n")}\n`;
}
