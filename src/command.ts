import open from "open";
import { writeToken, clearToken } from "./auth.ts";
import { AuthError, AGENT_DISPLAY_NAMES, type BuildStep, requireAuthenticatedClient, validateToken, filterStartBuildingAgents, refreshAccessToken, isReviewArchitectureStartBuildingChatMessage } from "./api-client.ts";
import { readActiveProject, writeActiveProject } from "./project-state.ts";
import {
  buildProjectSelectionJsonl,
  buildRequirementsUrl,
  buildReviewContinueJsonl,
  buildSuggestedAgentsJsonl,
  buildSuggestedAgentsPresentation,
  buildSuggestedAgentsText,
  parseButtonValue,
} from "./review-continue.ts";
import { writeLatestSuggestions, readLatestSuggestions } from "./suggestions-state.ts";
import { readActiveModel, writeActiveModel, MODEL_OPTIONS } from "./model-state.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { canShowStartBuildingTasks, canUseStartBuilding, detectSubscriptionTier, formatStartBuildingTasks, getUpgradeToBuildText } from "./task-summary.ts";
import { getDesignPreviewText } from "./design-preview.ts";
import { log } from "../logger.ts";

const HELP_TEXT = `8080.ai plugin commands:

  /ai8080 start <requirements>   Start a new project on 8080.ai
  /ai8080 login                  Log in to 8080.ai via browser
  /ai8080 set-token <token>      Manually set auth token (from browser console)
  /ai8080 set-tokens <auth> <refresh>
                                  Save refresh token for auto-renew
  /ai8080 credits                Show your remaining 8080.ai credits
  /ai8080 list                   List your projects
  /ai8080 select <number>        Select a project by its number from the list
  /ai8080 task-list              Show active project tasks grouped by status
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
  return extractPendingSuggestion(pending).agents;
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

type TaskRecord = Record<string, unknown>;

const TASK_STATUS_ORDER = [
  "backlog",
  "todo",
  "queued",
  "ai_in_progress",
  "human_in_progress",
  "blocked",
  "manual_review",
  "done",
  "cancelled",
  "invalid",
  "error",
];

function extractTaskArray(data: unknown): TaskRecord[] {
  if (Array.isArray(data)) return data.filter((item): item is TaskRecord => Boolean(item) && typeof item === "object");
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.tasks)) return extractTaskArray(record.tasks);
    if (Array.isArray(record.data)) return extractTaskArray(record.data);
  }
  return [];
}

function taskString(task: TaskRecord, key: string): string | undefined {
  const value = task[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function taskNumber(task: TaskRecord, key: string): number | undefined {
  const value = task[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTaskStatus(status: string): string {
  const normalized = status.replace(/_/g, " ");
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTaskDescription(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `   ${line.trim()}`)
    .join("\n");
}

export function formatTaskList(projectId: string, rawTasks: unknown): { text: string; statusCounts: Record<string, number>; totalTasks: number } {
  const tasks = extractTaskArray(rawTasks);
  const grouped = new Map<string, TaskRecord[]>();

  for (const task of tasks) {
    const status = taskString(task, "status") ?? "unknown";
    const normalizedStatus = status.toLowerCase();
    const bucket = grouped.get(normalizedStatus) ?? [];
    bucket.push(task);
    grouped.set(normalizedStatus, bucket);
  }

  const statusOrder = [
    ...TASK_STATUS_ORDER.filter((status) => grouped.has(status)),
    ...[...grouped.keys()].filter((status) => !TASK_STATUS_ORDER.includes(status)).sort(),
  ];

  const statusCounts: Record<string, number> = {};
  for (const [status, statusTasks] of grouped.entries()) {
    statusCounts[status] = statusTasks.length;
  }

  if (tasks.length === 0) {
    return {
      text: `### Task List\n\nProject: \`${projectId}\`\n\nNo tasks found for this project.`,
      statusCounts,
      totalTasks: 0,
    };
  }

  const sections = statusOrder.map((status) => {
    const statusTasks = grouped.get(status) ?? [];
    const lines = statusTasks.map((task, index) => {
      const taskNo = taskNumber(task, "task_number") ?? index + 1;
      const title = taskString(task, "title") ?? `Task ${taskNo}`;
      const role = taskString(task, "role");
      const priority = taskString(task, "priority");
      const effort = taskNumber(task, "effort_days");
      const description = taskString(task, "description");

      const meta = [
        role ? `Role: ${role}` : undefined,
        priority ? `Priority: ${priority}` : undefined,
        effort !== undefined ? `Effort: ${effort}d` : undefined,
      ].filter(Boolean).join(" | ");

      return [
        `${index + 1}. #${taskNo} ${title}`,
        meta ? `   ${meta}` : undefined,
        description ? formatTaskDescription(description) : undefined,
      ].filter(Boolean).join("\n");
    });

    return `#### ${formatTaskStatus(status)} (${statusTasks.length})\n\n${lines.join("\n\n")}`;
  });

  return {
    text:
      `### Task List\n\n` +
      `Project: \`${projectId}\`\n` +
      `Total tasks: ${tasks.length}\n\n` +
      sections.join("\n\n"),
    statusCounts,
    totalTasks: tasks.length,
  };
}

export function create8080Command(
  api: {
    runtime: { state: { resolveStateDir(): string } };
  },
  urls: { siteUrl: string; apiBaseUrl: string; sessionId?: string }
) {
  const { siteUrl, apiBaseUrl } = urls;
  const sessionId = urls.sessionId ?? generateSessionId();

  return {
    name: "ai8080",
    description: "Interact with the 8080.ai platform",
    acceptsArgs: true,

    async handler(ctx: { args?: string }) {
      const stateDir = api.runtime.state.resolveStateDir();
      log.info("command handler received", { args: ctx.args, sessionId });
      const tokens = (ctx.args ?? "").trim().split(/\s+/).filter(Boolean);
      let subcommand = tokens[0]?.toLowerCase();
      let rest = tokens.slice(1);

      // Handle multi-word subcommands to be lenient with syntax
      if (subcommand === "set" && rest[0]?.toLowerCase() === "token") {
        subcommand = "set-token";
        rest = rest.slice(1);
      } else if (subcommand === "set" && rest[0]?.toLowerCase() === "tokens") {
        subcommand = "set-tokens";
        rest = rest.slice(1);
      } else if (subcommand === "select" && rest[0]?.toLowerCase() === "button") {
        subcommand = "select-button";
        rest = rest.slice(1);
      } else if (subcommand === "task" && rest[0]?.toLowerCase() === "list") {
        subcommand = "task-list";
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
            let suggestionMessageId = "";

            log.info("Initializing project and connecting to stream.");

            // Call chat/messages API to create project and stream initial thoughts
            const result = await client.streamProjectCreation(
              requirements,
              (token) => {
                responseText += token;
              },
              undefined,
              (agents, _pid, messageId) => {
                suggestedAgents.push(...agents);
                if (messageId) suggestionMessageId = messageId;
              },
              { model: activeModel }
            );

            const projectId = result.projectId;

            // Store project_id in session state
            await writeActiveProject(stateDir, projectId, sessionId);

            if (suggestedAgents.length === 0 || !suggestionMessageId) {
              try {
                const status = await client.getProjectStatus(projectId);
                const pending = extractPendingSuggestion(status.pending_suggested_agents);
                if (suggestedAgents.length === 0) suggestedAgents.push(...pending.agents);
                if (pending.messageId) suggestionMessageId = pending.messageId;
              } catch (statusErr) {
                log.info("Failed to fetch project status for command suggestions", statusErr);
              }
            }

            if (suggestedAgents.length > 0) {
              suggestedAgents = filterStartBuildingAgents(suggestedAgents, false);
            }

            const groupedAgents = groupAgents(suggestedAgents);
            if (suggestedAgents.length > 0) {
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId,
                agents: groupedAgents,
                messageId: suggestionMessageId,
              });
            }

            const cleanText = stripA2UI(responseText);
            const streamDisplay = cleanText ? `\n\n**Tech Lead:**\n${cleanText}` : "";
            const agentList = groupedAgents.length > 0
              ? buildSuggestedAgentsText(projectId, groupedAgents, cleanText)
              : "";
            const presentation = groupedAgents.length > 0
              ? buildSuggestedAgentsPresentation(projectId, groupedAgents, cleanText)
              : undefined;

            return {
              text:
                `✅ **Stream connection established**\n` +
                `🚀 Project created on 8080.ai!${streamDisplay}\n\n` +
                `**Project ID:** ${projectId}\n\n` +
                `The project has been set as active for this session. ${agentList}`,
              presentation,
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
              `  4. Optional auto-renew: localStorage.getItem('refresh_token')\n` +
              `  5. Run this command in OpenClaw:\n\n` +
              `     /ai8080 set-token <your_token>\n\n` +
              `     Or, for auto-renew:\n\n` +
              `     /ai8080 set-tokens <your_auth_token> <your_refresh_token>\n\n` +
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
        case "set-tokens": {
          const [rawAuthToken, rawRefreshToken] = rest;
          const token = rawAuthToken?.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
          const refreshToken = rawRefreshToken?.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");

          if (!token || !refreshToken) {
            return {
              text:
                "Usage: /ai8080 set-tokens <auth_token> <refresh_token>\n\n" +
                "Get them from the browser console:\n" +
                "  localStorage.getItem('auth_token')\n" +
                "  localStorage.getItem('refresh_token')",
            };
          }

          try {
            await validateToken({ token, apiBaseUrl });
            const validToken = await refreshAccessToken({ apiBaseUrl, refreshToken });
            const isValid = await validateToken({ token: validToken, apiBaseUrl });
            if (!isValid) {
              return { text: "❌ Invalid auth token and refresh token. Please check both tokens and try again." };
            }

            await writeToken(stateDir, validToken, { refreshToken });
            return { text: "✅ Auth token and refresh token validated and saved. OpenClaw can now refresh your 8080.ai session automatically." };
          } catch (err) {
            return { text: `❌ Failed to validate tokens: ${err instanceof Error ? err.message : String(err)}` };
          }
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
        case "task-list": {
          const requestedProjectId = rest[0]?.trim();
          const activeProjectId = requestedProjectId || await readActiveProject(stateDir, sessionId);
          log.info("task_list command entered", {
            requestedProjectId,
            activeProjectId,
            sessionId,
          });

          if (!activeProjectId) {
            log.info("task_list no active project", { sessionId });
            return {
              text:
                "No active project found. Run `/ai8080 list`, then `/ai8080 select <number>` first.\n\n" +
                "You can also run `/ai8080 task-list <project_id>`.",
            };
          }

          try {
            const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
            log.info("task_list api request", {
              projectId: activeProjectId,
              path: `/projects/${activeProjectId}/tasks`,
            });
            const tasksResponse = await client.getTasks(activeProjectId);
            const formatted = formatTaskList(activeProjectId, tasksResponse);
            log.info("task_list grouped response", {
              projectId: activeProjectId,
              totalTasks: formatted.totalTasks,
              statusCounts: formatted.statusCounts,
            });

            return { text: formatted.text };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            log.info("task_list command error", {
              projectId: activeProjectId,
              error: msg,
            });
            return { text: `8080.ai error fetching task list: ${msg}` };
          }
        }

        // ------------------------------------------------------------------
        case "list": {
          try {
            const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
            const projects = await client.listProjects();
            if (projects.length === 0) return { text: "No projects found." };

            const activeProjectId = await readActiveProject(stateDir, sessionId);

            const lines = projects.map((p, i) => {
              const isActive = p.id === activeProjectId;
              const marker = isActive ? "👉" : "  ";
              const activeLabel = isActive ? " active in this session" : "";
              return `${marker} ${i + 1}. ${p.title} (\`${p.id}\`) [${p.status}]${activeLabel}`;
            });
            log.info("command list full project list prepared", {
              count: projects.length,
              activeProjectId,
              firstProjectId: projects[0]?.id,
              firstProjectTitle: projects[0]?.title,
            });

            // Update project labels to include active marker in the button UI too.
            const projectsWithActiveMarker = projects.map((p, i) => {
              const isActive = p.id === activeProjectId;
              const marker = isActive ? "👉 " : "";
              return { ...p, title: `${marker}${p.title}` };
            });

            const a2ui = buildProjectSelectionJsonl(projectsWithActiveMarker);

            return {
              text:
                `### 8080.ai Projects\n\n${lines.join("\n")}\n\n<!-- a2ui ${a2ui} -->\n\n` +
                `Run \`/ai8080 select <number>\` to make a project active for this OpenClaw session.\n\n` +
                `Example: \`/ai8080 select 1\`\n\n` +
                `After selecting, you can continue chatting with that active project using \`/ai8080 message <text>\`.`,
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

          try {
            const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
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
            const defaultAgents = ["start_building"];
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: selected.id,
              agents: defaultAgents,
              messageId: "",
            });
            log.info("select project default start_building suggestion written", {
              projectId: selected.id,
              source: "command_select",
              sessionId,
              agents: defaultAgents,
            });
            const presentation = buildSuggestedAgentsPresentation(selected.id, defaultAgents);
            return {
              text:
                `✅ Project \`${selected.title}\` is now active for this OpenClaw session. (${selected.id})\n\n` +
                `### Suggested Next Steps:\n` +
                `1. 🛠️ Start Building\n\n` +
                `Type \`/ai8080 select-button 1\` or \`Start Building\` to proceed.`,
              presentation,
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

          try {
            const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
            const activeModel = await readActiveModel(stateDir);
            let responseText = "";
            let suggestedAgents: string[] = [];
            let lastMessageId = "";

            log.info("Sending message and connecting to stream.");

            await client.streamSendMessage(projectId, content, (token) => {
              responseText += token;
            }, {
              model: activeModel,
              onSuggestedAgents: (agents, msgId) => {
                suggestedAgents.push(...agents);
                lastMessageId = msgId;
              }
            });

            if (suggestedAgents.length > 0) {
              suggestedAgents = filterStartBuildingAgents(suggestedAgents, false);
            }

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
              ? buildSuggestedAgentsText(projectId, groupedAgents, cleanText)
              : "";

            const presentation = groupedAgents.length > 0
              ? buildSuggestedAgentsPresentation(projectId, groupedAgents, cleanText)
              : undefined;
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
          log.info("select-button latest suggestions", {
            choice,
            sessionId,
            suggestions,
          });
          if (!suggestions || suggestions.agents.length === 0) {
            return { text: "No suggested agents found to select from." };
          }

          const normalizedChoice = choice.toLowerCase().replace(/[\s_-]+/g, "_");
          const num = parseInt(choice, 10);
          let selectedAgent: string | undefined;
          if (!isNaN(num)) {
            if (num < 1 || num > suggestions.agents.length) {
              return { text: `⚠️  "${choice}" is not valid. Pick a number between 1 and ${suggestions.agents.length}.` };
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
            if (!selectedAgent) {
              return { text: `⚠️  "${choice}" is not valid. Pick a number between 1 and ${suggestions.agents.length}, or use an option name like \`start-building\`.` };
            }
          }

          log.info("select-button resolved selection", {
            choice,
            selectedAgent,
            suggestions: suggestions.agents,
          });

          try {
            const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
            const activeModel = await readActiveModel(stateDir);

            if (selectedAgent === 'review') {
              const status = await client.getProjectStatus(suggestions.projectId).catch(() => null);
              const pending = extractPendingSuggestion(status?.pending_suggested_agents);
              const projectUrl = status?.requirementDocUrl || buildRequirementsUrl(siteUrl, suggestions.projectId, pending.sessionId);
              log.info("select-button review url", {
                projectId: suggestions.projectId,
                reviewUrl: projectUrl,
                sessionId: pending.sessionId,
              });
              return {
                text: projectUrl,
              };
            }

            if (selectedAgent === 'start_building') {
              const [tasksForBuild, archForBuild] = await Promise.all([
                client.getTasks(suggestions.projectId).catch(() => null),
                client.getArchitecture(suggestions.projectId).catch(() => null),
              ]);
              const canStartBuilding = hasGeneratedData(tasksForBuild) && hasGeneratedData(archForBuild);
              log.info("start_building selected readiness decision", {
                projectId: suggestions.projectId,
                hasTasks: hasGeneratedData(tasksForBuild),
                hasArchitecture: hasGeneratedData(archForBuild),
                canStartBuilding,
              });
              if (!canStartBuilding) {
                return {
                  text: "Start Building is not available yet. Architecture and tasks must be generated first.",
                };
              }
              const [subscription, plans, profile] = await Promise.all([
                client.getSubscription().catch(() => null),
                client.getSubscriptionPlans().catch(() => []),
                client.getProfile().catch(() => null),
              ]);
              const subscriptionTier = detectSubscriptionTier(subscription, profile, plans);
              const canBuildForPlan = canUseStartBuilding(subscriptionTier);
              log.info("start_building selected plan decision", {
                projectId: suggestions.projectId,
                subscriptionTier,
                canBuildForPlan,
                plansCount: plans.length,
              });
              if (!canBuildForPlan) {
                return {
                  text: getUpgradeToBuildText(siteUrl),
                };
              }
              let taskSummaryText = "";
              if (canShowStartBuildingTasks(subscriptionTier)) {
                taskSummaryText = formatStartBuildingTasks(tasksForBuild, suggestions.projectId, siteUrl);
                log.info("start_building task list 1 in command", {
                  projectId: suggestions.projectId,
                  tier: subscriptionTier,
                  tasks: tasksForBuild,
                  taskSummaryText,
                  shown: Boolean(taskSummaryText),
                });
              } else {
                log.info("start_building task list 2 in command ", {
                  projectId: suggestions.projectId,
                  tier: subscriptionTier,
                  shown: false,
                  reason: "plan_not_allowed",
                });
              }
              log.info("start_building selected build api about to call", {
                projectId: suggestions.projectId,
                activeModel,
              });
              await client.startBuilding(suggestions.projectId, activeModel);
              const designPreviewText = await getDesignPreviewText(client, suggestions.projectId, siteUrl);
              log.info("start_building selected build api completed", {
                projectId: suggestions.projectId,
                activeModel,
                taskSummaryShown: Boolean(taskSummaryText),
              });
              return {
                text:
                  `✅ **Building Started!** Agents are now writing your software.` +
                  (taskSummaryText ? `\n\n${taskSummaryText}` : "") +
                  designPreviewText,
              };
            }

            if (selectedAgent === 'continue') {
              try {
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: suggestions.projectId,
                  agents: [],
                  messageId: suggestions.messageId || "",
                });
                log.info("select-button consuming continue suggestion", {
                  projectId: suggestions.projectId,
                  messageId: suggestions.messageId || "",
                });
                await client.resumeDesign(suggestions.projectId);
              } catch (err) {
                if (err instanceof AuthError) {
                  const reviewAgents = groupAgents(["continue", "review"]);
                  await writeLatestSuggestions(stateDir, sessionId, {
                    projectId: suggestions.projectId,
                    agents: reviewAgents,
                    messageId: suggestions.messageId || "",
                  });
                  return {
                    text:
                      `${err.message}\n\n` +
                      `Your project checkpoint is still saved. After logging in, run \`/ai8080 select-button 1\` to continue or \`/ai8080 select-button 2\` to review.`,
                    presentation: buildSuggestedAgentsPresentation(suggestions.projectId, reviewAgents),
                  };
                }
                throw err;
              }

              let pausedForReview = false;
              const logs: string[] = [];
              let lastProjectEvent: Record<string, unknown> | null = null;

              // Await stream so we can monitor generation
              await client.streamProjectEvents(suggestions.projectId, {
                onRaw: (raw) => {
                  try {
                    lastProjectEvent = JSON.parse(raw) as Record<string, unknown>;
                  } catch { }
                },
                onAgentLog: (log) => {
                  logs.push(`[${log.agent_type}] ${log.summary}`);
                },
                onChatMessage: (msg) => {
                  logs.push(`[System] ${msg.content}`);
                },
                onPlanningComplete: (data) => {
                  if (data.status === "paused_for_review") {
                    pausedForReview = true;
                  }
                },
                idleTimeoutMs: 60_000,
                progressTimeoutMs: 45_000,
                maxTimeoutMs: 180_000,
              });
              const eventEndedWithStartBuildingMessage = isReviewArchitectureStartBuildingChatMessage(lastProjectEvent);
              log.info("command_continue /events final event decision", {
                projectId: suggestions.projectId,
                lastEventType: lastProjectEvent?.type,
                lastEventContent: typeof lastProjectEvent?.content === "string"
                  ? lastProjectEvent.content.slice(0, 240)
                  : undefined,
                eventEndedWithStartBuildingMessage,
              });

              // Check if any of the three endpoints generated data
              log.info("start_building condition-check 1 in command", {
                projectId: suggestions.projectId,
                source: "command_continue",
                step: "fetch_outputs_start",
              });
              const [designPages, tasks, arch] = await Promise.all([
                client.getDesignPages(suggestions.projectId).catch(() => null),
                client.getTasks(suggestions.projectId).catch(() => null),
                client.getArchitecture(suggestions.projectId).catch(() => null),
              ]);

              const isGenerated = hasGeneratedData(designPages) || hasGeneratedData(tasks) || hasGeneratedData(arch);
              const hasTasks = hasGeneratedData(tasks);
              const hasArchitecture = hasGeneratedData(arch);
              const hasDesignPages = hasGeneratedData(designPages);
              log.info("start_building condition-check 2 in command", {
                projectId: suggestions.projectId,
                source: "command_continue",
                step: "fetch_outputs_done",
                hasDesignPages,
                hasTasks,
                hasArchitecture,
                isGenerated,
              });
              const logsText = "";

              if (pausedForReview) {
                log.info("start_building readiness decision 1 in command", {
                  projectId: suggestions.projectId,
                  source: "command_continue",
                  skipped: true,
                  reason: "paused_for_review",
                });
                const statusAfterPause = await client.getProjectStatus(suggestions.projectId).catch(() => null);
                const pendingAfterPause = extractPendingSuggestion(statusAfterPause?.pending_suggested_agents);
                const backendReviewAgents = groupAgents(
                  pendingAfterPause.agents.filter((agent) => agent === "continue" || agent === "review")
                );
                const hasBackendContinue = backendReviewAgents.includes("continue");
                const hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(suggestions.projectId);
                const reviewAgents = hasBackendContinue ? backendReviewAgents : groupAgents(["continue", "review"]);
                log.info("command_continue paused_for_review backend suggestion gate", {
                  projectId: suggestions.projectId,
                  pendingSuggestions: pendingAfterPause.agents,
                  filteredSuggestions: backendReviewAgents,
                  hasBackendContinue,
                  hasLatestCompletedAgentLog,
                });
                if (!hasLatestCompletedAgentLog) {
                  await writeLatestSuggestions(stateDir, sessionId, {
                    projectId: suggestions.projectId,
                    agents: [],
                    messageId: pendingAfterPause.messageId || suggestions.messageId || "",
                  });
                  return {
                    text: "",
                  };
                }
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: suggestions.projectId,
                  agents: reviewAgents,
                  messageId: pendingAfterPause.messageId || suggestions.messageId || "",
                });

                return {
                  text:
                    buildSuggestedAgentsText(suggestions.projectId, reviewAgents),
                  presentation: buildSuggestedAgentsPresentation(suggestions.projectId, reviewAgents),
                };
              }

              log.info("start_building readiness decision 2 in command", {
                projectId: suggestions.projectId,
                source: "command_continue",
                hasTasks,
                hasArchitecture,
                willShowDesignComplete: hasTasks && hasArchitecture,
              });

              if (hasTasks && hasArchitecture) {
                // Create a public design share link
                let shareUrl = "";
                const [subscription, plans, profile] = await Promise.all([
                  client.getSubscription().catch(() => null),
                  client.getSubscriptionPlans().catch(() => []),
                  client.getProfile().catch(() => null),
                ]);
                const subscriptionTier = detectSubscriptionTier(subscription, profile, plans);
                const canBuildForPlan = canUseStartBuilding(subscriptionTier);
                log.info("start_building show plan decision", {
                  projectId: suggestions.projectId,
                  subscriptionTier,
                  canBuildForPlan,
                  plansCount: plans.length,
                });
                const hasCompletedAgentLog = canBuildForPlan
                  ? await client.hasLatestCompletedAgentLog(suggestions.projectId)
                  : false;
                const canShowStartBuilding = canBuildForPlan && hasCompletedAgentLog && eventEndedWithStartBuildingMessage;
                const statusAfterReadiness = await client.getProjectStatus(suggestions.projectId).catch(() => null);
                const pendingAfterReadiness = extractPendingSuggestion(statusAfterReadiness?.pending_suggested_agents);
                const backendResumeSuggestions = pendingAfterReadiness.agents.filter((agent) =>
                  agent === "continue" || agent === "review"
                );
                const hasBackendContinue = backendResumeSuggestions.includes("continue");
                log.info("agent_logs continue override decision", {
                  projectId: suggestions.projectId,
                  source: "command_continue",
                  hasCompletedAgentLog,
                  eventEndedWithStartBuildingMessage,
                  backendResumeSuggestions,
                  hasBackendContinue,
                  hasTasks,
                  hasArchitecture,
                  canBuildForPlan,
                  willShowStartBuilding: canShowStartBuilding,
                  reason: canShowStartBuilding
                    ? "tasks_architecture_completed_agent_log_and_events_review_message_ready"
                    : !eventEndedWithStartBuildingMessage
                      ? "waiting_for_events_review_start_building_message"
                      : "waiting_for_completed_agent_log_before_start_building",
                });
                const nextAgents = canShowStartBuilding
                  ? ["start_building"]
                  : canBuildForPlan && hasBackendContinue
                    ? backendResumeSuggestions
                    : [];
                const startBuildingAgents = groupAgents(nextAgents);
                log.info("suggestions final decision before write", {
                  projectId: suggestions.projectId,
                  source: "command_continue",
                  suggestions: startBuildingAgents,
                  writeSuggestions: startBuildingAgents.length > 0,
                  hasCompletedAgentLog,
                  eventEndedWithStartBuildingMessage,
                  backendResumeSuggestions,
                  hasBackendContinue,
                  hasTasks,
                  hasArchitecture,
                  subscriptionTier,
                  canBuildForPlan,
                });
                if (startBuildingAgents.length > 0) {
                  log.info("post-generation suggestions updated", {
                    projectId: suggestions.projectId,
                    source: "command_continue",
                    reason: canShowStartBuilding
                      ? "resume_completed_with_architecture_tasks_completed_agent_log_and_events_review_message"
                      : eventEndedWithStartBuildingMessage
                        ? "waiting_for_completed_agent_log_continue_retry"
                        : "waiting_for_events_review_start_building_message",
                  });
                  await writeLatestSuggestions(stateDir, sessionId, {
                    projectId: suggestions.projectId,
                    agents: startBuildingAgents,
                    messageId: suggestions.messageId || "",
                  });
                }
                const buildActionText = canShowStartBuilding
                  ? buildSuggestedAgentsText(suggestions.projectId, startBuildingAgents)
                  : canBuildForPlan
                    ? eventEndedWithStartBuildingMessage
                      ? `8080.ai is still finishing the latest agent step. I will show Continue only after 8080.ai exposes it.${startBuildingAgents.length > 0 ? `\n\n${buildSuggestedAgentsText(suggestions.projectId, startBuildingAgents)}` : ""}`
                      : `8080.ai has not emitted the final /events review/start-building message yet. I will show Continue only after 8080.ai exposes it.${startBuildingAgents.length > 0 ? `\n\n${buildSuggestedAgentsText(suggestions.projectId, startBuildingAgents)}` : ""}`
                    : getUpgradeToBuildText(siteUrl);
                try {
                  const share = await client.createDesignShare(suggestions.projectId);
                  // Build the public share URL, prioritizing the design-specific format with share_id
                  if (share && (share.share_id || share.id)) {
                    shareUrl = `${siteUrl}/design/${suggestions.projectId}/${share.share_id || share.id}`;
                  } else {
                    shareUrl = share.share_url || `${siteUrl}/projects/${suggestions.projectId}`;
                  }
                } catch (shareErr) {
                  log.info("Failed to create design share", shareErr);
                  shareUrl = `${siteUrl}/projects/${suggestions.projectId}`;
                }

                return {
                  text:
                    `✅ **Design generation complete!**\n${logsText}\n\n` +
                    `🔗 **Your Design Share Link:**\n${shareUrl}\n\n` +
                    `Share this link with anyone to preview the generated design, architecture, and requirements.\n\n` +
                    buildActionText +
                    `Type \`/ai8080 list\` to see your projects anytime.`,
                  presentation: startBuildingAgents.length > 0
                    ? buildSuggestedAgentsPresentation(suggestions.projectId, startBuildingAgents)
                    : undefined,
                };
              } else {
                const statusAfterNoOutputs = await client.getProjectStatus(suggestions.projectId).catch(() => null);
                const pendingAfterNoOutputs = extractPendingSuggestion(statusAfterNoOutputs?.pending_suggested_agents);
                const backendContinueAgents = groupAgents(
                  pendingAfterNoOutputs.agents.filter((agent) => agent === "continue" || agent === "review")
                );
                const hasBackendContinue = backendContinueAgents.includes("continue");
                const hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(suggestions.projectId);
                const continueAgents = hasBackendContinue ? backendContinueAgents : groupAgents(["continue", "review"]);
                log.info("command_continue backend suggestion gate no outputs", {
                  projectId: suggestions.projectId,
                  pendingSuggestions: pendingAfterNoOutputs.agents,
                  filteredSuggestions: backendContinueAgents,
                  hasBackendContinue,
                  hasLatestCompletedAgentLog,
                });
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: suggestions.projectId,
                  agents: hasLatestCompletedAgentLog ? continueAgents : [],
                  messageId: pendingAfterNoOutputs.messageId || suggestions.messageId || "",
                });
                if (!hasLatestCompletedAgentLog) {
                  return {
                    text: "",
                  };
                }
                return {
                  text:
                    `✅ **Checkpoint reached.**\n${logsText}\n\n` +
                    buildSuggestedAgentsText(suggestions.projectId, continueAgents),
                  presentation: buildSuggestedAgentsPresentation(suggestions.projectId, continueAgents),
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
              idleTimeoutMs: 60_000,
              progressTimeoutMs: 45_000,
              maxTimeoutMs: 180_000,
            });

            if (pausedForReview) {
              const logsText = "";
              const srdText = "";
              const statusAfterPause = await client.getProjectStatus(suggestions.projectId).catch(() => null);
              const pendingAfterPause = extractPendingSuggestion(statusAfterPause?.pending_suggested_agents);
              const backendReviewAgents = groupAgents(
                pendingAfterPause.agents.filter((agent) => agent === "continue" || agent === "review")
              );
              const hasBackendContinue = backendReviewAgents.includes("continue");
              const hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(suggestions.projectId);
              const reviewAgents = hasBackendContinue ? backendReviewAgents : groupAgents(["continue", "review"]);
              log.info("command trigger paused_for_review backend suggestion gate", {
                projectId: suggestions.projectId,
                pendingSuggestions: pendingAfterPause.agents,
                filteredSuggestions: backendReviewAgents,
                hasBackendContinue,
                hasLatestCompletedAgentLog,
              });
              if (!hasLatestCompletedAgentLog) {
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: suggestions.projectId,
                  agents: [],
                  messageId: pendingAfterPause.messageId || suggestions.messageId || "",
                });
                return {
                  text: "",
                };
              }
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId: suggestions.projectId,
                agents: reviewAgents,
                messageId: pendingAfterPause.messageId || suggestions.messageId || "",
              });

              return {
                text:
                  buildSuggestedAgentsText(suggestions.projectId, reviewAgents),
                presentation: buildSuggestedAgentsPresentation(suggestions.projectId, reviewAgents),
              };
            }

            const logsText = "";
            const srdText = "";

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
            const pendingSuggestionAfter = extractPendingSuggestion(projectStatusAfter.pending_suggested_agents);
            const pendingAgentsAfter = pendingSuggestionAfter.agents;
            let finalAgentsAfter = [...pendingAgentsAfter];

            log.info("command trigger backend suggested agents after events", {
              projectId: suggestions.projectId,
              pendingAgents: finalAgentsAfter,
              reason: finalAgentsAfter.includes("continue")
                ? "backend_exposed_continue"
                : "backend_has_not_exposed_continue",
            });

            if (finalAgentsAfter.length > 0) {
              log.info("start_building suggestions decision", {
                projectId: suggestions.projectId,
                pending: finalAgentsAfter,
                allowStartBuilding: false,
              });
              finalAgentsAfter = filterStartBuildingAgents(finalAgentsAfter, false);
            }

            const groupedAgentsAfter = groupAgents(finalAgentsAfter);
            // Save for next select-button call
            await writeLatestSuggestions(stateDir, sessionId, {
              projectId: suggestions.projectId,
              agents: groupedAgentsAfter,
              messageId: pendingSuggestionAfter.messageId || suggestions.messageId || ""
            });

            const agentList = groupedAgentsAfter.length > 0
              ? buildSuggestedAgentsText(suggestions.projectId, groupedAgentsAfter)
              : "";

            return {
              text:
                `✅ **${agentLabel}** run completed (using **${activeModel}**).` +
                `${logsText}${srdText}\n\n${agentList}`,
              presentation: groupedAgentsAfter.length > 0
                ? buildSuggestedAgentsPresentation(suggestions.projectId, groupedAgentsAfter)
                : undefined,
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
