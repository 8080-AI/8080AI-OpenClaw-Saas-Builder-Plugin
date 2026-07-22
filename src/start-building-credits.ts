import { ApiError } from "./api-client.ts";
import type { ModelTier } from "./model-state.ts";
import { getTaskArray } from "./task-summary.ts";
import { log } from "../logger.ts";

const MODEL_MULTIPLIERS: Record<ModelTier, number> = {
  large: 6,
  super_large: 10,
};

type CreditClient = {
  getCurrentUser(): Promise<Record<string, unknown>>;
  getProjectCreditSource?(projectId: string): Promise<Record<string, unknown> | null>;
};

type CreditCheckResult = {
  allowed: boolean;
  availableCredits?: number;
  requiredCredits: number;
  runnableTaskCount: number;
  billingSource?: string;
  message?: string;
};

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function getCreditSourceBalance(creditSource: Record<string, unknown> | null | undefined): {
  availableCredits?: number;
  billingSource?: string;
} {
  const billingSource = typeof creditSource?.credit_billing_source === "string"
    ? creditSource.credit_billing_source
    : undefined;

  if (billingSource === "org_credit") {
    return {
      billingSource,
      availableCredits: toNumber(creditSource?.org_credits_balance),
    };
  }

  return {
    billingSource,
    availableCredits: toNumber(creditSource?.own_credits_balance),
  };
}

export function calculateRequiredCredits(
  tasksData: unknown,
  selectedModel: ModelTier,
  selectedTaskIds: string[] = []
): { requiredCredits: number; runnableTaskCount: number } {
  const selected = new Set(selectedTaskIds.map(String));
  const multiplier = MODEL_MULTIPLIERS[selectedModel] ?? 1;
  const runnableTasks = getTaskArray(tasksData).filter((task) => {
    const id = task.id === undefined ? undefined : String(task.id);
    const isSelected = selected.size === 0 || (id !== undefined && selected.has(id));
    return isSelected && normalizeStatus(task.status) === "todo";
  });

  const requiredCredits = runnableTasks.reduce((sum, task) => {
    const promptCredit = toNumber((task as Record<string, unknown>).prompt_credit) ?? 0;
    return sum + (promptCredit * multiplier);
  }, 0);

  return {
    requiredCredits,
    runnableTaskCount: runnableTasks.length,
  };
}

export async function precheckStartBuildingCredits(
  client: CreditClient,
  projectId: string,
  tasksData: unknown,
  selectedModel: ModelTier,
  selectedTaskIds: string[] = [],
  siteUrl = "https://8080.ai"
): Promise<CreditCheckResult> {
  const { requiredCredits, runnableTaskCount } = calculateRequiredCredits(tasksData, selectedModel, selectedTaskIds);

  const [currentUser, creditSource] = await Promise.all([
    client.getCurrentUser().catch((err) => {
      log.info("start_building credit precheck current user failed", { projectId, message: err instanceof Error ? err.message : String(err) });
      return null;
    }),
    typeof client.getProjectCreditSource === "function"
      ? client.getProjectCreditSource(projectId).catch((err) => {
        log.info("start_building credit source precheck failed", { projectId, message: err instanceof Error ? err.message : String(err) });
        return null;
      })
      : Promise.resolve(null),
  ]);

  const sourceCredits = getCreditSourceBalance(creditSource);
  const availableCredits = sourceCredits.availableCredits ?? toNumber(currentUser?.credits_balance);

  log.info("start_building credit precheck", {
    projectId,
    selectedModel,
    selectedTaskIdsCount: selectedTaskIds.length,
    runnableTaskCount,
    requiredCredits,
    availableCredits,
    billingSource: sourceCredits.billingSource,
  });

  if (availableCredits === undefined) {
    return { allowed: true, requiredCredits, runnableTaskCount, billingSource: sourceCredits.billingSource };
  }

  if (availableCredits < requiredCredits) {
    return {
      allowed: false,
      availableCredits,
      requiredCredits,
      runnableTaskCount,
      billingSource: sourceCredits.billingSource,
      message: formatInsufficientCreditsMessage(requiredCredits, availableCredits, siteUrl),
    };
  }

  return {
    allowed: true,
    availableCredits,
    requiredCredits,
    runnableTaskCount,
    billingSource: sourceCredits.billingSource,
  };
}

export function formatInsufficientCreditsMessage(
  requiredCredits: unknown,
  availableCredits: unknown,
  siteUrl = "https://8080.ai"
): string {
  const required = toNumber(requiredCredits);
  const available = toNumber(availableCredits);

  return [
    "💳 **Add Credits**",
    "You do not have enough credits to start building this project.",
    required !== undefined ? `Required credits: **${required}**` : "",
    available !== undefined ? `Available credits: **${available}**` : "",
    `Add credits on 8080.ai, then click **Start Building** again: ${siteUrl.replace(/\/$/, "")}`,
  ].filter(Boolean).join("\n");
}

export function getInsufficientCreditsMessageFromError(err: unknown, siteUrl = "https://8080.ai"): string | undefined {
  if (!(err instanceof ApiError)) return undefined;

  const details = err.details;
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  if (record.error_code !== "INSUFFICIENT_CREDITS") return undefined;

  return formatInsufficientCreditsMessage(record.required_credits, record.available_credits, siteUrl);
}
