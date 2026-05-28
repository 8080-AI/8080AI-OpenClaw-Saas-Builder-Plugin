import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { create8080Command } from "./src/command.ts";
import { createStartProjectTool } from "./src/start-project-tool.ts";
import { createProjectStatusTool } from "./src/project-status-tool.ts";
import { createCreditsTool } from "./src/credits-tool.ts";
import { createReviewProjectTool } from "./src/review-project-tool.ts";
import { createContinueProjectTool } from "./src/continue-project-tool.ts";
import { createSendMessageTool } from "./src/send-message-tool.ts";
import { createTriggerAgentsTool } from "./src/trigger-agents-tool.ts";
import { createLoginTool } from "./src/login-tool.ts";
import { createListProjectsTool } from "./src/list-projects-tool.ts";
import { createModelTool } from "./src/model-tool.ts";
import { createSelectProjectTool } from "./src/select-project-tool.ts";
import { createTaskListTool } from "./src/task-list-tool.ts";
import { generateSessionId } from "./src/command.ts";
import { configureLogger, log } from "./logger.ts";
type PluginConfig = {
  siteUrl?: string;
  apiBaseUrl?: string;
  pollingTimeoutMs?: number;
};

const DEFAULT_SITE_URL = "https://8080.ai/";
const DEFAULT_API_BASE_URL = "https://api.8080.ai/api/v1";

export default definePluginEntry({
  id: "ai8080",
  name: "8080.ai",
  description: "Integrates the 8080.ai AI software development platform into OpenClaw.",

  register(api) {
    configureLogger(api.logger);
    log.info("Registering plugin", { pluginId: api.pluginId });
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const siteUrl = (config.siteUrl?.trim() || DEFAULT_SITE_URL).replace(/\/$/, "");
    const apiBaseUrl = (config.apiBaseUrl?.trim() || DEFAULT_API_BASE_URL).replace(/\/$/, "");
    const pollingTimeoutMs = config.pollingTimeoutMs ?? 600_000;

    const stateDir = () => api.runtime.state.resolveStateDir();
    const sessionId = generateSessionId();

    // -----------------------------------------------------------------------
    // 1. Slash command — /ai8080 login | logout | set-token | credits | status | review | continue
    //    Kept as a manual fallback for when the LLM should not be involved
    //    (auth flows in particular).
    // -----------------------------------------------------------------------
    const command = create8080Command(
      api as Parameters<typeof create8080Command>[0],
      { siteUrl, apiBaseUrl, sessionId }
    );
    api.registerCommand(command);

    // -----------------------------------------------------------------------
    // 2. AI Tools — invoked by the LLM from natural-language prompts.
    //    Each factory captures stateDir/apiBaseUrl in a closure.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    api.registerTool(
      createStartProjectTool({ stateDir, apiBaseUrl, pollingTimeoutMs, sessionId })
    );
    api.registerTool(createLoginTool({ stateDir, siteUrl, apiBaseUrl }));
    api.registerTool(createProjectStatusTool({ stateDir, apiBaseUrl, sessionId }));
    api.registerTool(createCreditsTool({ stateDir, apiBaseUrl }));
    api.registerTool(createReviewProjectTool({ stateDir, apiBaseUrl, sessionId }));
    api.registerTool(createContinueProjectTool({ stateDir, apiBaseUrl, sessionId }));
    api.registerTool(createSendMessageTool({ stateDir, siteUrl, apiBaseUrl, sessionId }));
    api.registerTool(createTriggerAgentsTool({ stateDir, apiBaseUrl, sessionId }));
    api.registerTool(createListProjectsTool({ stateDir, apiBaseUrl }));
    api.registerTool(createSelectProjectTool({ stateDir, apiBaseUrl, sessionId }));
    api.registerTool(createTaskListTool({ stateDir, apiBaseUrl, sessionId }));
    api.registerTool(createModelTool({ stateDir, apiBaseUrl }));
  },
});
