import { Type } from "@sinclair/typebox";
import { createContinueProjectTool } from "./continue-project-tool.ts";
import { createReviewProjectTool } from "./review-project-tool.ts";
import { createTriggerAgentsTool } from "./trigger-agents-tool.ts";
import { readLatestSuggestions } from "./suggestions-state.ts";
import { requireAuthenticatedClient, determineContinueButtonLabel } from "./api-client.ts";
import { getLabelForAgent } from "./review-continue.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { log } from "../logger.ts";

function normalizeChoiceText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function createSelectButtonTool(deps: {
  stateDir: () => string;
  siteUrl: string;
  apiBaseUrl: string;
  sessionId: string;
}) {
  return {
    name: "ai8080_select_button",
    description:
      "Select one of the currently displayed 8080.ai Suggested Next Steps by number or name. " +
      "Use this when the user says 'select 1', 'select-1', 'choose option 1', 'option 2', " +
      "'continue', 'review', 'start building', or similar after 8080.ai shows numbered suggestions. " +
      "Resolve the choice against the saved suggestions and run the matching action. " +
      "For long-running 8080.ai actions, always pass timeoutMs=600000 so OpenClaw allows the tool call to wait for agent completion.",
    parameters: Type.Object({
      choice: Type.String({
        description:
          "The user's selected option number or name, for example '1', '2', 'continue', 'review', or 'start building'.",
      }),
      timeoutMs: Type.Number({
        default: 600000,
        minimum: 1,
        maximum: 600000,
        description: "Required OpenClaw dynamic-tool timeout override in milliseconds. Always use 600000 for 8080.ai long-running actions.",
      }),
    }),

    async execute(
      _id: string,
      params: { choice: string; timeoutMs?: number },
      signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[]; details?: unknown; presentation?: unknown }) => void
    ) {
      const stateDir = deps.stateDir();
      const choice = params.choice.trim();
      let suggestions = await readLatestSuggestions(stateDir, deps.sessionId);

      log.info("select_button tool latest suggestions from state file", {
        choice,
        sessionId: deps.sessionId,
        suggestions,
      });

      if (!choice) {
        return {
          content: [{ type: "text", text: "Usage: select an 8080.ai suggestion by number, for example `select 1`." }],
        };
      }

      const { readActiveProject } = await import("./project-state.ts");
      const activeProjectId = suggestions?.projectId || await readActiveProject(stateDir, deps.sessionId);

      let agents = suggestions?.agents || [];
      let buttons = suggestions?.buttons || [];

      // If local suggestions state is empty, attempt to fetch from backend API
      if (agents.length === 0 && activeProjectId) {
        const client = await requireAuthenticatedClient(stateDir, deps.apiBaseUrl).catch(() => null);
        if (client) {
          const status = await client.getProjectStatus(activeProjectId).catch(() => null);
          if (status) {
            const pending = extractPendingSuggestion(status.pending_suggested_agents);
            if (pending.agents && pending.agents.length > 0) {
              agents = pending.agents;
              buttons = pending.buttons || [];
            }
          }
        }
      }

      const normalizedChoice = normalizeChoiceText(choice);
      const num = parseInt(choice, 10);
      let selectedAgent: string | undefined;

      if (!Number.isNaN(num)) {
        if (agents.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No numbered suggestions are currently available.`,
            }],
          };
        }
        if (num < 1 || num > agents.length) {
          return {
            content: [{
              type: "text",
              text: `"${choice}" is not valid. Pick a number between 1 and ${agents.length}.`,
            }],
          };
        }
        selectedAgent = agents[num - 1];
      } else {
        // 1. Try matching agent ID directly
        selectedAgent = agents.find((agent) => {
          const normalizedAgent = normalizeChoiceText(agent);
          return normalizedAgent === normalizedChoice;
        });

        // 2. Try matching start building/start build
        if (!selectedAgent && (normalizedChoice === "start_building" || normalizedChoice === "start_build")) {
          selectedAgent = agents.find((agent) => agent === "start_building" || agent === "start_build");
        }

        // 3. Try matching resolved button labels
        if (!selectedAgent && activeProjectId) {
          const client = await requireAuthenticatedClient(stateDir, deps.apiBaseUrl).catch(() => null);
          let continueButtonLabel: string | boolean = false;
          if (client) {
            continueButtonLabel = await determineContinueButtonLabel(client, activeProjectId).catch(() => false);
          }
          selectedAgent = agents.find((agent) => {
            const label = getLabelForAgent(agent, continueButtonLabel, buttons);
            const normalizedLabel = normalizeChoiceText(label);
            return normalizedLabel === normalizedChoice;
          });
        }

        // 4. Ultimate fallbacks for direct choice text:
        if (!selectedAgent) {
          if (
            normalizedChoice === "continue" ||
            normalizedChoice === "generate_first_page" ||
            normalizedChoice === "generate_all_pages" ||
            normalizedChoice === "generate_architecture" ||
            normalizedChoice === "start_building" ||
            normalizedChoice === "start_build"
          ) {
            selectedAgent = "continue";
          } else if (normalizedChoice === "review" || normalizedChoice === "review_requirements") {
            selectedAgent = "review";
          }
        }
      }

      if (!selectedAgent || !activeProjectId) {
        const validRangeText = agents.length > 0 ? `between 1 and ${agents.length}` : "";
        return {
          content: [{
            type: "text",
            text: `"${choice}" is not valid. ${validRangeText ? "Pick a number " + validRangeText + ", or use an option name." : "Please use a valid action name like 'continue' or 'review'."}`,
          }],
        };
      }

      log.info("select_button tool resolved selection", {
        choice,
        selectedAgent,
        projectId: activeProjectId,
        suggestions: agents,
      });

      if (selectedAgent === "continue") {
        const tool = createContinueProjectTool({
          stateDir: deps.stateDir,
          apiBaseUrl: deps.apiBaseUrl,
          sessionId: deps.sessionId,
        });
        return tool.execute(_id, { projectId: activeProjectId }, signal, onUpdate);
      }

      if (selectedAgent === "review") {
        const tool = createReviewProjectTool({
          stateDir: deps.stateDir,
          siteUrl: deps.siteUrl,
          apiBaseUrl: deps.apiBaseUrl,
          sessionId: deps.sessionId,
        });
        return tool.execute(_id, { projectId: activeProjectId }, signal, onUpdate);
      }

      const triggerAgents = selectedAgent.startsWith("GROUP:")
        ? selectedAgent.slice(6).split("|")
        : [selectedAgent];
      const tool = createTriggerAgentsTool({
        stateDir: deps.stateDir,
        apiBaseUrl: deps.apiBaseUrl,
        sessionId: deps.sessionId,
      });
      return tool.execute(_id, { projectId: activeProjectId, agents: triggerAgents }, signal, onUpdate);
    },
  };
}
