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
  return {
    content: [],
    details: {
      ...details,
      // The hook reads these flags and blocks the next assistant filler message.
      responseMode: "silent",
      silent: true,
      suppressUserResponse: true,
      modelInstruction:
        "Do not send any user-facing message for this tool result. The 8080.ai agents are still running; only show text/buttons when the tool returns visible content.",
    } satisfies SilentToolDetails,
  };
}
