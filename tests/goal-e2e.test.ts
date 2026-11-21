import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCompletionReport } from "../extensions/goal-policy.ts";
import { createGoal } from "../extensions/goal-record.ts";
import {
	archiveGoalFile,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

interface TestContext {
	cwd: string;
}

function tempCtx(): TestContext {
	return { cwd: mkdtempSync(path.join(tmpdir(), "goal-e2e-test-")) };
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
			objective: "Initial objective for e2e test",
			autoContinue: true,
			sisyphus: false,
		}, Date.UTC(2026, 5, 26, 8, 0, 0)),
		...overrides,
	};
}

function readGoalFile(ctx: TestContext, goal: GoalRecord): string {
	return readFileSync(path.join(ctx.cwd, goal.activePath ?? "missing"), "utf8");
}

function readArchivedFile(ctx: TestContext, goal: GoalRecord): string {
	return readFileSync(path.join(ctx.cwd, goal.archivedPath ?? "missing"), "utf8");
}


test("sequential quick-syncs: two updates, only latest objective on disk", () => {
	const ctx = tempCtx();
	try {
		const obj1 = "First objective";
		const obj2 = "Second objective after more drift";
		const obj3 = "Third objective — final version";

		const goal = makeGoal({ objective: obj1 });
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.objective, obj1);

		const after1 = writeActiveGoalFile(ctx, { ...active, objective: obj2 });
		assert.equal(after1.objective, obj2);
		assert.equal(after1.status, "active");

		const after2 = writeActiveGoalFile(ctx, { ...after1, objective: obj3 });
		assert.equal(after2.objective, obj3);
		assert.equal(after2.status, "active");

		const disk = readGoalFile(ctx, after2);
		assert.ok(!disk.includes(obj1), "obj1 should not be on disk");
		assert.ok(!disk.includes(obj2), "obj2 should not be on disk");
		assert.ok(disk.includes(obj3), "obj3 should be on disk");

		assert.ok(readActiveGoalPool(ctx).has(goal.id));

		assert.equal(after2.activePath, active.activePath);
	} finally {
		cleanup(ctx);
	}
});


test("quick-sync then later complete: archived file has updated objective", () => {
	const ctx = tempCtx();
	try {
		const originalObj = "Original objective";
		const updatedObj = "Updated objective after requirements changed";

		const goal = makeGoal({ objective: originalObj });
		const active = writeActiveGoalFile(ctx, goal);

		const synced = writeActiveGoalFile(ctx, { ...active, objective: updatedObj });
		assert.equal(synced.objective, updatedObj);
		assert.equal(synced.status, "active");
		assert.equal(synced.archivedPath, undefined);

		const completed = writeActiveGoalFile(ctx, {
			...synced,
			status: "complete" as const,
			stopReason: "agent" as const,
			updatedAt: new Date().toISOString(),
		});
		assert.equal(completed.objective, updatedObj, "completed file must have updated objective");
		assert.equal(completed.status, "complete");
		assert.match(completed.activePath ?? "", /^\.pi\/goals\/active_goal_/,
			"deferred archival: should still be in active dir");
		assert.equal(completed.archivedPath, undefined, "deferred archival: not archived yet");

		const archived = archiveGoalFile(ctx, completed);
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);

		const archivedContent = readArchivedFile(ctx, archived);
		assert.ok(archivedContent.includes(updatedObj),
			"archived file must have the updated objective (not the original)");
		assert.ok(!archivedContent.includes(originalObj),
			"archived file must NOT have the original objective");
		assert.ok(archivedContent.includes('"status": "complete"'),
			"archived file must have complete status");
	} finally {
		cleanup(ctx);
	}
});


test("sync + approval path: report includes new objective and approval", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Build feature X\nUpdated objective: Build feature Y\nStatus: active",
		auditorReport: "Inspected and verified.\n\n<approved/>",
	});
	assert.ok(report.includes("Goal audit approved."), "must say approved");
	assert.ok(report.includes("<approved/>"), "must include approval marker");
	assert.ok(report.includes("Goal complete."), "must conclude with Goal complete.");
	assert.ok(report.includes("Build feature Y"), "must reference the updated objective");
});


test("sync + disabled bypass: report includes new objective and skip reason", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Build feature X\nUpdated objective: Build feature Y\nStatus: active",
		auditSkippedReason: "auditor disabled in settings",
	});
	assert.ok(report.includes("Goal audit skipped."), "must say skipped");
	assert.ok(report.includes("auditor disabled in settings"), "must include skip reason");
	assert.ok(report.includes("Goal complete."));
	assert.ok(report.includes("Build feature Y"), "must reference the updated objective");
	assert.ok(!report.includes("<approved/>"), "must NOT include approval marker");
});


test("sync + Esc bypass: report includes new objective and Esc reason", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Build feature X\nUpdated objective: Build feature Y\nStatus: active",
		auditSkippedReason: "auditor bypassed (user pressed Escape during audit)",
	});
	assert.ok(report.includes("Goal audit skipped."));
	assert.ok(report.includes("auditor bypassed (user pressed Escape during audit)"));
	assert.ok(report.includes("Goal complete."));
	assert.ok(report.includes("Build feature Y"));
	assert.ok(!report.includes("<approved/>"));
});


test("multiple syncs then complete: final objective in archived file", () => {
	const ctx = tempCtx();
	try {
		const objs = ["First objective", "Second objective", "Third and final objective"];
		const goal = makeGoal({ objective: objs[0] });
		let current = writeActiveGoalFile(ctx, goal);

		for (const obj of objs) {
			current = writeActiveGoalFile(ctx, { ...current, objective: obj });
			assert.equal(current.objective, obj);
			assert.equal(current.status, "active");
		}

		const completed = writeActiveGoalFile(ctx, {
			...current,
			status: "complete" as const,
			stopReason: "agent" as const,
			updatedAt: new Date().toISOString(),
		});
		assert.equal(completed.objective, objs[2]);

		const archived = archiveGoalFile(ctx, completed);
		const archivedContent = readArchivedFile(ctx, archived);

		assert.ok(archivedContent.includes(objs[2]!), "archived must have the final objective");
		assert.ok(!archivedContent.includes(objs[0]!), "archived must NOT have obj1");
		assert.ok(!archivedContent.includes(objs[1]!), "archived must NOT have obj2");
	} finally {
		cleanup(ctx);
	}
});


test("sync while paused: status stays paused, objective changed on disk", () => {
	const ctx = tempCtx();
	try {
		const originalObj = "Paused goal objective";
		const newObj = "Updated while paused";

		const goal = makeGoal({ objective: originalObj, status: "paused" });
		const paused = writeActiveGoalFile(ctx, goal);
		assert.equal(paused.status, "paused");
		assert.equal(paused.objective, originalObj);

		const updated = writeActiveGoalFile(ctx, { ...paused, objective: newObj });
		assert.equal(updated.status, "paused", "status must stay paused");
		assert.equal(updated.objective, newObj, "objective must be updated");

		const disk = readGoalFile(ctx, updated);
		assert.ok(disk.includes(newObj), "disk must have new objective");
		assert.ok(disk.includes('"status": "paused"'), "disk must show paused status");
	} finally {
		cleanup(ctx);
	}
});


test("deferred archival after sync: verify active then archived", () => {
	const ctx = tempCtx();
	try {
		const updatedObj = "Objective updated before completion";
		const goal = makeGoal({ objective: "Original" });
		const active = writeActiveGoalFile(ctx, goal);

		const synced = writeActiveGoalFile(ctx, { ...active, objective: updatedObj });
		assert.equal(synced.archivedPath, undefined);

		const completed = writeActiveGoalFile(ctx, {
			...synced,
			status: "complete" as const,
			stopReason: "agent" as const,
			updatedAt: new Date().toISOString(),
		});
		assert.match(completed.activePath ?? "", /^\.pi\/goals\/active_goal_/,
			"after mark complete: still active file (not archived)");
		assert.equal(completed.archivedPath, undefined,
			"after mark complete: no archivedPath");

		const pool = readActiveGoalPool(ctx);
		assert.equal(pool.has(goal.id), false, "complete goal filtered from pool");

		const archived = archiveGoalFile(ctx, completed);
		assert.equal(archived.activePath, undefined, "after archive: no activePath");
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/,
			"after archive: has archivedPath");

		const archivedContent = readArchivedFile(ctx, archived);
		assert.ok(archivedContent.includes(updatedObj),
			"archived file must have the synced objective");
		assert.ok(archivedContent.includes('"status": "complete"'),
			"archived file must have complete status");
	} finally {
		cleanup(ctx);
	}
});


test("all three bypass paths produce correct distinct reports", () => {
	const base = "Base detailed summary";

	const approval = buildCompletionReport({
		detailedSummary: base,
		auditorReport: "All verified.\n\n<approved/>",
	});
	const disabled = buildCompletionReport({
		detailedSummary: base,
		auditSkippedReason: "auditor disabled in settings",
	});
	const esc = buildCompletionReport({
		detailedSummary: base,
		auditSkippedReason: "auditor bypassed (user pressed Escape during audit)",
	});

	assert.ok(approval.includes("Goal audit approved."), "approval: header");
	assert.ok(disabled.includes("Goal audit skipped."), "disabled: header");
	assert.ok(esc.includes("Goal audit skipped."), "esc: header");
	assert.ok(disabled.includes("auditor disabled in settings"), "disabled: specific reason");
	assert.ok(esc.includes("auditor bypassed (user pressed Escape during audit)"), "esc: specific reason");
	assert.ok(approval.includes("<approved/>"), "approval: marker");
	assert.ok(!disabled.includes("<approved/>"), "disabled: no marker");
	assert.ok(!esc.includes("<approved/>"), "esc: no marker");
	assert.ok(approval.includes("Goal complete."), "approval: complete");
	assert.ok(disabled.includes("Goal complete."), "disabled: complete");
	assert.ok(esc.includes("Goal complete."), "esc: complete");

	for (const label of ["approval", "disabled", "esc"]) {
		const ctx = tempCtx();
		try {
			const goal = makeGoal({ objective: `Bypass test: ${label}` });
			const active = writeActiveGoalFile(ctx, goal);
			assert.equal(active.objective, `Bypass test: ${label}`);

			const completed = writeActiveGoalFile(ctx, {
				...active,
				status: "complete" as const,
				stopReason: "agent" as const,
				updatedAt: new Date().toISOString(),
			});
			assert.equal(completed.status, "complete");
			assert.equal(completed.archivedPath, undefined);

			const archived = archiveGoalFile(ctx, completed);
			assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);

			const content = readArchivedFile(ctx, archived);
			assert.ok(content.includes(`Bypass test: ${label}`), `${label}: archived has correct objective`);
		} finally {
			cleanup(ctx);
		}
	}
});
