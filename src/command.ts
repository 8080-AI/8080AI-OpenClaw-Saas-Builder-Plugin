import open from "open";
import { writeToken, clearToken, requireToken, AuthRequiredError } from "./auth.ts";
import { AuthError, createApiClient, AGENT_DISPLAY_NAMES, type BuildStep, requireAuthenticatedClient, validateToken } from "./api-client.ts";
import { readActiveProject, writeActiveProject } from "./project-state.ts";
import {
  buildReviewContinueJsonl,
  buildSuggestedAgentsJsonl,
  buildSuggestedAgentsPresentation,
  buildSuggestedAgentsText,
  parseButtonValue,
} from "./review-continue.ts";
import { writeLatestSuggestions, readLatestSuggestions } from "./suggestions-state.ts";
import { readActiveModel, writeActiveModel, MODEL_OPTIONS } from "./model-state.ts";

const HELP_TEXT = `8080.ai plugin commands:

  /ai8080 start <requirements>   Start a new project on 8080.ai
  /ai8080 login                  Log in to 8080.ai via browser
  /ai8080 set-token <token>      Manually set auth token (from browser console)
  /ai8080 credits                Show your remaining 8080.ai credits
  /ai8080 list                   List your projects
  /ai8080 select <number>        Select a project by its number from the list
  /ai8080 model                  Show current AI model & available options
  /ai8080 model <number>         Switch the AI model for builds
  /ai8080 message <text>         Send follow-up message to the AI (uses active project)
  /ai8080 select-button <number> Trigger suggested agents by their number

To build a project with 8080.ai, you can also just ask: "Use 8080.ai to build a todo app"`;

export function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function stripA2UI(text: string): string {
  return text.replace(/<!--\s*a2ui[\s\S]*?-->/g, "").trim();
}

/**
 * Extract agent names from the `pending_suggested_agents` field in a ProjectDetailResponse.
 * This field is an object (or null). We extract string values from it.
 * Returns an empty array if null/undefined.
 */
function extractSuggestedAgents(pending: Record<string, unknown> | null | undefined): string[] {
  if (!pending || typeof pending !== 'object') return [];

  // The field may be { agents: [...] } or { "agent_name": true } or similar.
  // Try the 'agents' array first.
  if (Array.isArray(pending.agents)) {
    return pending.agents.filter((a: unknown): a is string => typeof a === 'string');
  }

  // Fallback: collect all string values
  const agents: string[] = [];
  for (const [key, val] of Object.entries(pending)) {
    if (typeof val === 'string') agents.push(val);
    else if (val === true) agents.push(key); // { "plan_all": true } format
  }
  return agents;
}

/**
 * Groups multiple planning agents into a single "GROUP:agent1|agent2" string.
 * This allows showing them as a single option in the UI.
 */
export function groupAgents(agents: string[]): string[] {
  const planningAgents = [
    'System Requirements Agent',
    'Design Agent',
    'Project Manager',
    'System Architect Agent',
    'System Architect',
    'User Flow Planner Agent',
    'User Flow Planner',
    'plan_all'
  ];

  const toGroup = agents.filter(a => planningAgents.includes(a));
  const others = agents.filter(a => !planningAgents.includes(a));

  if (toGroup.length > 1) {
    // Combine all planning agents into one grouped entry
    return [`GROUP:${toGroup.join('|')}`, ...others];
  }

  return agents;
}

/**
 * Checks if the API response contains generated data (non-empty arrays).
 */
export function hasGeneratedData(data: unknown): boolean {
  if (!data) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === 'object') {
    for (const val of Object.values(data)) {
      if (Array.isArray(val) && val.length > 0) return true;
    }
  }
  return false;
}

export function create8080Command(
  api: {
    runtime: { state: { resolveStateDir(): string } };
  },
  urls: { siteUrl: string; apiBaseUrl: string }
) {
  const { siteUrl, apiBaseUrl } = urls;
  const sessionId = generateSessionId();

  return {
    name: "ai8080",
    description: "Interact with the 8080.ai platform",
    acceptsArgs: true,

    async handler(ctx: { args?: string }) {
      const stateDir = api.runtime.state.resolveStateDir();
      const tokens = (ctx.args ?? "").trim().split(/\s+/).filter(Boolean);
      let subcommand = tokens[0]?.toLowerCase();
      let rest = tokens.slice(1);

      // Handle multi-word subcommands to be lenient with syntax
      if (subcommand === "set" && rest[0]?.toLowerCase() === "token") {
        subcommand = "set-token";
        rest = rest.slice(1);
      } else if (subcommand === "select" && rest[0]?.toLowerCase() === "button") {
        subcommand = "select-button";
        rest = rest.slice(1);
      }

      switch (subcommand) {
        // ------------------------------------------------------------------
        case "start": {
          const requirements = rest.join(" ").trim();
          if (!requirements) {
            return { text: "Usage: /ai8080 start <requirements>" };
          }

          try {
            const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);

            const activeModel = await readActiveModel(stateDir);
            let responseText = "";
            let suggestedAgents: string[] = [];

            console.log("[8080.ai] Initializing project and connecting to stream...");

            // Call chat/messages API to create project and stream initial thoughts
            const result = await client.streamProjectCreation(
              requirements,
              (token) => {
                responseText += token;
              },
              undefined,
              (agents) => {
                suggestedAgents.push(...agents);
              },
              { model: activeModel }
            );

            const projectId = result.projectId;

            // Store project_id in session state
            await writeActiveProject(stateDir, projectId, sessionId);

            const groupedAgents = groupAgents(suggestedAgents);
            if (suggestedAgents.length > 0) {
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId,
                agents: groupedAgents,
                messageId: "", // streamProjectCreation doesn't always have a msgId, but triggerAgents needs one. 8080 seems to allow empty or placeholder for initial.
              });
            }

            const cleanText = stripA2UI(responseText);
            const streamDisplay = cleanText ? `\n\n**Tech Lead:**\n${cleanText}` : "";
            const agentList = groupedAgents.length > 0
              ? buildSuggestedAgentsText(groupedAgents)
              : "";

            return {
              text:
                `✅ **Stream connection established**\n` +
                `🚀 Project created on 8080.ai!${streamDisplay}\n\n` +
                `**Project ID:** ${projectId}\n\n` +
                `The project has been set as active for this session. ${agentList}`,
            };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `Failed to start project: ${msg}` };
          }
        }

        // ------------------------------------------------------------------
        case "login": {
          try {
            await open(siteUrl);
          } catch {
            // Browser failed to open — that's OK, user can open it manually
          }

          return {
            text:
              `🔗 Opening 8080.ai for login…\n\n` +
              `Steps to connect manually:\n` +
              `  1. Log in at ${siteUrl}\n` +
              `  2. Open browser console (F12 → Console)\n` +
              `  3. Run: localStorage.getItem('auth_token')\n` +
              `  4. Run this command in OpenClaw:\n\n` +
              `     /ai8080 set-token <your_token>\n\n` +
              `This will save your credentials securely for future project creation.`,
          };
        }

        // ------------------------------------------------------------------
        case "set-token": {
          const token = rest.join("").replace(/\s+/g, "");
          if (!token) {
            return {
              text: "Usage: /ai8080 set-token <token>\n\nGet your token from the browser console: localStorage.getItem('auth_token')",
            };
          }
          // Validate token before saving
          try {
            const isValid = await validateToken({ token, apiBaseUrl });
            if (!isValid) {
              return { text: "❌ Invalid token. Please check the token and try again." };
            }
          } catch (err) {
            return { text: `❌ Failed to validate token: ${err instanceof Error ? err.message : String(err)}` };
          }

          await writeToken(stateDir, token);
          return { text: "✅ Token validated and saved. You are now logged in to 8080.ai." };
        }

        // ------------------------------------------------------------------


        // ------------------------------------------------------------------
        case "credits": {
          try {
            const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
            const sub = await client.getSubscription();
            return {
              text:
                `8080.ai Subscription\n` +
                `  Plan      : ${sub.plan_name} (${sub.status})\n` +
                `  Credits   : ${sub.credits_balance}\n` +
                (sub.renews_at ? `  Renews at : ${sub.renews_at}\n` : ""),
            };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `8080.ai error: ${msg}` };
          }
        }

        // ------------------------------------------------------------------
        case "list": {
          let token: string;
          try {
            token = await requireToken(stateDir);
          } catch (err) {
            if (err instanceof AuthRequiredError) return { text: err.message };
            throw err;
          }
          try {
            const client = createApiClient({ token, apiBaseUrl });
            const projects = await client.listProjects();
            if (projects.length === 0) return { text: "No projects found." };

            const activeProjectId = await readActiveProject(stateDir, sessionId);

            // We'll update projects labels to include active marker if needed
            const projectsWithActiveMarker = projects.map((p, i) => {
              const isActive = p.id === activeProjectId;
              const marker = isActive ? "👉 " : "";
              return { ...p, title: `${marker}${p.title}` };
            });

            const a2ui = buildProjectSelectionJsonl(projectsWithActiveMarker);

            return {
              text:
                `### 8080.ai Projects:\n\nSelect a project from the list below.\n\n<!-- a2ui ${a2ui} -->\n\n` +
                `Type \`/ai8080 select <number>\` to switch the active project if you prefer not to use the buttons.`,
            };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `8080.ai error: ${msg}` };
          }
        }

        // ------------------------------------------------------------------
        case "select": {
          const choice = rest[0]?.trim();
          if (!choice) {
            return { text: "Usage: `/ai8080 select <number>`\n\nRun `/ai8080 list` first to see available projects." };
          }

          let token: string;
          try {
            token = await requireToken(stateDir);
          } catch (err) {
            if (err instanceof AuthRequiredError) return { text: err.message };
            throw err;
          }
          try {
            const client = createApiClient({ token, apiBaseUrl });
            const projects = await client.listProjects();
            if (projects.length === 0) return { text: "No projects found." };

            const num = parseInt(choice, 10);
            if (isNaN(num) || num < 1 || num > projects.length) {
              const activeProjectId = await readActiveProject(stateDir, sessionId);
              const lines = projects.map((p, i) => {
                const isActive = p.id === activeProjectId;
                const marker = isActive ? "👉" : "  ";
                return `${marker} ${i + 1}. ${p.title} (\`${p.id}\`) [${p.status}]`;
              });
              return {
                text:
                  `⚠️  "${choice}" is not valid. Pick a number between 1 and ${projects.length}.\n\n` +
                  `### 8080.ai Projects:\n\n${lines.join("\n")}\n\n` +
                  `Type \`/ai8080 select <number>\` to switch the active project.`,
              };
            }

            const selected = projects[num - 1];
            await writeActiveProject(stateDir, selected.id, sessionId);
            return {
              text: `✅ Project \`${selected.title}\` is now active. (${selected.id})`,
            };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `8080.ai error: ${msg}` };
          }
        }

        // ------------------------------------------------------------------
        case "model": {
          const choice = rest[0]?.trim();
          const currentModel = await readActiveModel(stateDir);

          // Build the model list display
          const buildModelList = (errorMsg?: string) => {
            const lines = MODEL_OPTIONS.map((m, i) => {
              const isActive = m.id === currentModel;
              const marker = isActive ? "👉" : "  ";
              return `${marker} ${i + 1}. ${m.label} (${m.multiplier})`;
            });
            const header = `### 8080.ai AI Models:\n\n${lines.join("\n")}`;
            const footer = `\nType \`/ai8080 model <number>\` to switch the AI model.`;
            const err = errorMsg ? `\n⚠️  ${errorMsg}\n` : "";
            return { text: `${header}${err}${footer}` };
          };

          // No number given — just show the list
          if (!choice) {
            return buildModelList();
          }

          // Validate the number
          const num = parseInt(choice, 10);
          if (isNaN(num) || num < 1 || num > MODEL_OPTIONS.length) {
            return buildModelList(
              `"${choice}" is not valid. Pick a number between 1 and ${MODEL_OPTIONS.length}.`
            );
          }

          // Valid number — switch the model
          const selected = MODEL_OPTIONS[num - 1];
          await writeActiveModel(stateDir, selected.id);
          return {
            text: `✅ AI model switched to **${selected.label} (${selected.multiplier})**`,
          };
        }


        // ------------------------------------------------------------------
        case "message": {
          const content = rest.join(" ").trim();
          if (!content) {
            return { text: "Usage: /ai8080 message <text>" };
          }

          let projectId = (await readActiveProject(stateDir, sessionId)) ?? "";
          if (!projectId) {
            return {
              text: "No project active. Use `/ai8080 list` to select one or start a new project first.",
            };
          }

          let token: string;
          try {
            token = await requireToken(stateDir);
          } catch (err) {
            if (err instanceof AuthRequiredError) return { text: err.message };
            throw err;
          }

          try {
            const client = createApiClient({ token, apiBaseUrl });
            const activeModel = await readActiveModel(stateDir);
            let responseText = "";
            let suggestedAgents: string[] = [];
            let lastMessageId = "";

            console.log("[8080.ai] Sending message and connecting to stream...");

            await client.streamSendMessage(projectId, content, (token) => {
              responseText += token;
            }, {
              model: activeModel,
              onSuggestedAgents: (agents, msgId) => {
                suggestedAgents.push(...agents);
                lastMessageId = msgId;
              }
            });

            const groupedAgents = groupAgents(suggestedAgents);
            if (suggestedAgents.length > 0) {
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId,
                agents: groupedAgents,
                messageId: lastMessageId
              });
            }

            const cleanText = stripA2UI(responseText);
            const streamDisplay = cleanText ? `\n\n**AI Response:**\n${cleanText}` : "";
            const agentList = groupedAgents.length > 0
              ? buildSuggestedAgentsText(groupedAgents)
              : "";

            const presentation = buildSuggestedAgentsPresentation(projectId, groupedAgents, cleanText);
            const buttonsJsonl = groupedAgents.length > 0 ? `\n\n${buildSuggestedAgentsJsonl(projectId, groupedAgents)}` : "";

            return {
              text: `🤖 **Stream connection established**\n${streamDisplay}${agentList}${buttonsJsonl}`,
              presentation,
            };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `8080.ai error: ${msg}` };
          }
        }

        // ------------------------------------------------------------------
        case "select-button": {
          const choice = rest[0]?.trim();
          if (!choice) {
            return { text: "Usage: `/ai8080 select-button <number>`" };
          }

          const suggestions = await readLatestSuggestions(stateDir, sessionId);
          if (!suggestions || suggestions.agents.length === 0) {
            return { text: "No suggested agents found to select from." };
          }

          const num = parseInt(choice, 10);
          if (isNaN(num) || num < 1 || num > suggestions.agents.length) {
            return { text: `⚠️  "${choice}" is not valid. Pick a number between 1 and ${suggestions.agents.length}.` };
          }

          const selectedAgent = suggestions.agents[num - 1];

          let token: string;
          try {
            token = await requireToken(stateDir);
          } catch (err) {
            if (err instanceof AuthRequiredError) return { text: err.message };
            throw err;
          }

          try {
            const client = createApiClient({ token, apiBaseUrl });
            const activeModel = await readActiveModel(stateDir);

            if (selectedAgent === 'review') {
              const projectUrl = `${siteUrl}/projects/${suggestions.projectId}/requirement`;
              return {
                text: `🔍 **Review Mode**\n\nOpen your project to review the generated design and requirements:\n\n🔗 [${projectUrl}](${projectUrl})`,
              };
            }

            if (selectedAgent === 'start_building') {
              await client.startBuilding(suggestions.projectId, activeModel);
              return {
                text: `✅ **Building Started!** Agents are now writing your software.`,
              };
            }

            if (selectedAgent === 'continue') {
              await client.resumeDesign(suggestions.projectId);

              let pausedForReview = false;
              const logs: string[] = [];

              // Await stream so we can monitor generation
              await client.streamProjectEvents(suggestions.projectId, {
                onAgentLog: (log) => {
                  logs.push(`[${log.agent_type}] ${log.summary}`);
                },
                onChatMessage: (msg) => {
                  logs.push(`[System] ${msg.content}`);
                },
                onPlanningComplete: (data) => {
                  // The stream parser closes the reader automatically when planningComplete fires
                },
              });

              // Check if any of the three endpoints generated data
              const [designPages, tasks, arch] = await Promise.all([
                client.getDesignPages(suggestions.projectId).catch(() => null),
                client.getTasks(suggestions.projectId).catch(() => null),
                client.getArchitecture(suggestions.projectId).catch(() => null),
              ]);

              const isGenerated = hasGeneratedData(designPages) || hasGeneratedData(tasks) || hasGeneratedData(arch);
              const logsText = logs.length > 0 ? `\n\n**Activity Log:**\n${logs.map(l => `- ${l}`).join("\n")}` : "";

              if (isGenerated) {
                // Create a public design share link
                let shareUrl = "";
                try {
                  const share = await client.createDesignShare(suggestions.projectId);
                  // Build the public share URL, prioritizing the design-specific format with share_id
                  if (share && (share.share_id || share.id)) {
                    shareUrl = `${siteUrl}/design/${suggestions.projectId}/${share.share_id || share.id}`;
                  } else {
                    shareUrl = share.share_url || `${siteUrl}/projects/${suggestions.projectId}`;
                  }
                } catch (shareErr) {
                  console.error("[8080.ai] Failed to create design share:", shareErr);
                  shareUrl = `${siteUrl}/projects/${suggestions.projectId}`;
                }

                return {
                  text:
                    `✅ **Design generation complete!**\n${logsText}\n\n` +
                    `🔗 **Your Design Share Link:**\n${shareUrl}\n\n` +
                    `Share this link with anyone to preview the generated design, architecture, and requirements.\n\n` +
                    `---\n\n` +
                    `🚀 **Want to build this project end-to-end?**\n` +
                    `Visit [8080.ai](${siteUrl}) and upgrade to a **Premium plan** to unlock full project building — ` +
                    `from architecture to deployment, powered by AI agents.\n\n` +
                    `Type \`/ai8080 list\` to see your projects anytime.`,
                };
              } else {
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: suggestions.projectId,
                  agents: groupAgents(["continue", "review"]),
                  messageId: suggestions.messageId || "",
                });
                return {
                  text: `✅ **Agent execution finished, but no new designs were generated.**\n${logsText}\n\nType \`/ai8080 select-button 1\` to Continue again, or \`/ai8080 select-button 2\` to Review.`,
                };
              }
            }

            const agentsToTrigger = selectedAgent.startsWith('GROUP:')
              ? selectedAgent.slice(6).split('|')
              : [selectedAgent];

            await client.triggerAgents(suggestions.projectId, agentsToTrigger, suggestions.messageId, activeModel);

            const isPlanAll = selectedAgent === 'plan_all' || selectedAgent.includes('plan_all');

            let srdContent = "";
            const logs: string[] = [];
            let pausedForReview = false;

            // Await the entire stream so we can return the result to the dashboard
            await client.streamProjectEvents(suggestions.projectId, {
              onAgentLog: (log) => {
                logs.push(`[${log.agent_type}] ${log.summary}`);
              },
              onChatMessage: (msg) => {
                logs.push(`[System] ${msg.content}`);
              },
              onSrdChunk: (chunk) => {
                srdContent += chunk.content;
              },
              onPlanningComplete: (data) => {
                if (data.status === "paused_for_review") {
                  pausedForReview = true;
                }
              },
            });

            if (pausedForReview) {
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId: suggestions.projectId,
                agents: groupAgents(["continue", "review"]),
                messageId: suggestions.messageId || "",
              });

              const logsText = logs.length > 0 ? `\n\n**Activity Log:**\n${logs.map(l => `- ${l}`).join("\n")}` : "";
              const srdText = srdContent ? `\n\n---\n\n**System Requirements Document:**\n\n${srdContent}` : "";

              return {
                text:
                  `✅ **Planning complete — ready for your review.**\n` +
                  `${logsText}${srdText}\n\n` +
                  `**What would you like to do next?**\n` +
                  `1. ▶️ Continue — proceed to building\n` +
                  `2. 🔍 Review — inspect the generated requirements & design\n\n` +
                  `Run \`/ai8080 select-button 1\` to continue or \`/ai8080 select-button 2\` to review.`,
              };
            }

            const logsText = logs.length > 0 ? `\n\n**Activity Log:**\n${logs.map(l => `- ${l}`).join("\n")}` : "";
            const srdText = srdContent ? `\n\n---\n\n**System Requirements Document:**\n\n${srdContent}` : "";

            let agentLabel = "";
            if (selectedAgent.startsWith("GROUP:")) {
              const subAgents = selectedAgent.slice(6).split('|');
              const subLabels = subAgents.map(a => {
                const rawLabel = AGENT_DISPLAY_NAMES[a] ?? a;
                return rawLabel.includes(" ") ? rawLabel.split(" ").slice(1).join(" ") : rawLabel;
              });
              agentLabel = `Group (${subLabels.join(", ")})`;
            } else {
              agentLabel = (AGENT_DISPLAY_NAMES[selectedAgent] ?? selectedAgent);
            }

            // Fetch fresh suggestions from the project detail
            const projectStatusAfter = await client.getProjectStatus(suggestions.projectId);
            const pendingAgentsAfter = extractSuggestedAgents(projectStatusAfter.pending_suggested_agents);
            const finalAgentsAfter = [...pendingAgentsAfter];

            // Fallback: if no suggestions but project is active, offer review/continue
            if (finalAgentsAfter.length === 0 && projectStatusAfter.status === 'active') {
              finalAgentsAfter.push('review', 'continue');
            }

            const groupedAgentsAfter = groupAgents(finalAgentsAfter);
            // Save for next select-button call
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: suggestions.projectId,
              agents: groupedAgentsAfter,
              messageId: ""
            });

            const agentList = groupedAgentsAfter.length > 0
              ? buildSuggestedAgentsText(groupedAgentsAfter)
              : "";

            return {
              text:
                `✅ **${agentLabel}** run completed (using **${activeModel}**).` +
                `${logsText}${srdText}\n\n${agentList}`,
            };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `❌ Failed to trigger agent and collect results: ${msg}` };
          }
        }

        // ------------------------------------------------------------------
        default:
          return { text: HELP_TEXT };
      }
    },
  };
}
