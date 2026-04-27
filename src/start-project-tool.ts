import { Type } from "@sinclair/typebox";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient, type ProjectStatus } from "./api-client.ts";
import { buildReviewContinueJsonl, buildSuggestedAgentsText } from "./review-continue.ts";

const POLL_INTERVAL_MS = 3_000;

// AgentToolResult shape required by the OpenClaw SDK's onUpdate callback.
type ToolContent = { type: "text"; text: string };
type ToolResult<T = unknown> = { content: ToolContent[]; details: T };
type OnUpdate = (partial: ToolResult) => void;

const AGENT_LABELS: Record<string, string> = {
  tech_lead: "Tech Lead",
  frontend: "Frontend",
  backend: "Backend",
  devops: "DevOps",
  designer: "Designer",
  qa: "QA",
};

function friendlyAgent(raw?: string): string {
  if (!raw) return "Agent";
  return AGENT_LABELS[raw.toLowerCase()] ?? raw;
}

// Emit a streaming update — each call replaces the previous partial content in
// OpenClaw's UI, so pass the full accumulated text every time.
function stream(onUpdate: OnUpdate | undefined, text: string): void {
  onUpdate?.({ content: [{ type: "text", text }], details: null });
}

export function createStartProjectTool(deps: {
  stateDir: () => string;
  apiBaseUrl: string;
  pollingTimeoutMs: number;
}) {
  return {
    name: "ai8080_start_project",
    description:
      "The primary tool for building software projects using 8080.ai. " +
      "Use this whenever the user wants to create, build, or scaffold a new application. " +
      "It connects to the 8080.ai platform which handles architecture, coding, and deployment. " +
      "Shows live agent activity from the platform as it works.",
    parameters: Type.Object({
      requirements: Type.String({
        description:
          "Full description of the software project requirements to send to 8080.ai.",
      }),
    }),

    async execute(
      _id: string,
      params: { requirements: string },
      _signal: AbortSignal | undefined,
      onUpdate: OnUpdate | undefined
    ): Promise<ToolResult> {
      const stateDir = deps.stateDir();
      const { apiBaseUrl, pollingTimeoutMs } = deps;

      // --- Auth ---
      let token: string;
      try {
        token = await requireToken(stateDir);
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return { content: [{ type: "text", text: err.message }], details: null };
        }
        throw err;
      }

      const client = createApiClient({ token, apiBaseUrl });

      // --- Create project + stream the Tech Lead's initial reply token by token ---
      let projectId: string;
      let accumulatedText = "";

      try {
        const result = await client.streamProjectCreation(
          params.requirements,
          (token) => {
            // Called once per SSE token — accumulate and push the full text so
            // OpenClaw replaces the previous partial with the longer one each time,
            // producing a word-by-word streaming effect identical to LLM output.
            accumulatedText += token;
            stream(onUpdate, accumulatedText);
          },
          undefined,
          (agents) => {
            // Handle suggested agents by showing them as a text list.
            const agentsDisplay = buildSuggestedAgentsText(agents);
            stream(onUpdate, `${accumulatedText}${agentsDisplay}`);
          }
        );
        projectId = result.projectId;
      } catch (err) {
        if (err instanceof AuthError) {
          return { content: [{ type: "text", text: (err as Error).message }], details: null };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to create project: ${msg}` }], details: null };
      }

      // Keep streaming visible after the SSE stream closes, then add the transition message.
      const streamedPreamble = accumulatedText ? `${accumulatedText}\n\n` : "";
      stream(onUpdate, `${streamedPreamble}Project created (ID: ${projectId}). Working…`);

      // --- Poll for phase transitions, streaming agent status updates ---
      const deadline = Date.now() + pollingTimeoutMs;
      let lastMessage = "";

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

        let status: ProjectStatus;
        try {
          status = await client.getProjectStatus(projectId);
        } catch (err) {
          if (err instanceof AuthError) {
            return { content: [{ type: "text", text: (err as Error).message }], details: null };
          }
          continue; // transient network error — keep polling
        }

        const msg =
          status.agentMessage ??
          (status.activeAgent
            ? `${friendlyAgent(status.activeAgent)} is working…`
            : "Working…");

        if (msg !== lastMessage) {
          stream(onUpdate, `${streamedPreamble}${msg}`);
          lastMessage = msg;
        }

        if (status.phase === "requirements" && status.requirementDocUrl) {
          const a2ui = buildReviewContinueJsonl(projectId, status.requirementDocUrl);
          return {
            content: [
              {
                type: "text",
                text:
                  `${streamedPreamble}Requirement document ready!\n\n` +
                  `Project ID: ${projectId}\n` +
                  `Doc URL: ${status.requirementDocUrl}\n\n` +
                  `Use the buttons below to Review the document or Continue building.\n\n` +
                  `<!-- a2ui\n${a2ui}\n-->`,
              },
            ],
            details: { projectId, phase: "requirements", requirementDocUrl: status.requirementDocUrl },
          };
        }

        if (status.phase === "complete") {
          return {
            content: [{ type: "text", text: `${streamedPreamble}Project build complete!\n\nProject ID: ${projectId}` }],
            details: { projectId, phase: "complete" },
          };
        }

        if (status.phase === "failed") {
          return {
            content: [{ type: "text", text: `${streamedPreamble}Project failed: ${status.error ?? "Unknown error"}\n\nProject ID: ${projectId}` }],
            details: { projectId, phase: "failed" },
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `${streamedPreamble}Timed out waiting for project status.\n\nProject ID: ${projectId}\n\nRun \`/ai8080 status ${projectId}\` to check later.`,
          },
        ],
        details: { projectId, phase: "timeout" },
      };
    },
  };
}
