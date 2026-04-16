// Builds A2UI JSONL for the Review / Continue button pair shown after the
// requirement document is ready. Each line is a JSON object.
//
// Button values are prefixed with "8080_review_" or "8080_continue_" so
// the agent can recognise them when they arrive back as user messages.

export function buildReviewContinueJsonl(
  projectId: string,
  requirementDocUrl: string
): string {
  const lines = [
    JSON.stringify({
      type: "text",
      text: `Requirement document is ready for review.\nURL: ${requirementDocUrl}`,
    }),
    JSON.stringify({
      type: "buttons",
      buttons: [
        {
          label: "Review Document",
          value: `8080_review_${projectId}`,
          style: "secondary",
        },
        {
          label: "Continue Building",
          value: `8080_continue_${projectId}`,
          style: "primary",
        },
      ],
    }),
  ];
  return lines.join("\n");
}

// Parse a button value back to its action and projectId.
// Returns null if the value is not from this plugin.
export function parseButtonValue(
  value: string
): { action: "review" | "continue"; projectId: string } | null {
  if (value.startsWith("8080_review_")) {
    return { action: "review", projectId: value.slice("8080_review_".length) };
  }
  if (value.startsWith("8080_continue_")) {
    return {
      action: "continue",
      projectId: value.slice("8080_continue_".length),
    };
  }
  return null;
}
