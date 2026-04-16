import fs from "node:fs/promises";
import path from "node:path";

const AUTH_FILE = ["plugins", "8080", "auth.json"];

type StoredAuth = {
  token: string;
  storedAt: number;
  email?: string;
};

export class AuthRequiredError extends Error {
  constructor() {
    super("Not logged in. Run `/8080 login` to authenticate with 8080.ai.");
    this.name = "AuthRequiredError";
  }
}

function authPath(stateDir: string): string {
  return path.join(stateDir, ...AUTH_FILE);
}

export async function readToken(stateDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(authPath(stateDir), "utf-8");
    const data = JSON.parse(raw) as StoredAuth;
    return data.token ?? null;
  } catch {
    return null;
  }
}

export async function writeToken(
  stateDir: string,
  token: string,
  meta?: { email?: string }
): Promise<void> {
  const filePath = authPath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: StoredAuth = { token, storedAt: Date.now(), ...meta };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function clearToken(stateDir: string): Promise<void> {
  try {
    await fs.unlink(authPath(stateDir));
  } catch {
    // already gone — fine
  }
}

export async function requireToken(stateDir: string): Promise<string> {
  const token = await readToken(stateDir);
  if (!token) throw new AuthRequiredError();
  return token;
}
