import { Type } from "@sinclair/typebox";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient, AGENT_DISPLAY_NAMES, requireAuthenticatedClient } from "./api-client.ts";
import { buildSuggestedAgentsPresentation, buildSuggestedAgentsText } from "./review-continue.ts";
import { groupAgents } from "./command.ts";
import { readActiveModel } from "./model-state.ts";

export function createTriggerAgentsTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
}) {
  return {
    name: "ai8080_trigger_agents",
    description:
      "Trigger specific AI agents on 8080.ai. " +
      "If the user sends a raw button payload like '8080_trigger_agents_<projectId>_<agentsJsonArray>', you MUST use this tool. Extract the projectId and parse the JSON array of agents to pass as arguments. This starts the suggested agents working on the project.",
    parameters: Type.Object({
      projectId: Type.String({
        description: "The 8080.ai project ID to trigger agents for.",
      }),
      agents: Type.Array(Type.String(), {
        description: "List of agent names to trigger (e.g., ['requirements', 'design']).",
      }),
    }),

    async execute(
      _id: string,
      params: { projectId: string; agents: string[] },
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[]; details: any }) => void
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl } = deps;

      try {
        const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
        const activeModel = await readActiveModel(stateDir);
        if (params.agents.includes('continue')) {
          await client.resumeDesign(params.projectId);
        } else {
          await client.triggerAgents(params.projectId, params.agents, "", activeModel);
        }
        
        let displayNames: string[] = [];
        if (params.agents.includes('plan_all')) {
          displayNames = ["System Requirements Agent", "User Flow Planner", "Tech Lead Agent"];
        } else {
          displayNames = params.agents.map(a => AGENT_DISPLAY_NAMES[a] ?? a);
        }
        
        let accumulatedText = `✅ **Triggered agents:** ${displayNames.join(", ")}\n\n`;
        
        for (const name of displayNames) {
          accumulatedText += `⏳ [Agent] **${name}** is running...\n`;
        }
        accumulatedText += `\n`;
        
        onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null });

        // Stream events live to the dashboard (with 60s timeout to prevent hangs)
        let pausedForReview = false;
        let hasCompletedAgent = false;
        const streamPromise = client.streamProjectEvents(params.projectId, {
          onAgentLog: (log) => {
            if (log.action === "completed") {
              hasCompletedAgent = true;
              accumulatedText += `✅ [Agent] **${log.agent_type}** completed: ${log.summary}\n`;
            } else if (log.action === "started") {
              accumulatedText += `⏳ [Agent] **${log.agent_type}** started: ${log.summary}\n`;
            } else {
              accumulatedText += `ℹ️ [Agent] **${log.agent_type}**: ${log.summary}\n`;
            }
            
            onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null });
          },
          onChatMessage: (msg) => {
            accumulatedText += `\n\n**System:** ${msg.content}`;
            onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null });
          },
          onSrdChunk: (chunk) => {
            if (chunk.seq === 1) accumulatedText += `\n\n---\n\n`;
            accumulatedText += chunk.content;
            onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null });
          },
          onPlanningComplete: (data) => {
            if (data.status === "paused_for_review") {
              pausedForReview = true;
            }
          },
        });

        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(() => {
            console.log("[8080.ai tool] streamProjectEvents timed out after 60s");
            resolve();
          }, 60_000);
        });

        await Promise.race([streamPromise, timeoutPromise]);

        if (pausedForReview) {
          accumulatedText += `\n\n**Planning complete — ready for your review.**\n\n`;
          accumulatedText += `**What would you like to do next?**\n`;
          accumulatedText += `1. ▶️ Continue — proceed to building\n`;
          accumulatedText += `2. 🔍 Review — inspect the generated requirements & design\n`;

          onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null });

          return {
            content: [{ type: "text", text: accumulatedText }],
            details: {
              status: "paused_for_review",
              suggestions: ["continue", "review"],
            },
          };
        }

        // Fetch fresh suggestions from the project detail
        const projectStatusAfter = await client.getProjectStatus(params.projectId);
        const pendingAgents = projectStatusAfter.pending_suggested_agents;
        let finalAgentsAfter: string[] = [];

        // Extract agents from pending_suggested_agents (object format)
        if (pendingAgents && typeof pendingAgents === 'object') {
          if (Array.isArray((pendingAgents as any).agents)) {
            finalAgentsAfter = (pendingAgents as any).agents.filter((a: unknown): a is string => typeof a === 'string');
          } else {
            for (const [key, val] of Object.entries(pendingAgents)) {
              if (typeof val === 'string') finalAgentsAfter.push(val);
              else if (val === true) finalAgentsAfter.push(key);
            }
          }
        }

        // Fallback: if no suggestions but project is active, offer review/continue
        if (finalAgentsAfter.length === 0 && projectStatusAfter.status === 'active') {
            finalAgentsAfter.push('review', 'continue');
        }

        if (finalAgentsAfter.length > 0) {
          const suggestionsText = buildSuggestedAgentsText(params.projectId, groupAgents(finalAgentsAfter));
          accumulatedText += suggestionsText;

          return {
            content: [
              {
                type: "text",
                text: accumulatedText,
              },
            ],
            details: {
              status: "complete",
              suggestions: finalAgentsAfter
            }
          };
        }

        return {
          content: [
            {
              type: "text",
              text: accumulatedText,
            },
          ],
          details: {
            status: "complete",
            suggestions: []
          }
        };
      } catch (err) {
        if (err instanceof AuthError) {
          return { content: [{ type: "text", text: (err as Error).message }], details: null };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `8080.ai error: ${msg}` }], details: null };
      }
    },
  };
}
