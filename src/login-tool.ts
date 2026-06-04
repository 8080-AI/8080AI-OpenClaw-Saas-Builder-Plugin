import { Type } from "@sinclair/typebox";
import { writeToken, clearToken } from "./auth.ts";
import { refreshAccessToken, validateToken } from "./api-client.ts";
import { cleanApiKey, validateApiKey, writeApiKey } from "./api-key.ts";
import { log } from "../logger.ts";

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
          Type.Literal("set-tokens"),
          Type.Literal("set-api-key"),
        ],
        {
          description:
            "'login' opens the browser and shows token setup steps. " +
            "'set-token' saves an auth token. " +
            "'set-tokens' saves auth and refresh tokens for automatic renewal. " +
            "'set-api-key' saves a validated 8080.ai API key.",
        }
      ),
      token: Type.Optional(
        Type.String({
          description:
            "Required only when action is 'set-token'. " +
            "The auth token from localStorage.getItem('auth_token') in the browser console.",
        })
      ),
      refreshToken: Type.Optional(
        Type.String({
          description:
            "Required only when action is 'set-tokens'. " +
            "The refresh token from localStorage.getItem('refresh_token') in the browser console.",
        })
      ),
      apiKey: Type.Optional(
        Type.String({
          description:
            "Required only when action is 'set-api-key'. The Base64 URL-safe 8080.ai API key.",
        })
      ),
    }),

    async execute(
      _id: string,
      params: { action: "login" | "set-token" | "set-tokens" | "set-api-key"; token?: string; refreshToken?: string; apiKey?: string },
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[] }) => void
    ) {
      const stateDir = deps.stateDir();
      const { siteUrl } = deps;

      if (params.action === "set-api-key") {
        log.info("login_tool set-api-key entered", {
          hasApiKeyParam: Boolean(params.apiKey),
          hasTokenFallback: Boolean(params.token),
          apiKeyParamLength: params.apiKey?.length ?? 0,
          tokenFallbackLength: params.token?.length ?? 0,
        });
        const apiKey = cleanApiKey(params.apiKey ?? params.token);
        if (!apiKey) {
          log.info("login_tool set-api-key missing_api_key");
          return {
            content: [{ type: "text", text: "Please provide your API key." }],
          };
        }

        try {
          const meta = validateApiKey(apiKey);
          log.info("login_tool set-api-key validated", {
            uid: meta.uid,
            issuedAt: meta.issuedAt,
            expiresAt: meta.expiresAt,
            keyLength: apiKey.length,
          });
          await writeApiKey(stateDir, apiKey, meta);
          const successMsg = "API key validated and saved. You are now connected to 8080.ai.";
          onUpdate?.({ content: [{ type: "text", text: successMsg }] });
          return {
            content: [{ type: "text", text: successMsg }],
          };
        } catch (err) {
          log.info("login_tool set-api-key failed", err);
          return {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          };
        }
      }

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

      if (params.action === "set-tokens") {
        const tok = params.token
          ?.trim()
          .replace(/^["']|["']$/g, "")
          .replace(/^token:\s*/i, "")
          .replace(/\s+/g, "");
        const refreshToken = params.refreshToken
          ?.trim()
          .replace(/^["']|["']$/g, "")
          .replace(/^refresh_token:\s*/i, "")
          .replace(/\s+/g, "");

        if (!tok || !refreshToken) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Please provide both tokens. Get them from the browser console:\n\n" +
                  "```\nlocalStorage.getItem('auth_token')\nlocalStorage.getItem('refresh_token')\n```",
              },
            ],
          };
        }

        onUpdate?.({ content: [{ type: "text", text: "🔄 Validating auth and refresh tokens with 8080.ai..." }] });

        try {
          await validateToken({ token: tok, apiBaseUrl: deps.apiBaseUrl });
          const validToken = await refreshAccessToken({ apiBaseUrl: deps.apiBaseUrl, refreshToken });
          const isValid = await validateToken({ token: validToken, apiBaseUrl: deps.apiBaseUrl });
          if (!isValid) {
            return {
              content: [{ type: "text", text: "❌ Invalid auth token and refresh token. Please check both tokens and try again." }],
            };
          }

          await writeToken(stateDir, validToken, { refreshToken });
          const successMsg = "✅ Auth token and refresh token validated and saved. OpenClaw can now refresh your 8080.ai session automatically.";
          onUpdate?.({ content: [{ type: "text", text: successMsg }] });

          return {
            content: [{ type: "text", text: successMsg }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `❌ Failed to validate tokens: ${err instanceof Error ? err.message : String(err)}` }],
          };
        }
      }

      // action === "login"
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
              `5. Optional auto-renew: \`localStorage.getItem('refresh_token')\`\n` +
              `6. Copy the token and paste it here: \`set my token <token>\`\n\n` +
              `For auto-renew in slash command mode, use: \`/ai8080 set-tokens <auth_token> <refresh_token>\`\n\n` +
              `I'll save it securely for your session.`,
          },
        ],
      };
    },
  };
}
