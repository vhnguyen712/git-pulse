/**
 * Pure aggregation over a run's recorded step timeline — the "cost/tokens by
 * tool, by skill" attribution the cockpit surfaces (see docs/build-plan.md's
 * observability goals). Takes plain step rows so it has no DB/React
 * dependency and is trivially unit-testable.
 */

/** The subset of a run_steps row these aggregations need. */
export interface AttributionStep {
  type: string;
  tool?: string | null;
  skill?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costEstimate?: number | null;
}

export interface AttributionRow {
  /** Tool name, skill name, or step type this row aggregates. */
  key: string;
  tokens: number;
  /** Summed cost in micro-USD; null when no step in this group had a cost estimate. */
  costMicroUsd: number | null;
  count: number;
}

function aggregateBy(
  steps: AttributionStep[],
  keyOf: (step: AttributionStep) => string | null | undefined,
): AttributionRow[] {
  const rows = new Map<string, AttributionRow>();
  for (const step of steps) {
    const key = keyOf(step);
    if (!key) continue;
    const row = rows.get(key) ?? { key, tokens: 0, costMicroUsd: null, count: 0 };
    row.tokens += (step.promptTokens ?? 0) + (step.completionTokens ?? 0);
    if (step.costEstimate != null) row.costMicroUsd = (row.costMicroUsd ?? 0) + step.costEstimate;
    row.count += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.tokens - a.tokens || b.count - a.count);
}

/** Tokens/cost/step-count grouped by tool name (tool_use/tool_result steps). */
export function attributionByTool(steps: AttributionStep[]): AttributionRow[] {
  return aggregateBy(steps, (s) => s.tool);
}

/** Tokens/cost/step-count grouped by skill name (steps where a skill was active). */
export function attributionBySkill(steps: AttributionStep[]): AttributionRow[] {
  return aggregateBy(steps, (s) => s.skill);
}

/** Plain step-count grouped by step type — always available, even with no tools/skills. */
export function stepTypeCounts(steps: AttributionStep[]): AttributionRow[] {
  return aggregateBy(steps, (s) => s.type);
}
