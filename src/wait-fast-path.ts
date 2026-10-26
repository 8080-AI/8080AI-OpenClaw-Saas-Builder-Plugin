import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { AuthError, requireAuthenticatedClient } from "./api-client.ts";
import { buildSuggestedAgentChoices, parseButtonValue } from "./review-continue.ts";
import { consumeAutoRunSuggestion, readLatestSuggestions } from "./suggestions-state.ts";
import { log } from "../logger.ts";

type BeforeDispatchEvent = {
  content: string;
  body?: string;
};

type BeforeDispatchResult = {
  handled: boolean;
  text?: string;
};

type WaitFastPathDeps = {
  stateDir: () => string;
  apiBaseUrl: string;
  sessionId: string;
};

function normalizeChoiceText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseDirectChoice(content: string): string | undefined {
  const normalized = normalizeChoiceText(content);
  if (/^(?:wait|select wait|choose wait|press wait)$/.test(normalized)) return "wait";

  const numbered = normalized.match(/^(?:select|choose|press)(?: option| button)? (\d+)$/);
  if (numbered) return numbered[1];
  if (/^\d+$/.test(normalized)) return normalized;
  return undefined;
}

export function createWaitFastPathHandler(deps: WaitFastPathDeps) {
  return async (event: BeforeDispatchEvent): Promise<BeforeDispatchResult | undefined> => {
    const choice = parseDirectChoice(event.body || event.content);
    if (!choice) return undefined;

    const suggestions = await readLatestSuggestions(deps.stateDir(), deps.sessionId);
    if (!suggestions || suggestions.agents.length === 0) return undefined;

    const choices = buildSuggestedAgentChoices(
      suggestions.projectId,
      suggestions.agents,
      undefined,
      suggestions.buttons
    );
    const numericChoice = Number.parseInt(choice, 10);
    const selected = Number.isNaN(numericChoice)
      ? choices.find((candidate) => normalizeChoiceText(candidate.label) === choice)
      : choices[numericChoice - 1];
    const parsed = selected?.value ? parseButtonValue(selected.value) : null;
    if (parsed?.action !== "wait" || !parsed.entryId) return undefined;

    log.info("wait fast path claimed inbound message", {
      choice,
      projectId: parsed.projectId,
      entryId: parsed.entryId,
    });

    try {
      const client = await requireAuthenticatedClient(deps.stateDir(), deps.apiBaseUrl);
      const result = await client.waitForAutoRun(parsed.projectId, parsed.entryId);
      log.info("wait fast path response", {
        projectId: parsed.projectId,
        entryId: parsed.entryId,
        status: result.status,
      });

      // Any successful endpoint response means this exact entry is no longer
      // a usable scheduled action. Consume it locally so Wait cannot reappear.
      await consumeAutoRunSuggestion(
        deps.stateDir(),
        deps.sessionId,
        parsed.projectId,
        parsed.entryId
      );

      if (result.status === "cancelled") {
        const label = parsed.label || "the action";
        return {
          handled: true,
          text:
            `Automatic ${label} was cancelled. Choose ${label} when you are ready to trigger it manually.` +
            `\n\n### Suggested Next Steps:\n1. ${label}`,
        };
      }

      return {
        handled: true,
        text: "That automatic action is no longer scheduled; it may already be running or completed.",
      };
    } catch (error) {
      if (error instanceof AuthError) {
        return { handled: true, text: error.message };
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error("wait fast path failed", {
        projectId: parsed.projectId,
        entryId: parsed.entryId,
        error: message,
      });
      return {
        handled: true,
        text: `8080.ai error while cancelling the automatic action: ${message}`,
      };
    }
  };
}

export function registerWaitFastPath(
  api: Pick<OpenClawPluginApi, "on">,
  deps: WaitFastPathDeps
): void {
  const handler = createWaitFastPathHandler(deps);
  api.on("before_dispatch", async (event) => handler(event), {
    priority: 1_000,
    timeoutMs: 15_000,
    registrationId: "8080ai.wait-fast-path",
  });
}
