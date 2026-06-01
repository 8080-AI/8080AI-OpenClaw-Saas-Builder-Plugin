import { Type } from "@sinclair/typebox";
import { createContinueProjectTool } from "./continue-project-tool.ts";
import { createReviewProjectTool } from "./review-project-tool.ts";
import { createTriggerAgentsTool } from "./trigger-agents-tool.ts";
import { readLatestSuggestions } from "./suggestions-state.ts";
import { log } from "../logger.ts";

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
      "Resolve the choice against the saved suggestions and run the matching action.",
    parameters: Type.Object({
      choice: Type.String({
        description:
          "The user's selected option number or name, for example '1', '2', 'continue', 'review', or 'start building'.",
      }),
    }),

    async execute(
      _id: string,
      params: { choice: string },
      signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[]; details?: unknown; presentation?: unknown }) => void
    ) {
      const stateDir = deps.stateDir();
      const choice = params.choice.trim();
      const suggestions = await readLatestSuggestions(stateDir, deps.sessionId);

      log.info("select_button tool latest suggestions", {
        choice,
        sessionId: deps.sessionId,
        suggestions,
      });

      if (!choice) {
        return {
          content: [{ type: "text", text: "Usage: select an 8080.ai suggestion by number, for example `select 1`." }],
        };
      }

      if (!suggestions || suggestions.agents.length === 0) {
        return {
          content: [{ type: "text", text: "No suggested 8080.ai action is currently available to select." }],
        };
      }

      const normalizedChoice = choice.toLowerCase().replace(/[\s_-]+/g, "_");
      const num = parseInt(choice, 10);
      let selectedAgent: string | undefined;

      if (!Number.isNaN(num)) {
        if (num < 1 || num > suggestions.agents.length) {
          return {
            content: [{
              type: "text",
              text: `"${choice}" is not valid. Pick a number between 1 and ${suggestions.agents.length}.`,
            }],
          };
        }
        selectedAgent = suggestions.agents[num - 1];
      } else {
        selectedAgent = suggestions.agents.find((agent) => {
          const normalizedAgent = agent.toLowerCase().replace(/[\s_-]+/g, "_");
          return normalizedAgent === normalizedChoice;
        });
        if (!selectedAgent && normalizedChoice === "start_building") {
          selectedAgent = suggestions.agents.find((agent) => agent === "start_building" || agent === "start_build");
        }
      }

      if (!selectedAgent) {
        return {
          content: [{
            type: "text",
            text: `"${choice}" is not valid. Pick a number between 1 and ${suggestions.agents.length}, or use an option name.`,
          }],
        };
      }

      log.info("select_button tool resolved selection", {
        choice,
        selectedAgent,
        projectId: suggestions.projectId,
        suggestions: suggestions.agents,
      });

      if (selectedAgent === "continue") {
        const tool = createContinueProjectTool({
          stateDir: deps.stateDir,
          apiBaseUrl: deps.apiBaseUrl,
          sessionId: deps.sessionId,
        });
        return tool.execute(_id, { projectId: suggestions.projectId }, signal, onUpdate);
      }

      if (selectedAgent === "review") {
        const tool = createReviewProjectTool({
          stateDir: deps.stateDir,
          siteUrl: deps.siteUrl,
          apiBaseUrl: deps.apiBaseUrl,
          sessionId: deps.sessionId,
        });
        return tool.execute(_id, { projectId: suggestions.projectId }, signal, onUpdate);
      }

      const agents = selectedAgent.startsWith("GROUP:")
        ? selectedAgent.slice(6).split("|")
        : [selectedAgent];
      const tool = createTriggerAgentsTool({
        stateDir: deps.stateDir,
        apiBaseUrl: deps.apiBaseUrl,
        sessionId: deps.sessionId,
      });
      return tool.execute(_id, { projectId: suggestions.projectId, agents }, signal, onUpdate);
    },
  };
}
