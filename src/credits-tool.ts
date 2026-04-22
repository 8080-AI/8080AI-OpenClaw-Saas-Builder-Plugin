import { Type } from "@sinclair/typebox";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient } from "./api-client.ts";

export function createCreditsTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
}) {
  return {
    name: "ai8080_get_credits_balance",
    description:
      "Check the user's current 8080.ai credits balance and subscription plan. " +
      "Use when the user asks how many credits they have left, what their 8080.ai plan is, " +
      "or anything about their 8080.ai account balance or subscription.",
    parameters: Type.Object({}),

    async execute(
      _id: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl } = deps;

      let token: string;
      try {
        token = await requireToken(stateDir);
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { content: [{ type: "text", text: err.message }] };
        }
        throw err;
      }

      try {
        const client = createApiClient({ token, apiBaseUrl });
        const sub = await client.getSubscription();
        const text =
          `8080.ai Subscription\n` +
          `  Plan      : ${sub.plan_name} (${sub.status})\n` +
          `  Credits   : ${sub.credits_balance}\n` +
          (sub.renews_at ? `  Renews at : ${sub.renews_at}\n` : "");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (err instanceof AuthError) {
          return { content: [{ type: "text", text: (err as Error).message }] };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `8080.ai error: ${msg}` }] };
      }
    },
  };
}
