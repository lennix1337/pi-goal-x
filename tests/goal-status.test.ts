
import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";
import type { GoalRecord, GoalTask } from "../extensions/goal-record.ts";
import { buildGoalStatusText, GOAL_STATUS_WIDTH } from "../extensions/goal-status.ts";

function task(id: string, title: string, overrides: Partial<GoalTask> = {}): GoalTask {
	return { id, title, status: "pending", ...overrides };
}

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g1",
		objective: "Add CSV export to reports",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 18200, activeSeconds: 767 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		activePath: ".pi/goals/active_goal_g1.md",
		...overrides,
	};
}

function withTasks(taskList: GoalTask[], overrides: Partial<GoalRecord> = {}): GoalRecord {
	return goal({ ...overrides, taskList: { tasks: taskList, blockCompletion: false, proposedAt: "2026-01-01T00:00:00.000Z" } });
}

function fiveTasks(): GoalTask[] {
	return [
		task("t1", "Review reports page and data source", { status: "complete", evidence: "Reviewed source" }),
		task("t2", "Implement filtered CSV export", { status: "complete" }),
		task("t3", "Add the download button", {
			verificationContract: "The button downloads a CSV using the active filters.",
			subtasks: [
				task("t3.1", "Add loading state", { status: "complete" }),
				task("t3.2", "Generate timestamped filename", { status: "complete" }),
				task("t3.3", "Add error handling"),
			],
		}),
		task("t4", "Add documentation"),
		task("t5", "Add and run tests", { status: "skipped", skipReason: "Covered by t2" }),
	];
}

function events(): GoalLedgerEvent[] {
	return [
		{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "2026-01-01T09:00:00.000Z" },
		{ type: "task_complete", goalId: "g1", taskId: "t2", evidence: "Done", at: "2026-01-01T09:05:00.000Z" },
		{ type: "task_started", goalId: "g1", taskId: "t3.3", at: "2026-01-01T09:06:00.000Z" },
		{ type: "audit_result", goalId: "g1", verdict: "disapproved", report: "Tests were not run after the final change.", at: "2026-01-02T10:00:00.000Z" },
	] as unknown as GoalLedgerEvent[];
}

function base(): Parameters<typeof buildGoalStatusText>[0] {
	return {
		goal: withTasks(fiveTasks(), { currentTaskId: "t3", verificationContract: "Run npm test with zero failures." }),
		focused: true,
		otherOpenGoals: 2,
		ledgerEvents: events(),
	};
}

test("standard mode renders the compact dashboard from the shared model (§13.1)", () => {
	const text = buildGoalStatusText(base());
	assert.match(text, /╭─ pi-goal-x ─ Add CSV export to reports/);
	assert.match(text, /goal: running \[12m47s 18\.2K\] \(\+2 open\)/);
	assert.match(text, /├─ Tasks /);
	assert.match(text, /✓ t2  Implement filtered CSV export/);
	assert.match(text, /↑ 1 more task\b/);
	assert.match(text, /Tasks · ✓3 done · 2 open/);
	assert.match(text, /Current  t3 · Add the download button/);
	assert.match(text, /· Sub 2\/3 \[.*\]/, "subtask bar sits beside the task bar in the compact header");
	assert.match(text, /Verify   Run npm test with zero failures/);
	assert.match(text, /File     \.pi\/goals\/active_goal_g1\.md/);
});

test("standard mode adds current-task details, activity, and the last audit", () => {
	const text = buildGoalStatusText(base());
	assert.match(text, /├─ Current task /);
	assert.match(text, /Contract: The button downloads a CSV using the active filters/);
	assert.match(text, /├─ Recent activity /);
	assert.match(text, /Started “Add error handling”\./);
	assert.match(text, /Completed “Implement filtered CSV export”\. — Done/);
	assert.match(text, /Last audit: CHANGES REQUIRED \(2026-01-02\)/);
});

test("standard mode includes no effective settings noise by default", () => {
	const text = buildGoalStatusText(base());
	assert.doesNotMatch(text, /Effective settings/);
	assert.doesNotMatch(text, /provider:/);
});

test("standard mode shows the anchored task window — parity with the widget default (§9.6)", () => {
	const tasks: GoalTask[] = Array.from({ length: 30 }, (_, i) => ({
		id: `t${i + 1}`,
		title: `Task number ${i + 1}`,
		status: "pending" as const,
	}));
	tasks[4] = { ...tasks[4]!, status: "complete", completedAt: "2026-01-01T10:00:00.000Z" };
	tasks[19] = { ...tasks[19]!, status: "complete", completedAt: "2026-01-01T11:00:00.000Z" };
	const text = buildGoalStatusText({
		goal: withTasks(tasks, { currentTaskId: "t21" }),
		focused: true,
		otherOpenGoals: 0,
	});
	assert.match(text, /↑ 19 more tasks/, "the anchored window hides the earliest tasks");
	assert.match(text, /Task number 20[\s\S]*▸ t21  Task number 21/, "the task in progress follows the latest completion");
	assert.match(text, /… \+7 more tasks/, "pending tasks after the window stay reachable below");
	assert.doesNotMatch(text, /[✓▸·~] t1\s/, "the earliest task row is not rendered");
	for (const line of text.split("\n")) {
		assert.ok(visibleWidth(line) <= GOAL_STATUS_WIDTH, `line exceeds ${GOAL_STATUS_WIDTH}: ${JSON.stringify(line.slice(0, 60))}`);
	}
});

test("verbose mode carries full diagnostic detail (§13.2)", () => {
	const text = buildGoalStatusText({
		...base(),
		verbose: true,
		settingsReport: ["provider: anthropic (from .pi/pi-goal-x-settings.json)", "disableTasks: false"],
	});
	assert.match(text, /Goal id: g1/);
	assert.match(text, /Revision: \d+/);
	assert.match(text, /Status: In progress \(focused\)/);
	assert.match(text, /Objective:/);
	assert.match(text, /Add CSV export to reports/);
	assert.match(text, /✓ t1  Review reports page and data source — evidence: Reviewed source/);
	assert.match(text, /▸ t3  Add the download button — contract: The button downloads a CSV/);
	assert.match(text, /~ t5  Add and run tests/);
	assert.match(text, /Current task: t3 · Add the download button/);
	assert.match(text, /subtasks: 2\/3 \(67%\)/);
	assert.match(text, /Recent ledger:/);
	assert.match(text, /task_started/);
	assert.match(text, /Last audit \(2026-01-02\): disapproved/);
	assert.match(text, /Tests were not run after the final change/);
	assert.match(text, /Effective settings:/);
	assert.match(text, /provider: anthropic \(from .pi\/pi-goal-x-settings.json\)/);
});

test("no rendered line of the boxed standard output exceeds the rendering width", () => {
	const text = buildGoalStatusText(base());
	for (const line of text.split("\n")) {
		assert.ok(
			visibleWidth(line) <= GOAL_STATUS_WIDTH,
			`line exceeds ${GOAL_STATUS_WIDTH}: ${JSON.stringify(line.slice(0, 60))}`,
		);
	}
});

test("unfocused and no-goal states render correctly", () => {
	const unfocused = buildGoalStatusText({ goal: null, focused: false, otherOpenGoals: 3 });
	assert.match(unfocused, /3 open goals are available/);
	assert.match(unfocused, /\/goal-focus/);
	const none = buildGoalStatusText({ goal: null, focused: false, otherOpenGoals: 0 });
	assert.match(none, /No goal is set/);
});

test("complete goal standard output shows the §4.7 message", () => {
	const text = buildGoalStatusText({
		goal: withTasks(fiveTasks().map((t) => ({ ...t, status: "complete" as const })), {
			status: "complete",
			activePath: undefined,
			archivedPath: ".pi/goals/archived/goal_g1.md",
		}),
		focused: true,
		otherOpenGoals: 0,
	});
	assert.match(text, /All required work is complete/);
});

test("health mode reports storage, ledger, task, and budget warnings without claiming completion", () => {
	const text = buildGoalStatusText({
		goal: goal({
			taskList: { tasks: [task("t1", "Pending verification")], blockCompletion: true, proposedAt: "2026-01-01T00:00:00.000Z" },
			tokenBudget: 20_000,
			usage: { tokensUsed: 19_500, activeSeconds: 10 },
		}),
		focused: true,
		otherOpenGoals: 0,
		ledgerMalformed: 2,
		health: true,
		activeFilePresent: false,
	});
	assert.match(text, /^Goal health: ERROR/);
	assert.match(text, /ERROR Goal file: missing/);
	assert.match(text, /WARN Ledger: 2 malformed entries/);
	assert.match(text, /WARN Tasks: 0\/1 terminal · 1 pending/);
	assert.match(text, /WARN Budget: 19\.5K \/ 20K \(98%\)/);
	assert.match(text, /not a completion verdict/);
});

test("health mode can report an internally healthy goal", () => {
	const text = buildGoalStatusText({
		goal: goal({ usage: { tokensUsed: 100, activeSeconds: 2 } }),
		focused: true,
		otherOpenGoals: 0,
		ledgerMalformed: 0,
		health: true,
		activeFilePresent: true,
	});
	assert.match(text, /^Goal health: OK/);
	assert.match(text, /OK Goal file:/);
	assert.match(text, /OK Ledger: valid/);
});

test("health mode explains an unfocused session", () => {
	const text = buildGoalStatusText({ goal: null, focused: false, otherOpenGoals: 2, health: true });
	assert.match(text, /^Goal health: WARN/);
	assert.match(text, /no goal is focused/);
});
