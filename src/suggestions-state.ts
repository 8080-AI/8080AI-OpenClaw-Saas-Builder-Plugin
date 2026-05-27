import fs from "node:fs/promises";
import path from "node:path";

export type ProjectSuggestions = {
  projectId: string;
  messageId: string;
  agents: string[];
};

/**
 * Stores the latest suggestions to a file in the state directory.
 * Used so the /ai8080 select-button command knows what '1', '2', etc. refer to.
 */
export async function writeLatestSuggestions(
  stateDir: string,
  sessionId: string,
  suggestions: ProjectSuggestions
): Promise<void> {
  const filePath = path.join(stateDir, `suggestions-${sessionId}.json`);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(suggestions, null, 2), "utf-8");
}

/**
 * Reads the latest suggestions for the current session.
 */
export async function readLatestSuggestions(
  stateDir: string,
  sessionId: string
): Promise<ProjectSuggestions | null> {
  const filePath = path.join(stateDir, `suggestions-${sessionId}.json`);
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as ProjectSuggestions;
  } catch {
    return null;
  }
}
