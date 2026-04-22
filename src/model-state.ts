import fs from "node:fs/promises";
import path from "node:path";

const MODEL_STATE_FILE = ["plugins", "8080", "model.json"];

// The two 8080.ai model tiers
export type ModelTier = "large" | "super_large";

export const MODEL_OPTIONS: { id: ModelTier; label: string; multiplier: string }[] = [
  { id: "large", label: "Large AI", multiplier: "6x" },
  { id: "super_large", label: "Super Large AI", multiplier: "10x" },
];

type StoredModelState = {
  activeModel: ModelTier;
  updatedAt: number;
};

function statePath(stateDir: string): string {
  return path.join(stateDir, ...MODEL_STATE_FILE);
}

export async function readActiveModel(stateDir: string): Promise<ModelTier> {
  try {
    const raw = await fs.readFile(statePath(stateDir), "utf-8");
    const data = JSON.parse(raw) as StoredModelState;
    return data.activeModel ?? "super_large";
  } catch {
    return "super_large"; // default
  }
}

export async function writeActiveModel(
  stateDir: string,
  model: ModelTier
): Promise<void> {
  const filePath = statePath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: StoredModelState = {
    activeModel: model,
    updatedAt: Date.now(),
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}
