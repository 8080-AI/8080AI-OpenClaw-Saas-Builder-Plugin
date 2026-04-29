import { Type } from "@sinclair/typebox";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient, AGENT_DISPLAY_NAMES } from "./api-client.ts";

export function createTriggerAgentsTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
}) {
  return {
    name: "ai8080_trigger_agents",
    description:
      "Trigger specific AI agents on 8080.ai after the user has clicked the 'Run Requirements/Designs' button. " +
      "This starts the suggested agents working on the project requirements or designs.",
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

      let token: string;
      try {
        token = await requireToken(stateDir);
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { content: [{ type: "text", text: err.message }], details: null };
        }
        throw err;
      }

      try {
        const client = createApiClient({ token, apiBaseUrl });
        await client.triggerAgents(params.projectId, params.agents);
        
        const displayNames = params.agents.flatMap(a => {
          if (a === 'plan_all') {
            return ["SRD Agent", "User Flow Agent", "Design Agent"];
          }
          const label = AGENT_DISPLAY_NAMES[a] ?? a;
          // Clean up emojis for the list if they are present in the constant
          return [label.replace(/^[^a-zA-Z0-9\s]+/, '').trim()];
        });
        
        let accumulatedText = `✅ Triggered agents: ${displayNames.join(", ")}\n\n`;
        
        if (params.agents.includes('plan_all')) {
          accumulatedText += `[Agent] SRD Agent is running...\n`;
          accumulatedText += `[Agent] User Flow Agent is running...\n`;
          accumulatedText += `[Agent] Design Agent is running...\n\n`;
        }
        
        onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: null });

        // Stream events live to the dashboard
        let pausedForReview = false;
        await client.streamProjectEvents(params.projectId, {
          onAgentLog: (log) => {
            accumulatedText += `\n[Agent] ${log.summary}`;
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
          accumulatedText += `\n\n**Suggested Next Steps:**\n`;
          finalAgentsAfter.forEach((agent, index) => {
            const label = AGENT_DISPLAY_NAMES[agent] ?? agent;
            accumulatedText += `${index + 1}. ${label}\n`;
          });
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
            suggestions: finalAgentsAfter
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
