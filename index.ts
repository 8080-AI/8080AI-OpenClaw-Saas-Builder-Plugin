import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { create8080Command } from "./src/command.ts";
import { createStartProjectTool } from "./src/start-project-tool.ts";
import { createProjectStatusTool } from "./src/project-status-tool.ts";
import { createCreditsTool } from "./src/credits-tool.ts";
import { createReviewProjectTool } from "./src/review-project-tool.ts";
import { createContinueProjectTool } from "./src/continue-project-tool.ts";
import { createSendMessageTool } from "./src/send-message-tool.ts";
import { createTriggerAgentsTool } from "./src/trigger-agents-tool.ts";

type PluginConfig = {
  siteUrl?: string;
  apiBaseUrl?: string;
  pollingTimeoutMs?: number;
};

export default definePluginEntry({
  id: "8080",
  name: "8080.ai",
  description: "Integrates the 8080.ai AI software development platform into OpenClaw.",

  register(api) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const siteUrl = config.siteUrl?.trim().replace(/\/$/, "") || "https://8080.ai";
    const apiBaseUrl =
      config.apiBaseUrl?.trim().replace(/\/$/, "") || "https://api.8080.ai/api/v1";
    const pollingTimeoutMs = config.pollingTimeoutMs ?? 600_000;

    const stateDir = () => api.runtime.state.resolveStateDir();

    // -----------------------------------------------------------------------
    // 1. Slash command — /ai8080 login | logout | set-token | credits | status | review | continue
    //    Kept as a manual fallback for when the LLM should not be involved
    //    (auth flows in particular).
    // -----------------------------------------------------------------------
    const command = create8080Command(
      api as Parameters<typeof create8080Command>[0],
      { siteUrl, apiBaseUrl }
    );
    api.registerCommand(command);

    // -----------------------------------------------------------------------
    // 2. AI Tools — invoked by the LLM from natural-language prompts.
    //    Each factory captures stateDir/apiBaseUrl in a closure.
    // -----------------------------------------------------------------------
    api.registerTool(
      createStartProjectTool({ stateDir, apiBaseUrl, pollingTimeoutMs })
    );
    api.registerTool(createProjectStatusTool({ stateDir, apiBaseUrl }));
    api.registerTool(createCreditsTool({ stateDir, apiBaseUrl }));
    api.registerTool(createReviewProjectTool({ stateDir, apiBaseUrl }));
    api.registerTool(createContinueProjectTool({ stateDir, apiBaseUrl }));
    api.registerTool(createSendMessageTool({ stateDir, apiBaseUrl }));
    api.registerTool(createTriggerAgentsTool({ stateDir, apiBaseUrl }));
  },
});
