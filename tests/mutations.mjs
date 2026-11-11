import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cases = [
	["token-cap", "extensions/goal-accounting.ts", "remaining !== null && remaining === 0", "false", "computes remaining and reached", "goal-accounting-runtime"],
	["invalid-token-cap", "extensions/goal-accounting.ts", "goal.tokenBudget <= 0", "goal.tokenBudget < 0", "ignores non-positive budgets", "goal-accounting-runtime"],
	["stale-completion", "extensions/goal-policy.ts", "runningGoalId && goal.id !== runningGoalId", "false", "goal lifecycle completion gates", "goal-policy"],
	["completion-status", "extensions/goal-policy.ts", "if (!isCompletableStatus(goal.status))", "if (false)", "goal lifecycle completion gates", "goal-policy"],
	["blocked-status", "extensions/goal-policy.ts", "if (goal.status !== \"active\") {\n\t\treturn { ok: false, message: `Goal is ${statusLabel(goal)}; update_goal(blocked)", "if (false) {\n\t\treturn { ok: false, message: `Goal is ${statusLabel(goal)}; update_goal(blocked)", "update_goal\\(blocked\\) policy", "goal-policy"],
	["resume-complete", "extensions/goal-policy.ts", "if (goal.status === \"complete\") return { ok: false, message: \"Goal is complete.", "if (false) return { ok: false, message: \"Goal is complete.", "resume and clear policy", "goal-policy"],
	["property-task-pending-skipped", "extensions/goal-task-count.ts", `pending: total - rawComplete - rawSkipped,`, `pending: total - done,`, "property task counts partition", "goal-properties"],
	["regression-block-gate-skipped", "extensions/goal-task-count.ts", `pending: total - rawComplete - rawSkipped,`, `pending: total - done,`, "regression a block gate", "goal-properties"],
	["property-null-task-entry", "extensions/goal-record.ts", `.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? normalizeTaskItem(item as Record<string, unknown>) : undefined))`, `.map((item) => (item && typeof item !== "object" || Array.isArray(item) ? undefined : normalizeTaskItem(item as Record<string, unknown>)))`, "property persisted task list", "goal-properties"],
	["regression-null-task-entry", "extensions/goal-record.ts", `.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? normalizeTaskItem(item as Record<string, unknown>) : undefined))`, `.map((item) => (item && typeof item !== "object" || Array.isArray(item) ? undefined : normalizeTaskItem(item as Record<string, unknown>)))`, "regression a null entry", "goal-properties"],
	["property-clock-step-back", "extensions/goal-accounting.ts", `this.lastAccountedAt = last === null ? now : Math.max(last, now);`, `this.lastAccountedAt = now;`, "property a clock stepping back", "goal-properties"],
	["regression-clock-step-back", "extensions/goal-accounting.ts", `this.lastAccountedAt = last === null ? now : Math.max(last, now);`, `this.lastAccountedAt = now;`, "regression a clock stepping back", "goal-properties"],
	["property-unknown-status-active", "extensions/goal-record.ts", `return GOAL_STATUSES.find((status) => status === text) ?? "paused";`, `return GOAL_STATUSES.find((status) => status === text) ?? "active";`, "property persisted status is kept", "goal-properties"],
	["property-queue-without-active", "extensions/goal-policy.ts", `return !!goal && goal.status === "active" && goal.autoContinue;`, `return !!goal && goal.autoContinue;`, "property status action matrix", "goal-properties"],
	["property-complete-resumable", "extensions/goal-policy.ts", `if (goal.status === "complete") return { ok: false, message: "Goal is complete. Use /goal to draft`, `if (false) return { ok: false, message: "Goal is complete. Use /goal to draft`, "property status action matrix", "goal-properties"],
	["property-corrupt-scheduler-resets", "extensions/goal-scheduler-state.ts", `used: Number.MAX_SAFE_INTEGER`, `used: 0`, "property persisted scheduler", "goal-properties"],
	["property-budget-one-early", "extensions/goal-accounting.ts", `return remaining !== null && remaining === 0;`, `return remaining !== null && remaining <= 1;`, "property token budget", "goal-properties"],
	["property-invalid-run-limit-lifts-cap", "extensions/goal-run-budget.ts", `return validateRunLimit(value) ? 0 : value as number | null | undefined;`, `return value as number | null | undefined;`, "property persisted run limit", "goal-properties"],
	["property-backoff-ladder-shift", "extensions/network-error-backoff.ts", `NETWORK_ERROR_BACKOFF_DELAYS_MS[Math.min(attempt - 1, last)]!`, `NETWORK_ERROR_BACKOFF_DELAYS_MS[Math.min(attempt, last)]!`, "property network recovery ladder", "goal-properties"],
	["property-skip-leaves-pending-below", "extensions/goal-policy.ts", `return skipAllSubtasks(skipped, now, reason);`, `return skipped;`, "property skipping subtasks", "goal-properties"],
	["status-line-widget-only-when-running", "extensions/goal-status-line.ts", `if (!goal || goal.status !== "active" || !goal.autoContinue) return null;`, `if (!goal) return null;`, "focused paused goal", "goal-compact-status"],
	["status-line-event-repeat", "extensions/goal-state.ts", `if (key === lastPublishedStatus) return;`, `if (false) return;`, "fires on every change and not on repeats", "goal-compact-status"],
	["status-line-title-cut", "extensions/goal-status-line.ts", "const TITLE_MAX = 40;", "const TITLE_MAX = 400;", "title cut at 40", "goal-compact-status"],
];

for (const [name, file, before, after, pattern, testFile] of cases) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-mutant-"));
	try {
		cpSync(join(root, "extensions"), join(dir, "extensions"), { recursive: true });
		cpSync(join(root, "tests"), join(dir, "tests"), { recursive: true });
		cpSync(join(root, "package.json"), join(dir, "package.json"));
		symlinkSync(resolve(root, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
		const path = join(dir, file);
		const source = readFileSync(path, "utf8");
		assert.equal(source.split(before).length, 2, `${name}: mutation must match exactly once`);
		writeFileSync(path, source.replace(before, after));
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", `--test-name-pattern=${pattern}`, `tests/${testFile}.test.ts`], { cwd: dir, encoding: "utf8", timeout: 30000 });
		assert.equal(result.error, undefined, `${name}: process must run without timing out`);
		assert.notEqual(result.status, 0, `${name}: survived`);
		assert.match(result.stdout + result.stderr, /AssertionError/, `${name}: must fail an assertion`);
		console.log(`${name}: killed by assertion`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
console.log(`${cases.length}/${cases.length} boundary mutants killed; disposable copies only`);
