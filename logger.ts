type OpenClawLogger = {
  info: (message: string) => void;
};

let openClawLogger: OpenClawLogger | undefined;

function debugLoggingEnabled(): boolean {
  return process.env.AI8080_DEBUG === "1" || process.env.AI8080_DEBUG === "true";
}

function formatArg(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(args: unknown[]): void {
  if (!debugLoggingEnabled()) return;

  const message = args.map(formatArg).join(" ");
  const formatted = `[8080.ai] ${message}`;

  if (openClawLogger) {
    openClawLogger.info(formatted);
    return;
  }

  process.stderr.write(`[8080.ai info] ${message}\n`);
}

export function configureLogger(logger: OpenClawLogger): void {
  openClawLogger = logger;
}

export const log = {
  info: (...args: unknown[]) => write(args),
};
