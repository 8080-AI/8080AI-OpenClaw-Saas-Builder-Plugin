import { Type } from "@sinclair/typebox";
import { AuthRequiredError, requireToken } from "./auth.ts";
import { AuthError, createApiClient, type ProjectStatus } from "./api-client.ts";
import { buildReviewContinueJsonl } from "./review-continue.ts";

const POLL_INTERVAL_MS = 3_000;

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
      onUpdate: ((update: { content: { type: string; text: string }[] }) => void) | undefined
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl, pollingTimeoutMs } = deps;

      // --- Auth ---
      let token: string;
      try {
        token = await requireToken(stateDir);
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return {
            content: [{ type: "text", text: err.message }],
          };
        }
        throw err;
      }

      const client = createApiClient({ token, apiBaseUrl });

      // --- Create project ---
      let projectId: string;
      try {
        const result = await client.createProject(params.requirements);
        projectId = result.projectId;
      } catch (err) {
        if (err instanceof AuthError) {
          return { content: [{ type: "text", text: (err as Error).message }] };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to create project: ${msg}` }],
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `[8080.ai] Project created (ID: ${projectId}). Starting agents…`,
          },
        ],
      });

      // --- Poll status ---
      const deadline = Date.now() + pollingTimeoutMs;
      let lastMessage = "";

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

        let status: ProjectStatus;
        try {
          status = await client.getProjectStatus(projectId);
        } catch (err) {
          if (err instanceof AuthError) {
            return { content: [{ type: "text", text: (err as Error).message }] };
          }
          // Transient network error — keep polling
          continue;
        }

        const msg =
          status.agentMessage ??
          (status.activeAgent
            ? `${friendlyAgent(status.activeAgent)} is working…`
            : "Working…");

        if (msg !== lastMessage) {
          onUpdate?.({
            content: [{ type: "text", text: `[8080.ai] ${msg}` }],
          });
          lastMessage = msg;
        }

        if (status.phase === "requirements" && status.requirementDocUrl) {
          const a2ui = buildReviewContinueJsonl(
            projectId,
            status.requirementDocUrl
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `[8080.ai] Requirement document ready!\n\n` +
                  `Project ID: ${projectId}\n` +
                  `Doc URL: ${status.requirementDocUrl}\n\n` +
                  `Use the buttons below to Review the document or Continue building.\n\n` +
                  `<!-- a2ui\n${a2ui}\n-->`,
              },
            ],
            details: {
              projectId,
              phase: "requirements",
              requirementDocUrl: status.requirementDocUrl,
            },
          };
        }

        if (status.phase === "complete") {
          return {
            content: [
              {
                type: "text",
                text: `[8080.ai] Project build complete!\n\nProject ID: ${projectId}`,
              },
            ],
            details: { projectId, phase: "complete" },
          };
        }

        if (status.phase === "failed") {
          return {
            content: [
              {
                type: "text",
                text: `[8080.ai] Project failed: ${status.error ?? "Unknown error"}\n\nProject ID: ${projectId}`,
              },
            ],
            details: { projectId, phase: "failed" },
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `[8080.ai] Timed out waiting for project status.\n\nProject ID: ${projectId}\n\nRun \`/ai8080 status ${projectId}\` to check later.`,
          },
        ],
        details: { projectId, phase: "timeout" },
      };
    },
  };
}
