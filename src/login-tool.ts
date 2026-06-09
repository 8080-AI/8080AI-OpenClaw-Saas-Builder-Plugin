import { Type } from "@sinclair/typebox";
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
      "Securely save a validated 8080.ai OpenClaw API key. " +
      "Use this whenever the user provides an API key or asks to authenticate. " +
      "This tool is the ONLY secure way to handle 8080.ai credentials.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("login"),
          Type.Literal("set-api-key"),
        ],
        {
          description:
            "'login' opens 8080.ai and shows API-key setup steps. " +
            "'set-api-key' saves a validated 8080.ai API key.",
        }
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
      params: { action: "login" | "set-api-key"; apiKey?: string },
      _signal: AbortSignal | undefined,
      onUpdate: (partial: { content: { type: "text"; text: string }[] }) => void
    ) {
      const stateDir = deps.stateDir();
      const { siteUrl } = deps;

      if (params.action === "set-api-key") {
        log.info("login_tool set-api-key entered", {
          hasApiKeyParam: Boolean(params.apiKey),
          apiKeyParamLength: params.apiKey?.length ?? 0,
        });
        const apiKey = cleanApiKey(params.apiKey);
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
              `3. Open your profile section.\n` +
              `4. Find **OpenClaw Secret Key Generation**.\n` +
              `5. Generate a new key.\n` +
              `6. Copy the key immediately. The key is shown only once.\n` +
              `7. Click **Done** after copying it.\n` +
              `8. Save it here with: \`set api-key <api-key>\`\n\n` +
              `I'll validate it locally and save it securely for future requests.`,
          },
        ],
      };
    },
  };
}
