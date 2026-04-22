import open from "open";
import { writeToken, clearToken, requireToken, AuthRequiredError } from "./auth.ts";
import { AuthError, createApiClient } from "./api-client.ts";
import { readActiveProject, writeActiveProject } from "./project-state.ts";
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

To build a project with 8080.ai, you can also just ask: "Use 8080.ai to build a todo app"`;

export function create8080Command(
  api: {
    runtime: { state: { resolveStateDir(): string } };
  },
  urls: { siteUrl: string; apiBaseUrl: string }
) {
  const { siteUrl, apiBaseUrl } = urls;

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
            const result = await client.createProject(requirements);
            return {
              text:
                `🚀 Project created on 8080.ai!\n\n` +
                `Project ID: ${result.projectId}\n\n` +
                `The 8080.ai agents are now working on your requirements. ` +
                `Run \`/ai8080 status ${result.projectId}\` to check progress.`,
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

            const activeProjectId = await readActiveProject(stateDir);

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
              const activeProjectId = await readActiveProject(stateDir);
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
            await writeActiveProject(stateDir, selected.id);
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
            projectId = (await readActiveProject(stateDir)) ?? "";
          }

          if (!projectId) {
            return {
              text: "No project active. Use `/ai8080 list` to select one or provide a project ID: `/ai8080 status <projectId>`",
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
            const lines = [
              `Project: ${projectId}`,
              `Phase:   ${s.phase}`,
            ];
            if (s.activeAgent) lines.push(`Agent:   ${s.activeAgent}`);
            if (s.agentMessage) lines.push(`Status:  ${s.agentMessage}`);
            if (s.requirementDocUrl) lines.push(`Req Doc: ${s.requirementDocUrl}`);
            if (s.error) lines.push(`Error:   ${s.error}`);
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
            projectId = (await readActiveProject(stateDir)) ?? "";
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
            projectId = (await readActiveProject(stateDir)) ?? "";
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
            await client.continueProject(projectId, activeModel);
            const modelInfo = MODEL_OPTIONS.find((m) => m.id === activeModel);
            return {
              text: `✅ Continuing project ${projectId} with **${modelInfo?.label ?? activeModel}**. Agents are now building your software.`,
            };
          } catch (err) {
            if (err instanceof AuthError) return { text: (err as Error).message };
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `8080.ai error: ${msg}` };
          }
        }

        // ------------------------------------------------------------------
        default:
          return { text: HELP_TEXT };
      }
    },
  };
}
