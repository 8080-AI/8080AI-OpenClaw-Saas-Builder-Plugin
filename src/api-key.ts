import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.ts";

const API_KEY_FILE = ["plugins", "8080", "api-key.json"];
const OPENCLAW_API_KEY_PREFIX = "sk-8080ai-";
const OPENCLAW_API_KEY_PATTERN = /^sk-8080ai-[A-Za-z0-9_-]+$/;

const EXPIRATION_UNIT_MS = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
} as const;

type ApiKeyExpiration = string;

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

function parseExpirationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;

  const match = /^([1-9]\d*)([mhd])$/.exec(value.trim());
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof EXPIRATION_UNIT_MS;
  const durationMs = amount * EXPIRATION_UNIT_MS[unit];
  return Number.isSafeInteger(durationMs) ? durationMs : null;
}

function isApiKeyExpiration(value: unknown): value is ApiKeyExpiration {
  return parseExpirationMs(value) !== null;
}

function parseBase64Payload(candidate: string): Record<string, unknown> {
  let decoded: string;
  try {
    decoded = Buffer.from(candidate, "base64url").toString("utf-8");
  } catch {
    throw new ApiKeyInvalidError("Invalid API key payload encoding.");
  }

  try {
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    log.info("api_key decode json_parse_failed", {
      candidateLength: candidate.length,
      decodedLength: decoded.length,
      decodedStartsWithJson: decoded.trimStart().startsWith("{"),
    });
    throw new ApiKeyInvalidError("Invalid API key payload. Please check the key and try again.");
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

  if (!OPENCLAW_API_KEY_PATTERN.test(apiKey)) {
    log.info("api_key invalid_format", { keyLength: apiKey.length });
    throw new ApiKeyInvalidError("Invalid API key format. Expected sk-8080ai- followed by one Base64URL payload.");
  }

  const encodedPayload = apiKey.slice(OPENCLAW_API_KEY_PREFIX.length);
  if (!encodedPayload || encodedPayload.includes(OPENCLAW_API_KEY_PREFIX)) {
    log.info("api_key invalid_payload_segment", {
      payloadLength: encodedPayload.length,
      hasNestedPrefix: encodedPayload.includes(OPENCLAW_API_KEY_PREFIX),
    });
    throw new ApiKeyInvalidError("Invalid API key format. Provide exactly one sk-8080ai- key.");
  }

  const payload = parseBase64Payload(encodedPayload);

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

  const expirationMs = parseExpirationMs(payload.exp);
  if (expirationMs === null) {
    throw new ApiKeyInvalidError("Invalid API key expiration.");
  }

  const expiresAt = issuedAt + expirationMs;
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
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  log.info("api_key saved", {
    uid: meta.uid,
    issuedAt: meta.issuedAt,
    expiresAt: meta.expiresAt,
    keyLength: apiKey.length,
  });
}
