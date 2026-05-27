import { Type } from "@sinclair/typebox";
import open from "open";
import { writeToken, clearToken } from "./auth.ts";
import { validateToken } from "./api-client.ts";

export function createLoginTool(deps: {
  stateDir: () => string;
  siteUrl: string;
  apiBaseUrl: string;
}) {
  return {
    name: "ai8080_login",
    description:
      "Log in to 8080.ai and securely save the authentication token. " +
      "Use this whenever the user provides a token or asks to authenticate. " +
      "This tool is the ONLY secure way to handle 8080.ai credentials.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("login"),
          Type.Literal("set-token"),
        ],
        {
          description:
            "'login' opens the browser and shows token setup steps. " +
            "'set-token' saves a token the user has already copied from the browser console.",
        }
      ),
      token: Type.Optional(
        Type.String({
          description:
            "Required only when action is 'set-token'. " +
            "The auth token from localStorage.getItem('auth_token') in the browser console.",
        })
      ),
    }),

    async execute(
      _id: string,
      params: { action: "login" | "set-token"; token?: string },
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[] }) => void
    ) {
      const stateDir = deps.stateDir();
      const { siteUrl } = deps;

      if (params.action === "set-token") {
        // Fuzzy parsing: remove whitespace, quotes, and common prefixes
        const tok = params.token
          ?.trim()
          .replace(/^["']|["']$/g, "") // remove quotes
          .replace(/^token:\s*/i, "")  // remove "token: " prefix
          .replace(/\s+/g, "");        // remove all whitespace

        if (!tok) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Please provide your token. Get it from the browser console:\n\n" +
                  "```\nlocalStorage.getItem('auth_token')\n```",
              },
            ],
          };
        }

        onUpdate?.({ content: [{ type: "text", text: "🔄 Validating token with 8080.ai..." }] });

        // Validate token before saving
        try {
          const isValid = await validateToken({ token: tok, apiBaseUrl: deps.apiBaseUrl });
          if (!isValid) {
            return {
              content: [{ type: "text", text: "❌ Invalid token. Please check the token and try again." }],
            };
          }
        } catch (err) {
          return {
            content: [{ type: "text", text: `❌ Failed to validate token: ${err instanceof Error ? err.message : String(err)}` }],
          };
        }

        await writeToken(stateDir, tok);
        const successMsg = "✅ Token validated and saved. You are now logged in to 8080.ai.";
        onUpdate?.({ content: [{ type: "text", text: successMsg }] });

        return {
          content: [{ type: "text", text: successMsg }],
        };
      }

      // action === "login"
      try {
        await open(siteUrl);
      } catch {
        // Browser failed to open — that's OK, user can open manually
      }

      return {
        presentation: {
          type: "buttons",
          buttons: [
            {
              label: "Open 8080.ai Login",
              url: siteUrl,
              style: "primary",
            },
          ],
        },
        content: [
          {
            type: "text",
            text:
              `🔗 **Please log in to 8080.ai to continue.**\n\n` +
              `1. Click the **Open 8080.ai Login** button above (or go to ${siteUrl})\n` +
              `2. Sign in to your account.\n` +
              `3. Open the browser console (F12 → Console).\n` +
              `4. Run: \`localStorage.getItem('auth_token')\`\n` +
              `5. Copy the token and paste it here: \`set my token <token>\`\n\n` +
              `I'll save it securely for your session.`,
          },
        ],
      };
    },
  };
}