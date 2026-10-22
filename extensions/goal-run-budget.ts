import type { GoalRecord } from "./goal-record.ts";

export const DEFAULT_GOAL_RUNS = 30;

/** Missing historical overrides inherit settings; null explicitly means unlimited. */
export function effectiveRunLimit(goal: Pick<GoalRecord, "maxAutonomousRuns"> | null | undefined, configured?: number): number | undefined {
	return goal?.maxAutonomousRuns === null ? undefined : goal?.maxAutonomousRuns ?? configured;
}

export function newGoalRunLimit(requested: number | null | undefined, configured?: number): number | null | undefined {
	if (requested !== undefined) return requested;
	// Preserve settings inheritance when an operator already configured a limit.
	return configured === undefined ? DEFAULT_GOAL_RUNS : undefined;
}

export function validateRunLimit(value: unknown): string | undefined {
	return value === undefined || value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
		? undefined : "max_autonomous_runs must be a nonnegative safe integer, or null for unlimited.";
}

export function formatRunLimit(value: number | null | undefined): string {
	return `Autonomous runs: ${value ?? "unlimited"}${value === 0 ? " (automatic continuation disabled)" : ""}. Counts extension-scheduled runs, not tool calls. Resuming renews the run allowance; token usage is lifetime usage.`;
}

/** Settings label: an unset allowance gives new goals the default; earlier goals without an override inherit the configured allowance (unlimited if none). Callers append "(default)" provenance. */
export function formatConfiguredRunAllowance(configured: number | undefined): string {
	return configured === 0 ? "0 (disabled)" : configured === undefined ? `${DEFAULT_GOAL_RUNS} for new goals` : String(configured);
}

export function proposalRunLimitLabel(value: number | null | undefined, tweaking: boolean): string {
	const error = validateRunLimit(value);
	if (error) return error;
	if (value !== undefined) return formatRunLimit(value);
	return tweaking ? "Autonomous runs: retain current allowance." : "Autonomous runs: configured default, otherwise 30.";
}

/** Invalid persisted overrides disable continuation instead of removing the cap. */
export function normalizeRunLimit(value: unknown): number | null | undefined {
	return validateRunLimit(value) ? 0 : value as number | null | undefined;
}
