import open from "open";
import { writeToken, clearToken, requireToken, AuthRequiredError } from "./auth.ts";
import { AuthError, createApiClient } from "./api-client.ts";

const HELP_TEXT = `8080.ai plugin commands:

  /ai8080 login                  Log in to 8080.ai via browser
  /ai8080 logout                 Log out and clear saved credentials
  /ai8080 set-token <token>      Manually set auth token (from browser console)
  /ai8080 credits                Show your remaining 8080.ai credits
  /ai8080 status <projectId>     Show status of a project
  /ai8080 review <projectId>     Open the requirement document in browser
  /ai8080 continue <projectId>   Signal 8080.ai to proceed past the requirement review

You can also ask me to start a project: "Build a todo app with React and Node"`;

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
        case "login": {
          try {
            await open(siteUrl);
          } catch {
            return {
              text: `Could not open browser. Please visit ${siteUrl} manually to log in.`,
            };
          }

          return {
            text:
              `Opened ${siteUrl} in your browser. Log in with your account.\n\n` +
              `After logging in, copy your auth token:\n` +
              `  1. Open browser console (F12 → Console)\n` +
              `  2. Run: localStorage.getItem('auth_token')\n` +
              `  3. Copy the value and run: /ai8080 set-token <token>`,
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
            text: "Logged out of 8080.ai. Run `/ai8080 login` to re-authenticate.",
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
        case "status": {
          const projectId = rest[0]?.trim();
          if (!projectId) return { text: "Usage: /ai8080 status <projectId>" };

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
          const projectId = rest[0]?.trim();
          if (!projectId) return { text: "Usage: /ai8080 review <projectId>" };

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
          const projectId = rest[0]?.trim();
          if (!projectId) return { text: "Usage: /ai8080 continue <projectId>" };

          let token: string;
          try {
            token = await requireToken(stateDir);
          } catch (err) {
            if (err instanceof AuthRequiredError) return { text: err.message };
            throw err;
          }
          try {
            const client = createApiClient({ token, apiBaseUrl });
            await client.continueProject(projectId);
            return {
              text: `✅ Continuing project ${projectId}. Agents are now building your software.`,
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
