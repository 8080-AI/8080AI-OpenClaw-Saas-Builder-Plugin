type ToolContent = { type: "text"; text: string };

type ExactToolDetails = Record<string, unknown> & {
  responseMode: "exact";
  exactUserResponse: string;
};

type SilentToolDetails = Record<string, unknown> & {
  responseMode: "silent";
  silent: true;
  suppressUserResponse: true;
};

export function exactToolResult(
  text: string,
  details: Record<string, unknown> = {},
  presentation?: unknown
) {
  const result: {
    content: ToolContent[];
    details: ExactToolDetails;
    presentation?: unknown;
  } = {
    content: [{ type: "text", text }],
    details: {
      ...details,
      // The hook reads this metadata and replaces any model-written prose with
      // the exact tool text.
      responseMode: "exact",
      exactUserResponse: text,
    },
  };

  if (presentation !== undefined) result.presentation = presentation;
  return result;
}

export function silentToolResult(details: Record<string, unknown> = {}) {
  const status = details.status;
  let text = "8080.ai is processing in the background. Please check back in a moment.";
  if (status === "running" || status === "agents_running") {
    text = "8080.ai agents are currently running. Please wait a moment for them to finish, and then check the status.";
  } else if (status === "waiting_for_next_actions" || status === "waiting_for_review_actions") {
    text = "8080.ai is generating the next steps. Please check back in a moment.";
  } else if (status === "blocked_without_continue_suggestion") {
    text = "The project is currently not in a state where it can be continued. Please check the current status on the 8080.ai dashboard.";
  } else if (status === "empty_response") {
    text = "Received an empty response from 8080.ai. Please try again or check the status.";
  }

  return {
    content: [{ type: "text", text }],
    details: {
      ...details,
      responseMode: "exact",
      exactUserResponse: text,
    },
  };
}

