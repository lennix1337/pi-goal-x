import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCompletionReport } from "../extensions/goal-policy.ts";
import { createGoal } from "../extensions/goal-record.ts";
import {
	archiveGoalFile,
	readActiveGoalFiles,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

interface TestContext {
	cwd: string;
}

function tempCtx(): TestContext {
	return { cwd: mkdtempSync(path.join(tmpdir(), "goal-deferred-archival-test-")) };
}

function cleanup(ctx: TestContext): void {
	try {
		rmSync(ctx.cwd, { recursive: true, force: true });
	} catch {
	}
}

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		...createGoal({
			objective: "Deferred archival test goal",
			autoContinue: true,
			sisyphus: false,
		}, Date.UTC(2026, 5, 2, 10, 0, 0)),
		...overrides,
	};
}

function fileExists(filePath: string): boolean {
	try {
		readFileSync(filePath);
		return true;
	} catch {
		return false;
	}
}

test("deferred archival lifecycle via writeActiveGoalFile then archiveGoalFile", () => {
	const ctx = tempCtx();
	try {
		const goal = makeGoal();
		const active = writeActiveGoalFile(ctx, goal);
		assert.match(active.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(active.archivedPath, undefined, "fresh goal should not have archivedPath");

		const poolBefore = readActiveGoalPool(ctx);
		assert.ok(poolBefore.has(goal.id), "goal should be in active pool before completion");

		const completed = writeActiveGoalFile(ctx, { ...active, status: "complete" as const });
		assert.match(completed.activePath ?? "", /^\.pi\/goals\/active_goal_/, "complete goal should still have activePath (deferred)");
		assert.equal(completed.archivedPath, undefined, "complete goal should NOT have archivedPath yet (deferred)");

		const diskContent = readFileSync(path.join(ctx.cwd, completed.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes('"status": "complete"'), "active file on disk must have status: complete");

		const poolDeferred = readActiveGoalPool(ctx);
		assert.equal(poolDeferred.has(goal.id), false, "complete goal should NOT be in active pool (readActiveGoalFiles filters complete)");

		const archiveDir = path.join(ctx.cwd, ".pi", "goals", "archived");
		assert.equal(fileExists(path.join(archiveDir, path.basename(completed.archivedPath ?? "null"))), false,
			"goal should NOT be in archive dir yet");

		const archived = archiveGoalFile(ctx, completed);
		assert.equal(archived.activePath, undefined, "archived goal should not have activePath");
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/, "archived goal must have archivedPath in archive dir");

		assert.equal(fileExists(path.join(ctx.cwd, completed.activePath ?? "missing")), false,
			"active file should be removed after archival");

		assert.ok(fileExists(path.join(ctx.cwd, archived.archivedPath ?? "missing")),
			"archived file should exist on disk");

		const activeFiles = readActiveGoalFiles(ctx);
		const ids = activeFiles.map((g) => g.id);
		assert.equal(ids.includes(goal.id), false, "goal should not appear in active files after archival");
	} finally {
		cleanup(ctx);
	}
});

test("approval path: buildCompletionReport includes auditor report", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Audit approval test\nStatus: active",
		auditorReport: "Auditor: I have verified all requirements.\n\n<approved/>",
	});
	assert.ok(report.includes("Goal audit approved."), "approval path must say 'Goal audit approved.'");
	assert.ok(report.includes("<approved/>"), "approval path must include the approval marker from the auditor");
	assert.ok(report.includes("Auditor: I have verified all requirements."), "approval path must include full auditor output");
	assert.ok(report.includes("Goal complete."), "approval path must conclude with 'Goal complete.'");
});

test("disabled-bypass path: buildCompletionReport includes auditSkippedReason", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Disabled bypass test\nStatus: active",
		auditSkippedReason: "auditor disabled in settings",
	});
	assert.ok(report.includes("Goal audit skipped."), "disabled-bypass path must say 'Goal audit skipped.'");
	assert.ok(report.includes("auditor disabled in settings"), "disabled-bypass must include the skip reason");
	assert.ok(report.includes("Goal complete."), "disabled-bypass path must conclude with 'Goal complete.'");
	assert.ok(!report.includes("<approved/>"), "disabled-bypass must NOT include approval marker");
	assert.ok(!report.includes("Auditor approval:"), "disabled-bypass must NOT include auditor approval section");
});

test("Esc-skip path: buildCompletionReport includes Esc-abort reason", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Esc abort test\nStatus: active",
		auditSkippedReason: "auditor bypassed (user pressed Escape during audit)",
	});
	assert.ok(report.includes("Goal audit skipped."), "Esc-skip path must say 'Goal audit skipped.'");
	assert.ok(report.includes("auditor bypassed (user pressed Escape during audit)"), "Esc-skip must include the Esc-specific reason");
	assert.ok(report.includes("Goal complete."), "Esc-skip path must conclude with 'Goal complete.'");
});

test("all three paths produce distinct tool output text", () => {
	const baseSummary = "Goal: Distinct output test\nStatus: active";
	const commonDetailed = "Goal: Distinct output test\nStatus: active";

	const approval = buildCompletionReport({
		detailedSummary: commonDetailed,
		auditorReport: "Inspected and verified.\n\n<approved/>",
	});
	const disabled = buildCompletionReport({
		detailedSummary: commonDetailed,
		auditSkippedReason: "auditor disabled in settings",
	});
	const esc = buildCompletionReport({
		detailedSummary: commonDetailed,
		auditSkippedReason: "auditor bypassed (user pressed Escape during audit)",
	});

	assert.ok(approval.includes("Goal audit approved."), "approval: header must be 'Goal audit approved.'");
	assert.ok(disabled.includes("Goal audit skipped."), "disabled-bypass: header must be 'Goal audit skipped.'");
	assert.ok(esc.includes("Goal audit skipped."), "esc-skip: header must be 'Goal audit skipped.'");
	assert.ok(disabled.includes("auditor disabled in settings"), "disabled-bypass: reason must be specific");
	assert.ok(esc.includes("auditor bypassed (user pressed Escape during audit)"), "esc-skip: reason must be specific");
	assert.ok(!approval.includes("Goal audit skipped."), "approval must not say 'skipped'");

	assert.ok(!disabled.includes("<approved/>"), "disabled-bypass must not include approval marker");
	assert.ok(!esc.includes("<approved/>"), "esc-skip must not include approval marker");
});

test("readActiveGoalFiles filters complete goals regardless of archivedPath", () => {
	const ctx = tempCtx();
	try {
		const goal = makeGoal({ id: "complete-filter-test" });
		const active = writeActiveGoalFile(ctx, goal);
		assert.ok(readActiveGoalPool(ctx).has("complete-filter-test"), "active goal should be in pool");

		const completeButNotArchived = writeActiveGoalFile(ctx, { ...active, status: "complete" as const });
		assert.match(completeButNotArchived.activePath ?? "", /^\.pi\/goals\/active_goal_/);

		const pool = readActiveGoalPool(ctx);
		assert.equal(pool.has("complete-filter-test"), false, "complete goal should be filtered from pool even if not archived");

		archiveGoalFile(ctx, completeButNotArchived);
		const poolAfter = readActiveGoalPool(ctx);
		assert.equal(poolAfter.has("complete-filter-test"), false, "archived goal should not be in pool");
	} finally {
		cleanup(ctx);
	}
});

test("detect complete-but-not-archived goal for turn_end archival", () => {
	const ctx = tempCtx();
	try {
		const goal = makeGoal({ id: "pending-archival-detect" });
		const active = writeActiveGoalFile(ctx, goal);
		const deferred = writeActiveGoalFile(ctx, { ...active, status: "complete" as const });

		assert.equal(deferred.status, "complete");
		assert.equal(deferred.archivedPath, undefined);
		assert.match(deferred.activePath ?? "", /^\.pi\/goals\/active_goal_/);

		const archResult = archiveGoalFile(ctx, deferred);
		assert.equal(archResult.activePath, undefined, "after archival, activePath must be removed");
		assert.match(archResult.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/, "after archival, archivedPath must be set");
	} finally {
		cleanup(ctx);
	}
});
