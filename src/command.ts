import { cleanApiKey, validateApiKey, writeApiKey } from "./api-key.ts";
import { AuthError, AGENT_DISPLAY_NAMES, type BuildStep, requireAuthenticatedClient, filterStartBuildingAgents, isReviewArchitectureStartBuildingChatMessage, isPauseForReviewText, determineContinueButtonLabel } from "./api-client.ts";
import { readActiveProject, writeActiveProject } from "./project-state.ts";
import {
  buildProjectSelectionJsonl,
  buildRequirementsUrl,
  buildReviewContinueJsonl,
  buildSuggestedAgentChoices,
  buildSuggestedAgentsJsonl,
  buildSuggestedAgentsPresentation,
  buildSuggestedAgentsText,
  parseButtonValue,
} from "./review-continue.ts";
import { consumeAutoRunSuggestion, writeLatestSuggestions, readLatestSuggestions } from "./suggestions-state.ts";
import { readActiveModel } from "./model-state.ts";
import { extractPendingSuggestion } from "./suggested-agents.ts";
import { formatProjectTasks, formatStartBuildingTasks } from "./task-summary.ts";
import { getInsufficientCreditsMessageFromError, precheckStartBuildingCredits } from "./start-building-credits.ts";
import { getDesignPreviewText } from "./design-preview.ts";
import { log } from "../logger.ts";
import { buildProjectActivationResult } from "./project-activation.ts";
import { buildTasksUnavailableMessage, getBuildTasksReadiness } from "./build-readiness.ts";

function normalizeChoiceText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

const HELP_TEXT = `8080.ai plugin commands:

  /ai8080 start <requirements>   Start a new project on 8080.ai
  /ai8080 login                  Open 8080.ai and show API-key setup steps
  /ai8080 set api-key <api-key>  Validate and save an 8080.ai API key
  /ai8080 credits                Show your remaining 8080.ai credits
  /ai8080 list                   List your projects
  /ai8080 select <number>        Select a project by its number from the list
  /ai8080 task-list              Show active project tasks grouped by status
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

// Kept as a compatibility export for callers that imported the formatter from
// command.ts before task rendering was shared with Tech Lead responses.
export const formatTaskList = formatProjectTasks;

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
      if (subcommand === "set" && rest[0]?.toLowerCase() === "api-key") {
        subcommand = "set-api-key";
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

            let pendingButtons: any[] | undefined = undefined;
            if (suggestedAgents.length === 0 || !suggestionMessageId) {
              try {
                const status = await client.getProjectStatus(projectId);
                const pending = extractPendingSuggestion(status.pending_suggested_agents);
                if (suggestedAgents.length === 0) suggestedAgents.push(...pending.agents);
                if (pending.messageId) suggestionMessageId = pending.messageId;
                pendingButtons = pending.buttons;
              } catch (statusErr) {
                log.info("Failed to fetch project status for command suggestions", statusErr);
              }
            } else {
              try {
                const status = await client.getProjectStatus(projectId);
                const pending = extractPendingSuggestion(status.pending_suggested_agents);
                pendingButtons = pending.buttons;
              } catch {}
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
                buttons: pendingButtons,
              });
            }

            const continueButtonLabel = groupedAgents.includes("continue") ? await determineContinueButtonLabel(client, projectId) : undefined;
            const cleanText = stripA2UI(responseText);
            const streamDisplay = cleanText ? `\n\n**Tech Lead:**\n${cleanText}` : "";
            let taskListText = "";
            try {
              const tasksResponse = await client.getTasks(projectId);
              const formattedTasks = formatProjectTasks(projectId, tasksResponse);
              taskListText = `\n\n${formattedTasks.text}`;
              log.info("command start tasks attached to Tech Lead response", {
                projectId,
                totalTasks: formattedTasks.totalTasks,
                statusCounts: formattedTasks.statusCounts,
              });
            } catch (taskErr) {
              log.info("command start task fetch failed; returning Tech Lead response without tasks", {
                projectId,
                error: taskErr instanceof Error ? taskErr.message : String(taskErr),
              });
            }
            const agentList = groupedAgents.length > 0
              ? `\n\n${buildSuggestedAgentsText(projectId, groupedAgents, cleanText, continueButtonLabel, pendingButtons)}`
              : "";
            const presentation = groupedAgents.length > 0
              ? buildSuggestedAgentsPresentation(projectId, groupedAgents, cleanText, continueButtonLabel, pendingButtons)
              : undefined;

            return {
              text:
                `✅ **Stream connection established**\n` +
                `🚀 Project created on 8080.ai!${streamDisplay}${taskListText}\n\n` +
                `**Project ID:** ${projectId}\n\n` +
                `The project has been set as active for this session.${agentList}`,
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
          return {
            text:
              `🔗 **Generate an OpenClaw API Key**\n\n` +
              `1. Go to 8080.ai and sign in to your account: ${siteUrl}\n` +
              `2. Open your **Profile** page.\n` +
              `3. Navigate to **OpenClaw Secret Key Generation**.\n` +
              `4. Click **Generate Secret Key**.\n` +
              `5. Enter a name for the key (optional) and select an expiration period:\n` +
              `   - Never Expires\n` +
              `   - 15 Days\n` +
              `   - 30 Days\n` +
              `   - 90 Days\n` +
              `6. Click **Create Secret Key**.\n` +
              `7. Copy the generated secret key immediately. For security reasons, the key is displayed only once.\n` +
              `8. Click **Done**.\n` +
              `9. Save the key in OpenClaw by running this command, replacing \`<api-key>\` with the key you copied:\n\n` +
              `\`\`\`text\n` +
              `set api-key <api-key>\n` +
              `\`\`\`\n\n` +
              `I'll validate it locally and save it securely for future requests.`,
          };
        }

        // ------------------------------------------------------------------
        case "set-api-key": {
          log.info("command set-api-key entered", {
            argCount: rest.length,
            rawJoinedLength: rest.join("").length,
          });
          const apiKey = cleanApiKey(rest.join(""));
          if (!apiKey) {
            log.info("command set-api-key missing_api_key");
            return { text: "Usage: /ai8080 set api-key <api-key>" };
          }

          try {
            const meta = validateApiKey(apiKey);
            log.info("command set-api-key validated", {
              uid: meta.uid,
              issuedAt: meta.issuedAt,
              expiresAt: meta.expiresAt,
              keyLength: apiKey.length,
            });
            await writeApiKey(stateDir, apiKey, meta);
            return { text: "API key validated and saved. You are now connected to 8080.ai." };
          } catch (err) {
            log.info("command set-api-key failed", err);
            return { text: err instanceof Error ? err.message : String(err) };
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
            const activation = await buildProjectActivationResult({
              client,
              projectId: selected.id,
              projectTitle: selected.title,
              stateDir,
              openClawSessionId: sessionId,
            });
            return {
              text: activation.latestMessageText,
              presentation: activation.presentation,
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

            let pendingButtons: any[] | undefined = undefined;
            try {
              const status = await client.getProjectStatus(projectId);
              const pending = extractPendingSuggestion(status.pending_suggested_agents);
              if (suggestedAgents.length === 0) suggestedAgents = pending.agents;
              if (!lastMessageId) lastMessageId = pending.messageId;
              pendingButtons = pending.buttons;
            } catch {}

            if (suggestedAgents.length > 0) {
              suggestedAgents = filterStartBuildingAgents(suggestedAgents, false);
            }

            const groupedAgents = groupAgents(suggestedAgents);
            if (suggestedAgents.length > 0) {
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId,
                agents: groupedAgents,
                messageId: lastMessageId,
                buttons: pendingButtons,
              });
            }

            const continueButtonLabel = groupedAgents.includes("continue") ? await determineContinueButtonLabel(client, projectId) : undefined;
            const cleanText = stripA2UI(responseText);
            const streamDisplay = cleanText ? `\n\n**AI Response:**\n${cleanText}` : "";
            let taskListText = "";
            try {
              const tasksResponse = await client.getTasks(projectId);
              const formattedTasks = formatProjectTasks(projectId, tasksResponse);
              taskListText = `\n\n${formattedTasks.text}`;
              log.info("command message tasks attached to Tech Lead response", {
                projectId,
                totalTasks: formattedTasks.totalTasks,
                statusCounts: formattedTasks.statusCounts,
              });
            } catch (taskErr) {
              log.info("command message task fetch failed; returning Tech Lead response without tasks", {
                projectId,
                error: taskErr instanceof Error ? taskErr.message : String(taskErr),
              });
            }
            const agentList = groupedAgents.length > 0
              ? `\n\n${buildSuggestedAgentsText(projectId, groupedAgents, cleanText, continueButtonLabel, pendingButtons)}`
              : "";

            const presentation = groupedAgents.length > 0
              ? buildSuggestedAgentsPresentation(projectId, groupedAgents, cleanText, continueButtonLabel, pendingButtons)
              : undefined;
            const buttonsJsonl = groupedAgents.length > 0 ? `\n\n${buildSuggestedAgentsJsonl(projectId, groupedAgents, continueButtonLabel, pendingButtons)}` : "";

            return {
              text: `🤖 **Stream connection established**\n${streamDisplay}${taskListText}${agentList}${buttonsJsonl}`,
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

          const displayedChoices = buildSuggestedAgentChoices(
            suggestions.projectId,
            suggestions.agents,
            undefined,
            suggestions.buttons
          );
          const normalizedChoice = normalizeChoiceText(choice);
          const num = parseInt(choice, 10);
          let selectedAgent: string | undefined;
          let selectedValue: string | undefined;
          if (!isNaN(num)) {
            if (num < 1 || num > displayedChoices.length) {
              return { text: `⚠️  "${choice}" is not valid. Pick a number between 1 and ${displayedChoices.length}.` };
            }
            const selected = displayedChoices[num - 1];
            selectedAgent = selected?.agent;
            selectedValue = selected?.value;
          } else {
            const displayedChoice = displayedChoices.find((candidate) =>
              normalizeChoiceText(candidate.label) === normalizedChoice
            );
            selectedAgent = displayedChoice?.agent;
            selectedValue = displayedChoice?.value;

            selectedAgent ??= suggestions.agents.find((agent) => {
              const normalizedAgent = normalizeChoiceText(agent);
              return normalizedAgent === normalizedChoice;
            });
            if (!selectedAgent && normalizedChoice === "start_building") {
              selectedAgent = suggestions.agents.find((agent) => agent === "start_building" || agent === "start_build");
            }
            if (!selectedAgent) {
              selectedAgent = suggestions.agents.find((agent) => {
                const normalizedLabel = normalizeChoiceText(AGENT_DISPLAY_NAMES[agent] ?? agent);
                return normalizedLabel === normalizedChoice;
              });
            }
            if (!selectedAgent) {
              const parsedDisplayedChoice = selectedValue ? parseButtonValue(selectedValue) : null;
              if (parsedDisplayedChoice?.action !== "wait") {
                return { text: `⚠️  "${choice}" is not valid. Pick a number between 1 and ${displayedChoices.length}, or use an option name like \`wait\` or \`start-building\`.` };
              }
            }
          }

          log.info("select-button resolved selection", {
            choice,
            selectedAgent,
            selectedValue,
            suggestions: suggestions.agents,
          });

          try {
            const client = await requireAuthenticatedClient(stateDir, apiBaseUrl);
            const parsedSelection = selectedValue ? parseButtonValue(selectedValue) : null;

            if (parsedSelection?.action === "wait" && parsedSelection.entryId) {
              // Cancel first: an extra status request here would consume part
              // of the short auto-run countdown for no functional benefit.
              const result = await client.waitForAutoRun(parsedSelection.projectId, parsedSelection.entryId);
              await consumeAutoRunSuggestion(
                stateDir,
                sessionId,
                parsedSelection.projectId,
                parsedSelection.entryId
              );
              if (result.status === "cancelled") {
                const label = parsedSelection.label || "the action";
                return {
                  text:
                    `Automatic ${label} was cancelled. Choose ${label} when you are ready to trigger it manually.` +
                    `\n\n### Suggested Next Steps:\n1. ${label}`,
                };
              }
              return {
                text: "That automatic action is no longer scheduled; it may already be running or completed.",
              };
            }

            if (!selectedAgent) {
              return { text: `⚠️  "${choice}" is not a valid action.` };
            }

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

            if (selectedAgent === 'start_building' || selectedAgent === 'start_build') {
              const [tasksForBuild, buildReadiness] = await Promise.all([
                client.getTasks(suggestions.projectId).catch(() => null),
                getBuildTasksReadiness(client, suggestions.projectId, activeModel),
              ]);
              log.info("start_building selected readiness decision", {
                projectId: suggestions.projectId,
                canStartBuilding: buildReadiness.canStart,
                phaseId: buildReadiness.phaseId,
                blockingReason: buildReadiness.state.blocking_reason,
                runnableTaskCount: buildReadiness.state.runnable_tasks?.length ?? 0,
              });
              if (!buildReadiness.canStart) {
                return {
                  text: buildTasksUnavailableMessage(buildReadiness),
                };
              }
              const creditCheck = await precheckStartBuildingCredits(client, suggestions.projectId, tasksForBuild, activeModel, [], siteUrl);
              if (!creditCheck.allowed) {
                return {
                  text: creditCheck.message ?? "Add Credits",
                };
              }
              const taskSummaryText = formatStartBuildingTasks(tasksForBuild, suggestions.projectId, siteUrl);
              log.info("start_building task list in command", {
                projectId: suggestions.projectId,
                runnableTaskCount: creditCheck.runnableTaskCount,
                requiredCredits: creditCheck.requiredCredits,
                availableCredits: creditCheck.availableCredits,
                taskSummaryText,
                shown: Boolean(taskSummaryText),
              });
              log.info("start_building selected build api about to call", {
                projectId: suggestions.projectId,
                activeModel,
              });
              try {
                await client.startBuilding(suggestions.projectId, activeModel, buildReadiness.phaseId);
              } catch (err) {
                const insufficientCreditsText = getInsufficientCreditsMessageFromError(err, siteUrl);
                if (insufficientCreditsText) {
                  return { text: insufficientCreditsText };
                }
                throw err;
              }
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
                progressTimeoutMs: 180_000,
                maxTimeoutMs: 180_000,
              });
              // Check if any of the three endpoints generated data
              log.info("start_building condition-check 1 in command", {
                projectId: suggestions.projectId,
                source: "command_continue",
                step: "fetch_outputs_start",
              });
              const [designPages, tasks, arch, hasReviewBuildSystemMessage] = await Promise.all([
                client.getDesignPages(suggestions.projectId).catch(() => null),
                client.getTasks(suggestions.projectId).catch(() => null),
                client.getArchitecture(suggestions.projectId).catch(() => null),
                client.hasReviewBuildSystemMessage(suggestions.projectId).catch(() => false),
              ]);
              const eventEndedWithStartBuildingMessage =
                isReviewArchitectureStartBuildingChatMessage(lastProjectEvent) ||
                hasReviewBuildSystemMessage;
              log.info("command_continue review_build phase decision", {
                projectId: suggestions.projectId,
                lastEventType: lastProjectEvent?.type,
                lastEventContent: typeof lastProjectEvent?.content === "string"
                  ? lastProjectEvent.content.slice(0, 240)
                  : undefined,
                hasReviewBuildSystemMessage,
                eventEndedWithStartBuildingMessage,
              });

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

              const buildReadiness = await getBuildTasksReadiness(
                client,
                suggestions.projectId,
                activeModel,
                2
              ).catch((err) => {
                log.info("build tasks execution-state check failed", {
                  projectId: suggestions.projectId,
                  source: "command_continue",
                  error: err instanceof Error ? err.message : String(err),
                });
                return null;
              });

              if (buildReadiness?.canStart) {
                const statusForBuild = await client.getProjectStatus(suggestions.projectId).catch(() => null);
                const pendingForBuild = extractPendingSuggestion(statusForBuild?.pending_suggested_agents);
                const buildAgents = ["start_building", "review"];
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: suggestions.projectId,
                  agents: buildAgents,
                  messageId: pendingForBuild.messageId || suggestions.messageId || "",
                  buttons: pendingForBuild.buttons,
                });
                log.info("build tasks shown from authoritative execution state", {
                  projectId: suggestions.projectId,
                  source: "command_continue",
                  phaseId: buildReadiness.phaseId,
                  runnableTaskCount: buildReadiness.state.runnable_tasks?.length ?? 0,
                });
                return {
                  text: buildSuggestedAgentsText(
                    suggestions.projectId,
                    buildAgents,
                    "",
                    undefined,
                    pendingForBuild.buttons
                  ),
                  presentation: buildSuggestedAgentsPresentation(
                    suggestions.projectId,
                    buildAgents,
                    "",
                    undefined,
                    pendingForBuild.buttons
                  ),
                };
              }

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
                    buttons: pendingAfterPause.buttons,
                  });
                  return {
                    text: "",
                  };
                }
                await writeLatestSuggestions(stateDir, sessionId, {
                  projectId: suggestions.projectId,
                  agents: reviewAgents,
                  messageId: pendingAfterPause.messageId || suggestions.messageId || "",
                  buttons: pendingAfterPause.buttons,
                });

                const continueButtonLabel = reviewAgents.includes("continue") ? await determineContinueButtonLabel(client, suggestions.projectId) : undefined;
                return {
                  text:
                    buildSuggestedAgentsText(suggestions.projectId, reviewAgents, "", continueButtonLabel, pendingAfterPause.buttons),
                  presentation: buildSuggestedAgentsPresentation(suggestions.projectId, reviewAgents, "", continueButtonLabel, pendingAfterPause.buttons),
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
                const canBuildForPlan = true;
                log.info("start_building show decision", {
                  projectId: suggestions.projectId,
                  canBuildForPlan,
                });
                const canShowStartBuilding = buildReadiness?.canStart === true;
                const statusAfterReadiness = await client.getProjectStatus(suggestions.projectId).catch(() => null);
                const pendingAfterReadiness = extractPendingSuggestion(statusAfterReadiness?.pending_suggested_agents);
                const backendResumeSuggestions = pendingAfterReadiness.agents.filter((agent) =>
                  agent === "continue" || agent === "review"
                );
                const hasBackendContinue = backendResumeSuggestions.includes("continue");
                log.info("agent_logs continue override decision", {
                  projectId: suggestions.projectId,
                  source: "command_continue",
                  eventEndedWithStartBuildingMessage,
                  backendResumeSuggestions,
                  hasBackendContinue,
                  hasTasks,
                  hasArchitecture,
                  canBuildForPlan,
                  willShowStartBuilding: canShowStartBuilding,
                  reason: canShowStartBuilding
                    ? "tasks_architecture_and_review_build_signal_ready"
                    : !eventEndedWithStartBuildingMessage
                      ? "waiting_for_events_review_start_building_message"
                      : "waiting_for_start_building_signal",
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
                  eventEndedWithStartBuildingMessage,
                  backendResumeSuggestions,
                  hasBackendContinue,
                  hasTasks,
                  hasArchitecture,
                  canBuildForPlan,
                });
                if (startBuildingAgents.length > 0) {
                  log.info("post-generation suggestions updated", {
                    projectId: suggestions.projectId,
                    source: "command_continue",
                    reason: canShowStartBuilding
                      ? "resume_completed_with_architecture_tasks_and_review_build_signal"
                      : eventEndedWithStartBuildingMessage
                        ? "waiting_for_start_building_signal"
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
                    : `The design, tasks, and architecture are available.`;
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
                  buttons: pendingAfterNoOutputs.buttons,
                });
                if (!hasLatestCompletedAgentLog) {
                  return {
                    text: "",
                  };
                }
                const continueButtonLabel = continueAgents.includes("continue") ? await determineContinueButtonLabel(client, suggestions.projectId) : undefined;
                return {
                  text:
                    `✅ **Checkpoint reached.**\n${logsText}\n\n` +
                    buildSuggestedAgentsText(suggestions.projectId, continueAgents, "", continueButtonLabel, pendingAfterNoOutputs.buttons),
                  presentation: buildSuggestedAgentsPresentation(suggestions.projectId, continueAgents, "", continueButtonLabel, pendingAfterNoOutputs.buttons),
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
              progressTimeoutMs: 180_000,
              maxTimeoutMs: 180_000,
            });

            const buildReadinessAfterRun = await getBuildTasksReadiness(
              client,
              suggestions.projectId,
              activeModel,
              2
            ).catch((err) => {
              log.info("command trigger build execution-state check failed", {
                projectId: suggestions.projectId,
                selectedAgent,
                error: err instanceof Error ? err.message : String(err),
              });
              return null;
            });
            if (buildReadinessAfterRun?.canStart) {
              const statusForBuild = await client.getProjectStatus(suggestions.projectId).catch(() => null);
              const pendingForBuild = extractPendingSuggestion(statusForBuild?.pending_suggested_agents);
              const buildAgents = ["start_building", "review"];
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId: suggestions.projectId,
                agents: buildAgents,
                messageId: pendingForBuild.messageId || suggestions.messageId || "",
                buttons: pendingForBuild.buttons,
              });
              log.info("command trigger showing Build Tasks from authoritative execution state", {
                projectId: suggestions.projectId,
                phaseId: buildReadinessAfterRun.phaseId,
                runnableTaskCount: buildReadinessAfterRun.state.runnable_tasks?.length ?? 0,
              });
              return {
                text: buildSuggestedAgentsText(
                  suggestions.projectId,
                  buildAgents,
                  "",
                  undefined,
                  pendingForBuild.buttons
                ),
                presentation: buildSuggestedAgentsPresentation(
                  suggestions.projectId,
                  buildAgents,
                  "",
                  undefined,
                  pendingForBuild.buttons
                ),
              };
            }

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
                  buttons: pendingAfterPause.buttons,
                });
                return {
                  text: "",
                };
              }
              await writeLatestSuggestions(stateDir, sessionId, {
                projectId: suggestions.projectId,
                agents: reviewAgents,
                messageId: pendingAfterPause.messageId || suggestions.messageId || "",
                buttons: pendingAfterPause.buttons,
              });

              const continueButtonLabel = reviewAgents.includes("continue") ? await determineContinueButtonLabel(client, suggestions.projectId) : undefined;
              return {
                text:
                  buildSuggestedAgentsText(suggestions.projectId, reviewAgents, "", continueButtonLabel, pendingAfterPause.buttons),
                presentation: buildSuggestedAgentsPresentation(suggestions.projectId, reviewAgents, "", continueButtonLabel, pendingAfterPause.buttons),
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

            // Poll for updated suggestions from backend (the single-fetch was racing
            // with plan_all still running and returning stale pendingSuggestedAgents).
            const triggeredAgentSet = new Set(agentsToTrigger);
            const pollDeadline = Date.now() + (isPlanAll ? 45_000 : 30_000);
            const pollInterval = 5_000;
            let projectStatusAfter = await client.getProjectStatus(suggestions.projectId);
            let pendingSuggestionAfter = extractPendingSuggestion(projectStatusAfter.pending_suggested_agents);
            let pendingAgentsAfter = pendingSuggestionAfter.agents;
            let hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(suggestions.projectId);

            // Keep polling while the backend still shows the exact same agents we
            // just triggered AND the latest agent log hasn't completed yet.
            const backendStillStale = () => {
              if (pendingAgentsAfter.length === 0) return false;
              if (pendingAgentsAfter.includes("continue") || pendingAgentsAfter.includes("review")) return false;
              // Check if backend agents are exactly what we triggered (stale)
              return pendingAgentsAfter.every(a => triggeredAgentSet.has(a));
            };

            while (backendStillStale() && !hasLatestCompletedAgentLog && Date.now() < pollDeadline) {
              log.info("command trigger polling for updated suggestions", {
                projectId: suggestions.projectId,
                currentPending: pendingAgentsAfter,
                hasLatestCompletedAgentLog,
                remainingMs: pollDeadline - Date.now(),
              });
              await new Promise((resolve) => setTimeout(resolve, pollInterval));
              projectStatusAfter = await client.getProjectStatus(suggestions.projectId);
              pendingSuggestionAfter = extractPendingSuggestion(projectStatusAfter.pending_suggested_agents);
              pendingAgentsAfter = pendingSuggestionAfter.agents;
              hasLatestCompletedAgentLog = await client.hasLatestCompletedAgentLog(suggestions.projectId);
            }

            // If the backend exposed "continue" via review checkpoint, show continue/review
            if (hasLatestCompletedAgentLog && !pendingAgentsAfter.includes("continue")) {
              // The backend completed but hasn't yet exposed continue —
              // check if it's a review-ready state and inject continue/review
              const hasReviewText = (Array.isArray(projectStatusAfter.messages) ? projectStatusAfter.messages : [])
                .some((m: any) => isPauseForReviewText(m.content));
              if (hasReviewText || pendingAgentsAfter.length === 0) {
                pendingAgentsAfter = ["continue", "review"];
                log.info("command trigger injected continue/review after poll", {
                  projectId: suggestions.projectId,
                  reason: "latest_agent_completed_but_backend_stale",
                  hasReviewText,
                });
              }
            }

            let finalAgentsAfter = [...pendingAgentsAfter];

            log.info("command trigger backend suggested agents after events", {
              projectId: suggestions.projectId,
              pendingAgents: finalAgentsAfter,
              hasLatestCompletedAgentLog,
              reason: finalAgentsAfter.includes("continue")
                ? "backend_exposed_continue"
                : "backend_has_not_exposed_continue",
            });

            // If after all polling the backend STILL has the same stale agents
            // we triggered, clear suggestions to avoid showing a misleading button.
            if (finalAgentsAfter.every(a => triggeredAgentSet.has(a)) && finalAgentsAfter.length > 0 && !hasLatestCompletedAgentLog) {
              log.info("command trigger clearing stale suggestions", {
                projectId: suggestions.projectId,
                staleAgents: finalAgentsAfter,
                reason: "backend_returned_same_agents_as_triggered",
              });
              finalAgentsAfter = [];
            }

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
              messageId: pendingSuggestionAfter.messageId || suggestions.messageId || "",
              buttons: pendingSuggestionAfter.buttons,
            });

            const continueButtonLabel = groupedAgentsAfter.includes("continue") ? await determineContinueButtonLabel(client, suggestions.projectId) : undefined;
            const agentList = groupedAgentsAfter.length > 0
              ? buildSuggestedAgentsText(suggestions.projectId, groupedAgentsAfter, "", continueButtonLabel, pendingSuggestionAfter.buttons)
              : "";

            return {
              text:
                `✅ **${agentLabel}** run completed (using **${activeModel}**).` +
                `${logsText}${srdText}\n\n${agentList}`,
              presentation: groupedAgentsAfter.length > 0
                ? buildSuggestedAgentsPresentation(suggestions.projectId, groupedAgentsAfter, "", continueButtonLabel, pendingSuggestionAfter.buttons)
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
