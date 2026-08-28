/**
 * Single source of truth for turning token counts into an estimated cost, using
 * the display-only per-million pricing from Settings. Previously this formula
 * lived inline in lib/history.ts; it's extracted here so the run cockpit and the
 * sync-history timeline compute cost identically.
 *
 * Cost is only ever an estimate, and stays null unless BOTH per-token prices are
 * configured (and numeric) AND both token counts are present — the same guard
 * the history timeline has always used.
 */

/** The pricing half of ResolvedSettings (strings as stored; parsed here). */
export interface CostPricing {
  costPerMillionInput: string | null;
  costPerMillionOutput: string | null;
}

/** Estimated cost in USD, or null when pricing is unconfigured or usage is missing. */
export function estimateCostUsd(
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
  pricing: CostPricing,
): number | null {
  const priceIn = pricing.costPerMillionInput ? Number(pricing.costPerMillionInput) : null;
  const priceOut = pricing.costPerMillionOutput ? Number(pricing.costPerMillionOutput) : null;
  if (
    priceIn === null ||
    Number.isNaN(priceIn) ||
    priceOut === null ||
    Number.isNaN(priceOut) ||
    promptTokens == null ||
    completionTokens == null
  ) {
    return null;
  }
  return (promptTokens / 1_000_000) * priceIn + (completionTokens / 1_000_000) * priceOut;
}

/**
 * Same estimate expressed as integer micro-USD (1e-6 USD), for storing on
 * `runs.cost_estimate` / `run_steps.cost_estimate` without float drift. Null
 * when the estimate is unavailable.
 */
export function estimateCostMicroUsd(
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
  pricing: CostPricing,
): number | null {
  const usd = estimateCostUsd(promptTokens, completionTokens, pricing);
  return usd === null ? null : Math.round(usd * 1_000_000);
}
