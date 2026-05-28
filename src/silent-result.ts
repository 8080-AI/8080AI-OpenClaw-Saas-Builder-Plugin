export function silentToolResult(details: Record<string, unknown> = {}) {
  return {
    content: [],
    details: {
      ...details,
      silent: true,
      suppressUserResponse: true,
      modelInstruction:
        "Do not send any user-facing message for this tool result. The 8080.ai agents are still running; only show text/buttons when the tool returns visible content.",
    },
  };
}
