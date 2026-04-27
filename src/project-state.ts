import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_STATE_FILE = ["plugins", "8080", "project.json"];

type StoredProjectState = {
  activeProjectId: string;
  sessionId: string;
  updatedAt: number;
};

function statePath(stateDir: string): string {
  return path.join(stateDir, ...PROJECT_STATE_FILE);
}

export async function readActiveProject(stateDir: string, currentSessionId?: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(statePath(stateDir), "utf-8");
    const data = JSON.parse(raw) as StoredProjectState;
    // Only return active project if it was selected in the current session
    if (currentSessionId && data.sessionId !== currentSessionId) {
      return null;
    }
    return data.activeProjectId ?? null;
  } catch {
    return null;
  }
}

export async function writeActiveProject(
  stateDir: string,
  projectId: string,
  sessionId: string
): Promise<void> {
  const filePath = statePath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: StoredProjectState = {
    activeProjectId: projectId,
    sessionId,
    updatedAt: Date.now(),
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function clearActiveProject(stateDir: string): Promise<void> {
  try {
    await fs.unlink(statePath(stateDir));
  } catch {
    // already gone
  }
}
