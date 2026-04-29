import open from "open";
import { writeToken, clearToken, requireToken, AuthRequiredError } from "./auth.ts";
import { AuthError, createApiClient, AGENT_DISPLAY_NAMES, type BuildStep } from "./api-client.ts";
import { readActiveProject, writeActiveProject } from "./project-state.ts";
import { buildSuggestedAgentsText } from "./review-continue.ts";
import { writeLatestSuggestions, readLatestSuggestions } from "./suggestions-state.ts";
import { readActiveModel, writeActiveModel, MODEL_OPTIONS } from "./model-state.ts";

const HELP_TEXT = `8080.ai plugin commands:

  /ai8080 start <requirements>   Start a new project on 8080.ai
  /ai8080 login                  Log in to 8080.ai via browser
  /ai8080 logout                 Log out and clear saved credentials
  /ai8080 set-token <token>      Manually set auth token (from browser console)
  /ai8080 credits                Show your remaining 8080.ai credits
  /ai8080 list                   List your projects
  /ai8080 select <number>        Select a project by its number from the list
  /ai8080 model                  Show current AI model & available options
  /ai8080 model <number>         Switch the AI model for builds
  /ai8080 status [projectId]     Show status of the active (or specified) project
  /ai8080 review [projectId]     Open requirement document for the project
  /ai8080 continue [projectId]   Proceed past requirement review
  /ai8080 message <text>         Send follow-up message to the AI (uses active project)
  /ai8080 select-button <number> Trigger suggested agents by their number

To build a project with 8080.ai, you can also just ask: "Use 8080.ai to build a todo app"`;

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function stripA2UI(text: string): string {
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
      const [subcommand, ...rest] = tokens;

      switch (subcommand?.toLowerCase()) {
        // ------------------------------------------------------------------
        case "start": {
          const requirements = rest.join(" ").trim();
          if (!requirements) {
            return { text: "Usage: /ai8080 start <requirements>" };
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
            let rawLog = "";
            let suggestedAgents: string[] = [];

            console.log("[8080.ai] Initializing project and connecting to stream...");

            // Call chat/messages API to create project and stream initial thoughts
            const result = await client.streamProjectCreation(
              requirements,
              (token) => {
                responseText += token;
              },
              (raw) => {
                rawLog += `data: ${raw}\n\n`;
              },
              (agents) => {
                suggestedAgents.push(...agents);
              },
              { model: activeModel }
            );

            const projectId = result.projectId;

            // Store project_id in session state
            await writeActiveProject(stateDir, projectId, sessionId);

            if (suggestedAgents.length > 0) {
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId,
                agents: suggestedAgents,
                messageId: "", // streamProjectCreation doesn't always have a msgId, but triggerAgents needs one. 8080 seems to allow empty or placeholder for initial.
              });
            }

            const cleanText = stripA2UI(responseText);
            const streamDisplay = cleanText ? `\n\n**Tech Lead:**\n${cleanText}` : "";
            const rawDisplay = rawLog ? `\n\n---\n**Raw Network Stream:**\n\`\`\`text\n${rawLog.slice(0, 500)}${rawLog.length > 500 ? "..." : ""}\n\`\`\`` : "";
            const agentList = suggestedAgents.length > 0
              ? buildSuggestedAgentsText(suggestedAgents)
              : "";

            return {
              text:
                `✅ **Stream connection established**\n` +
                `🚀 Project created on 8080.ai!${streamDisplay}${rawDisplay}\n\n` +
                `**Project ID:** ${projectId}\n\n` +
                `The project has been set as active for this session. `,
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
          const token = rest[0]?.trim();
          if (!token) {
            return {
              text: "Usage: /ai8080 set-token <token>\n\nGet your token from the browser console: localStorage.getItem('auth_token')",
            };
          }
          await writeToken(stateDir, token);
          return { text: "✅ Token saved. You are now logged in to 8080.ai." };
        }

        // ------------------------------------------------------------------
        case "logout": {
          await clearToken(stateDir);
          return {
            text: "Logged out of 8080.ai. saved credentials cleared.",
          };
        }

        // ------------------------------------------------------------------
        case "credits": {
          let token: string;
          try {
            token = await requireToken(stateDir);
          } catch (err) {
            if (err instanceof AuthRequiredError) {
              return { text: err.message };
            }
            throw err;
          }
          try {
            const client = createApiClient({ token, apiBaseUrl });
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

            const lines = projects.map((p, i) => {
              const isActive = p.id === activeProjectId;
              const marker = isActive ? "👉" : "  ";
              return `${marker} ${i + 1}. ${p.title} (${p.status})`;
            });

            return {
              text:
                `### 8080.ai Projects:\n\n${lines.join("\n")}\n\n` +
                `Type \`/ai8080 select <number>\` to switch the active project.`,
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
                return `${marker} ${i + 1}. ${p.title} (${p.status})`;
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
        case "status": {
          let projectId = rest[0]?.trim();
          if (!projectId) {
            projectId = (await readActiveProject(stateDir, sessionId)) ?? "";
          }

          if (!projectId) {
            return {
              text: "No project active. Use `/ai8080 list` to select one`",
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
            const s = await client.getProjectStatus(projectId);

            // --- Build the step progress display ---
            const KNOWN_STEPS = [
              { key: "ai-overview", label: "AI Overview" },
              { key: "requirements", label: "Requirements" },
              { key: "design", label: "Design" },
              { key: "architecture", label: "Architecture" },
              { key: "implementation", label: "Implementation" },
              { key: "testing", label: "Testing" },
              { key: "deployment", label: "Deployment" },
            ];

            const lines: string[] = [];
            lines.push(`### 📊 Project Status`);
            if (s.title) lines.push(`**Project:** ${s.title}`);
            lines.push(`**ID:** ${projectId}`);
            lines.push(`**Phase:** ${s.phase ?? s.status ?? "unknown"}`);
            if (s.activeAgent) lines.push(`**Agent:** ${s.activeAgent}`);
            if (s.agentMessage) lines.push(`**Message:** ${s.agentMessage}`);
            if (s.progress !== undefined) lines.push(`**Progress:** ${s.progress}%`);

            // Show steps if available from the API
            if (s.steps && Array.isArray(s.steps) && s.steps.length > 0) {
              lines.push("");
              lines.push("**Build Steps:**");
              for (const step of s.steps) {
                const icon =
                  step.status === "completed" ? "✅" :
                    step.status === "in_progress" ? "🔄" :
                      step.status === "failed" ? "❌" : "⏳";
                lines.push(`  ${icon} ${step.name}`);
              }
            }
            // If we have current_step but no steps array, show it inline
            else if (s.current_step) {
              lines.push("");
              lines.push("**Build Steps:**");
              let foundCurrent = false;
              for (const known of KNOWN_STEPS) {
                if (foundCurrent) {
                  lines.push(`  ⏳ ${known.label}`);
                } else if (known.key === s.current_step || known.label.toLowerCase() === s.current_step.toLowerCase()) {
                  lines.push(`  🔄 ${known.label}  ← current`);
                  foundCurrent = true;
                } else {
                  lines.push(`  ✅ ${known.label}`);
                }
              }
              // If current_step didn't match any known step, show it anyway
              if (!foundCurrent) {
                lines.push(`  🔄 ${s.current_step}  ← current`);
              }
            }

            if (s.requirementDocUrl) lines.push(`\n**Req Doc:** ${s.requirementDocUrl}`);
            if (s.error) lines.push(`\n❌ **Error:** ${s.error}`);

            // --- Suggestions ---
            // Extract from pending_suggested_agents in the ProjectDetailResponse
            const pendingAgents = extractSuggestedAgents(s.pending_suggested_agents);
            const finalAgents = [...pendingAgents];
            if (finalAgents.length === 0 && s.status === 'active') {
              // If no agents suggested but project is active,
              // it likely means planning is complete and waiting for review/continue.
              finalAgents.push('review', 'continue');
            }

            if (finalAgents.length > 0) {
              lines.push("\n**Suggested Next Steps:**");
              finalAgents.forEach((agent, index) => {
                const label = AGENT_DISPLAY_NAMES[agent] ?? agent;
                lines.push(`${index + 1}. ${label}`);
              });
              lines.push(`\nType \`/ai8080 select-button <number>\` to proceed.`);

              // Save suggestions for select-button
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId,
                agents: finalAgents,
                messageId: ""
              });
            }

            // Dump the FULL raw API response for field discovery
            lines.push("");
            lines.push("---");
            lines.push("**Raw API Response (for debugging):**");
            lines.push("```json");
            lines.push(JSON.stringify(s, null, 2));
            lines.push("```");

            return { text: lines.join("\n") };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `8080.ai error: ${msg}` };
          }
        }

        // ------------------------------------------------------------------
        case "review": {
          let projectId = rest[0]?.trim();
          if (!projectId) {
            projectId = (await readActiveProject(stateDir, sessionId)) ?? "";
          }

          if (!projectId) {
            return {
              text: "No project active. Use `/ai8080 list` to select one or provide a project ID: `/ai8080 review <projectId>`",
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
            const s = await client.getProjectStatus(projectId);
            if (!s.requirementDocUrl) {
              return {
                text: `No requirement document available yet for project ${projectId}. Current phase: ${s.phase}`,
              };
            }
            await open(s.requirementDocUrl);
            return {
              text: `Opened requirement document in browser:\n${s.requirementDocUrl}`,
            };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `8080.ai error: ${msg}` };
          }
        }

        // ------------------------------------------------------------------
        case "continue": {
          let projectId = rest[0]?.trim();
          if (!projectId) {
            projectId = (await readActiveProject(stateDir, sessionId)) ?? "";
          }

          if (!projectId) {
            return {
              text: "No project active. Use `/ai8080 list` to select one or provide a project ID: `/ai8080 continue <projectId>`",
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
            await client.resumeDesign(projectId);
            return {
              text: `✅ Design resumed for project ${projectId}. Agents will continue generating the remaining pages.`,
            };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `8080.ai error: ${msg}` };
          }
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
            let rawLog = "";
            let suggestedAgents: string[] = [];
            let lastMessageId = "";

            console.log("[8080.ai] Sending message and connecting to stream...");

            await client.streamSendMessage(projectId, content, (token) => {
              responseText += token;
            }, {
              model: activeModel,
              onRaw: (raw) => {
                rawLog += `data: ${raw}\n\n`;
              },
              onSuggestedAgents: (agents, msgId) => {
                suggestedAgents.push(...agents);
                lastMessageId = msgId;
              }
            });

            if (suggestedAgents.length > 0) {
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId,
                agents: suggestedAgents,
                messageId: lastMessageId
              });
            }

            const cleanText = stripA2UI(responseText);
            const streamDisplay = cleanText ? `\n\n**AI Response:**\n${cleanText}` : "";
            const rawDisplay = rawLog ? `\n\n---\n**Raw Network Stream:**\n\`\`\`text\n${rawLog.slice(0, 500)}${rawLog.length > 500 ? "..." : ""}\n\`\`\`` : "";
            const agentList = suggestedAgents.length > 0
              ? buildSuggestedAgentsText(suggestedAgents)
              : "";

            return {
              text: `🤖 **Stream connection established**\n${streamDisplay}${rawDisplay}${agentList}`,
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
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: suggestions.projectId,
                  agents: ["start_building"],
                  messageId: suggestions.messageId || "",
                });
                return {
                  text: `✅ **Generation complete!**\n${logsText}\n\nReview the design and architecture and start building.\n\nType \`/ai8080 select-button 1\` to start building.`,
                };
              } else {
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: suggestions.projectId,
                  agents: ["continue", "review"],
                  messageId: suggestions.messageId || "",
                });
                return {
                  text: `✅ **Agent execution finished, but no new designs were generated.**\n${logsText}\n\nType \`/ai8080 select-button 1\` to Continue again, or \`/ai8080 select-button 2\` to Review.`,
                };
              }
            }

            await client.triggerAgents(suggestions.projectId, [selectedAgent], suggestions.messageId, activeModel);

            const isPlanAll = selectedAgent === 'plan_all';

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
                agents: ["continue", "review"],
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

            const agentLabel = (AGENT_DISPLAY_NAMES[selectedAgent] ?? selectedAgent);

            // Fetch fresh suggestions from the project detail
            const projectStatusAfter = await client.getProjectStatus(suggestions.projectId);
            const pendingAgentsAfter = extractSuggestedAgents(projectStatusAfter.pending_suggested_agents);
            const finalAgentsAfter = [...pendingAgentsAfter];

            // Fallback: if no suggestions but project is active, offer review/continue
            if (finalAgentsAfter.length === 0 && projectStatusAfter.status === 'active') {
              finalAgentsAfter.push('review', 'continue');
            }

            // Save for next select-button call
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: suggestions.projectId,
              agents: finalAgentsAfter,
              messageId: ""
            });

            const agentList = finalAgentsAfter.length > 0
              ? buildSuggestedAgentsText(finalAgentsAfter)
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
