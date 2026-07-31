import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.ts";

const API_KEY_FILE = ["plugins", "8080", "api-key.json"];
const OPENCLAW_API_KEY_PREFIX = "sk-8080ai-";

const EXPIRATION_DAYS = {
  "15d": 15,
  "30d": 30,
  "90d": 90,
} as const;

type ApiKeyExpiration = keyof typeof EXPIRATION_DAYS;

type ApiKeyPayload = {
  uid: string;
  ts: string;
  exp?: ApiKeyExpiration;
};

type StoredApiKey = {
  apiKey: string;
  uid: string;
  issuedAt: number;
  expiresAt: number | null;
  storedAt: number;
};

export class ApiKeyExpiredError extends Error {
  constructor() {
    super("The API key is expired. Visit 8080.ai and generate a new api-key.");
    this.name = "ApiKeyExpiredError";
  }
}

export class ApiKeyInvalidError extends Error {
  constructor(message = "Invalid API key. Please check the key and try again.") {
    super(message);
    this.name = "ApiKeyInvalidError";
  }
}

function apiKeyPath(stateDir: string): string {
  return path.join(stateDir, ...API_KEY_FILE);
}

// Security: log only API-key metadata such as lengths, timestamps, and expiry state.
// Never log the full key, decoded key material, or stored credential payload.
export function cleanApiKey(value: string | undefined): string {
  const cleaned = value
    ?.trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^api[-_ ]?key:\s*/i, "")
    .replace(/\s+/g, "") ?? "";
  log.info("api_key clean", {
    provided: Boolean(value),
    originalLength: value?.length ?? 0,
    cleanedLength: cleaned.length,
  });
  return cleaned;
}

function isApiKeyExpiration(value: unknown): value is ApiKeyExpiration {
  return typeof value === "string" && Object.hasOwn(EXPIRATION_DAYS, value);
}

function apiKeyPayloadCandidates(apiKey: string): string[] {
  return [apiKey.slice(OPENCLAW_API_KEY_PREFIX.length)].filter(Boolean);
}

function parseBase64Payload(candidate: string): Record<string, unknown> | null {
  let decoded: string;
  try {
    decoded = Buffer.from(candidate, "base64url").toString("utf-8");
  } catch {
    return null;
  }

  try {
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    log.info("api_key decode candidate_json_parse_failed", {
      candidateLength: candidate.length,
      decodedLength: decoded.length,
      decodedStartsWithJson: decoded.trimStart().startsWith("{"),
    });
    return null;
  }
}

export function decodeApiKey(apiKey: string): ApiKeyPayload {
  log.info("api_key decode start", { keyLength: apiKey.length });
  if (!apiKey.startsWith(OPENCLAW_API_KEY_PREFIX)) {
    log.info("api_key invalid_prefix", {
      expectedPrefix: OPENCLAW_API_KEY_PREFIX,
      keyLength: apiKey.length,
    });
    throw new ApiKeyInvalidError("Invalid OpenClaw API key prefix.");
  }

  const candidates = apiKeyPayloadCandidates(apiKey);
  log.info("api_key decode candidates", {
    count: candidates.length,
    lengths: candidates.map((candidate) => candidate.length),
  });

  const payload = candidates
    .map((candidate) => parseBase64Payload(candidate))
    .find((candidatePayload): candidatePayload is Record<string, unknown> => Boolean(candidatePayload));

  if (!payload) {
    log.info("api_key decode all_candidates_failed");
    throw new ApiKeyInvalidError("Invalid API key payload. Please check the key and try again.");
  }

  log.info("api_key decoded payload", {
    hasUid: typeof payload.uid === "string" && Boolean(payload.uid.trim()),
    ts: typeof payload.ts === "string" ? payload.ts : undefined,
    exp: payload.exp,
  });

  if (typeof payload.uid !== "string" || !payload.uid.trim()) {
    throw new ApiKeyInvalidError("Invalid API key. Missing user id.");
  }

  if (typeof payload.ts !== "string" || !payload.ts.trim()) {
    throw new ApiKeyInvalidError("Invalid API key. Missing timestamp.");
  }

  if (payload.exp !== undefined && !isApiKeyExpiration(payload.exp)) {
    throw new ApiKeyInvalidError("Invalid API key expiration.");
  }

  return {
    uid: payload.uid,
    ts: payload.ts,
    exp: payload.exp,
  };
}

export function validateApiKeyPayload(payload: ApiKeyPayload): {
  uid: string;
  issuedAt: number;
  expiresAt: number | null;
} {
  const issuedAt = Date.parse(payload.ts);
  log.info("api_key validate timestamp", {
    uid: payload.uid,
    ts: payload.ts,
    exp: payload.exp ?? "never",
    issuedAt,
  });
  if (!Number.isFinite(issuedAt)) {
    throw new ApiKeyInvalidError("Invalid API key timestamp.");
  }

  if (!payload.exp) {
    log.info("api_key validate success", {
      uid: payload.uid,
      issuedAt,
      expiresAt: null,
      expiresInMs: null,
    });
    return { uid: payload.uid, issuedAt, expiresAt: null };
  }

  const expiresAt = issuedAt + EXPIRATION_DAYS[payload.exp] * 24 * 60 * 60 * 1000;
  log.info("api_key validate expiry", {
    uid: payload.uid,
    exp: payload.exp,
    now: Date.now(),
    issuedAt,
    expiresAt,
    expiresInMs: expiresAt - Date.now(),
  });
  if (Date.now() > expiresAt) {
    log.info("api_key validate expired", {
      uid: payload.uid,
      exp: payload.exp,
      issuedAt,
      expiresAt,
    });
    throw new ApiKeyExpiredError();
  }

  log.info("api_key validate success", {
    uid: payload.uid,
    issuedAt,
    expiresAt,
    expiresInMs: expiresAt - Date.now(),
  });
  return { uid: payload.uid, issuedAt, expiresAt };
}

export function validateApiKey(apiKey: string): {
  uid: string;
  issuedAt: number;
  expiresAt: number | null;
} {
  log.info("api_key validate start", {
    hasRequiredPrefix: apiKey.startsWith(OPENCLAW_API_KEY_PREFIX),
    keyLength: apiKey.length,
  });
  const meta = validateApiKeyPayload(decodeApiKey(apiKey));
  log.info("api_key validate complete", {
    uid: meta.uid,
    issuedAt: meta.issuedAt,
    expiresAt: meta.expiresAt,
    keyLength: apiKey.length,
  });
  return meta;
}

export async function readApiKey(stateDir: string): Promise<StoredApiKey | null> {
  try {
    const raw = await fs.readFile(apiKeyPath(stateDir), "utf-8");
    const data = JSON.parse(raw) as StoredApiKey;
    log.info("api_key read", {
      found: true,
      uid: data.uid,
      issuedAt: data.issuedAt,
      expiresAt: data.expiresAt,
      keyLength: data.apiKey?.length ?? 0,
    });
    if (!data.apiKey || !data.uid || typeof data.issuedAt !== "number") {
      log.info("api_key read invalid_stored_shape");
      return null;
    }
    const meta = validateApiKey(data.apiKey);
    if (
      data.uid !== meta.uid ||
      data.issuedAt !== meta.issuedAt ||
      data.expiresAt !== meta.expiresAt
    ) {
      log.info("api_key read metadata_mismatch", {
        storedUid: data.uid,
        decodedUid: meta.uid,
        storedIssuedAt: data.issuedAt,
        decodedIssuedAt: meta.issuedAt,
        storedExpiresAt: data.expiresAt,
        decodedExpiresAt: meta.expiresAt,
      });
      throw new ApiKeyInvalidError("Stored API key metadata does not match the API key payload.");
    }
    if (data.expiresAt !== null && Date.now() > data.expiresAt) {
      log.info("api_key read expired", {
        uid: data.uid,
        expiresAt: data.expiresAt,
        now: Date.now(),
      });
      throw new ApiKeyExpiredError();
    }
    return data;
  } catch (err) {
    if (err instanceof ApiKeyExpiredError) throw err;
    log.info("api_key read none_or_failed", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function writeApiKey(
  stateDir: string,
  apiKey: string,
  meta: { uid: string; issuedAt: number; expiresAt: number | null }
): Promise<void> {
  const filePath = apiKeyPath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: StoredApiKey = { apiKey, ...meta, storedAt: Date.now() };
  // Security: persist the credential only in local OpenClaw plugin state with owner-only file permissions.
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  log.info("api_key saved", {
    uid: meta.uid,
    issuedAt: meta.issuedAt,
    expiresAt: meta.expiresAt,
    keyLength: apiKey.length,
  });
}
