export class ConfigError extends Error {
  override name = "ConfigError";
}

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class QuotaError extends Error {
  override name = "QuotaError";
}

export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
}

export const isAbortError = (e: unknown): boolean =>
  e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
