import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.ts";

export type ProjectSuggestions = {
  projectId: string;
  messageId: string;
  agents: string[];
  buttons?: any[];
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
  const latestPath = path.join(stateDir, "suggestions-latest.json");
  const projectPath = path.join(stateDir, `suggestions-project-${suggestions.projectId}.json`);
  await fs.mkdir(stateDir, { recursive: true });
  const payload = JSON.stringify(suggestions, null, 2);
  await Promise.all([
    fs.writeFile(filePath, payload, "utf-8"),
    fs.writeFile(latestPath, payload, "utf-8"),
    fs.writeFile(projectPath, payload, "utf-8"),
  ]);
  log.info("suggestions-state write", {
    sessionId,
    filePath,
    latestPath,
    projectPath,
    projectId: suggestions.projectId,
    agents: suggestions.agents,
    messageId: suggestions.messageId,
  });
}

/**
 * Reads the latest suggestions for the current session.
 */
export async function readLatestSuggestions(
  stateDir: string,
  sessionId: string
): Promise<ProjectSuggestions | null> {
  const filePath = path.join(stateDir, `suggestions-${sessionId}.json`);
  const latestPath = path.join(stateDir, "suggestions-latest.json");
  const candidates = [filePath, latestPath];

  for (const candidatePath of candidates) {
    try {
      const data = await fs.readFile(candidatePath, "utf-8");
      const suggestions = JSON.parse(data) as ProjectSuggestions;
      log.info("suggestions-state read", {
        sessionId,
        filePath: candidatePath,
        projectId: suggestions.projectId,
        agents: suggestions.agents,
        messageId: suggestions.messageId,
      });
      return suggestions;
    } catch {
      log.info("suggestions-state read missing candidate", { sessionId, filePath: candidatePath });
    }
  }

  log.info("suggestions-state read missing", { sessionId, filePath, latestPath });
  return null;
}

export async function readLatestSuggestionsForProject(
  stateDir: string,
  sessionId: string,
  projectId: string
): Promise<ProjectSuggestions | null> {
  const filePath = path.join(stateDir, `suggestions-${sessionId}.json`);
  const projectPath = path.join(stateDir, `suggestions-project-${projectId}.json`);
  const latestPath = path.join(stateDir, "suggestions-latest.json");
  const candidates = [filePath, projectPath, latestPath];

  for (const candidatePath of candidates) {
    try {
      const data = await fs.readFile(candidatePath, "utf-8");
      const suggestions = JSON.parse(data) as ProjectSuggestions;
      if (suggestions.projectId !== projectId) {
        log.info("suggestions-state read skipped project mismatch", {
          sessionId,
          filePath: candidatePath,
          expectedProjectId: projectId,
          actualProjectId: suggestions.projectId,
        });
        continue;
      }
      log.info("suggestions-state read", {
        sessionId,
        filePath: candidatePath,
        projectId: suggestions.projectId,
        agents: suggestions.agents,
        messageId: suggestions.messageId,
      });
      return suggestions;
    } catch {
      log.info("suggestions-state read missing candidate", { sessionId, filePath: candidatePath });
    }
  }

  log.info("suggestions-state read missing", { sessionId, filePath, projectPath, latestPath, projectId });
  return null;
}

/**
 * Marks a completed/cancelled auto-run as consumed in locally cached
 * suggestions. Its payload label remains available for the manual action,
 * while Wait is no longer offered because the entry is not scheduled.
 */
export async function consumeAutoRunSuggestion(
  stateDir: string,
  sessionId: string,
  projectId: string,
  entryId: string
): Promise<boolean> {
  const suggestions = await readLatestSuggestionsForProject(stateDir, sessionId, projectId);
  if (!suggestions?.buttons) return false;

  let found = false;
  const buttons = suggestions.buttons.map((button) => {
    if (button?.kind !== "auto_run" || button?.payload?.entry_id !== entryId) return button;
    found = true;
    return { ...button, payload: { ...button.payload, status: "cancelled" } };
  });
  if (!found) return false;

  await writeLatestSuggestions(stateDir, sessionId, { ...suggestions, buttons });
  log.info("suggestions-state consumed auto-run", { sessionId, projectId, entryId });
  return true;
}
