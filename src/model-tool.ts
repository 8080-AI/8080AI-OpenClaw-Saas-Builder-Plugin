import { Type } from "@sinclair/typebox";
import { readActiveModel, writeActiveModel, MODEL_OPTIONS, type ModelTier } from "./model-state.ts";
import { requireAuthenticatedClient } from "./api-client.ts";
import { AuthRequiredError } from "./auth.ts";

export function createModelTool(deps: { stateDir: () => string; apiBaseUrl: string }) {
  return {
    name: "ai8080_manage_models",
    description:
      "Manage AI model selection for 8080.ai builds. " +
      "Use this to list available models, check which one is active, or switch to a different model tier. " +
      "Models have different 'multipliers' representing their credit cost (e.g. 10x for Super Large).",
    parameters: Type.Object({
      action: Type.String({
        description: "The action to perform: 'list' (show available and active model) or 'set' (switch to a specific model).",
      }),
      modelId: Type.Optional(
        Type.String({
          description: "The ID of the model to switch to (e.g. 'large' or 'super_large'). Required for 'set' action.",
        })
      ),
    }),

    async execute(
      _id: string,
      params: { action: string; modelId?: string }
    ) {
      const stateDir = deps.stateDir();
      const { apiBaseUrl } = deps;

      // Ensure user is authenticated before allowing model management
      try {
        await requireAuthenticatedClient(stateDir, apiBaseUrl);
      } catch (err) {
        const msg = err instanceof AuthRequiredError 
          ? "🔒 Authentication required. Please log in first." 
          : "❌ Authentication failed. Please log in again.";
        return { content: [{ type: "text", text: msg }] };
      }

      const currentModel = await readActiveModel(stateDir);

      if (params.action === "set") {
        if (!params.modelId) {
          return {
            content: [{ type: "text", text: "Error: modelId is required when action is 'set'." }],
          };
        }

        const selected = MODEL_OPTIONS.find((m) => m.id === params.modelId);
        if (!selected) {
          const available = MODEL_OPTIONS.map((m) => m.id).join(", ");
          return {
            content: [{ type: "text", text: `Error: Invalid model ID "${params.modelId}". Available models: ${available}` }],
          };
        }

        await writeActiveModel(stateDir, selected.id as ModelTier);
        return {
          content: [{ type: "text", text: `✅ AI model switched to **${selected.label} (${selected.multiplier})**` }],
        };
      }

      // Default to 'list'
      const lines = MODEL_OPTIONS.map((m) => {
        const isActive = m.id === currentModel;
        const marker = isActive ? "👉" : "  ";
        return `${marker} ${m.label} (ID: ${m.id}, Cost: ${m.multiplier})`;
      });

      const text = `### 8080.ai AI Models:\n\n${lines.join("\n")}\n\nTo switch models, say "switch to [model name/ID]".`;

      return {
        content: [{ type: "text", text }],
      };
    },
  };
}
