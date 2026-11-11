import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGoalCore } from "../extensions/goal-state.ts";
import { createGoal, goalFocusDetails, type GoalRecord } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };

interface Harness {
	core: ReturnType<typeof createGoalCore>;
	ctx: ExtensionContext;
	cwd: string;
	status: Array<string | undefined>;
	widgets: Array<Function | undefined>;
	events: Array<{ channel: string; data: any }>;
	flush(): Promise<void>;
	renderWidget(): string[];
}

function harness(t: test.TestContext, opts: { goals: GoalRecord[]; focus?: string }): Harness {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-compact-status-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	for (const goal of opts.goals) writeActiveGoalFile({ cwd }, goal);
	const status: Array<string | undefined> = [];
	const widgets: Array<Function | undefined> = [];
	const events: Array<{ channel: string; data: any }> = [];
	const core = createGoalCore({
		getActiveTools: () => [], setActiveTools: () => {}, appendEntry: () => {},
		events: { emit: (channel: string, data: unknown) => { events.push({ channel, data }); }, on: () => () => {} },
	} as any);
	const ctx = {
		cwd, hasUI: true,
		ui: {
			setStatus: (key: string, value?: string) => { if (key === "goal") status.push(value); },
			setWidget: (key: string, factory?: Function) => { if (key === "goal") widgets.push(typeof factory === "function" ? factory : undefined); },
		},
		sessionManager: {
			getSessionId: () => "compact-status",
			getBranch: () => opts.focus ? [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(opts.focus, "created") }] : [],
		},
	} as unknown as ExtensionContext;
	const flush = async () => { await Promise.resolve(); };
	return {
		core, ctx, cwd, status, widgets, events, flush,
		renderWidget() {
			const factory = widgets.at(-1);
			assert.ok(factory, "a widget factory is registered");
			return factory({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, theme).render(100);
		},
	};
}

const statusEvents = (h: Harness) => h.events.filter((e) => e.channel === "goal-x:status:v1").map((e) => e.data);

function runningGoalWithTasks(): GoalRecord {
	const goal = createGoal({ objective: "Ship the invoice exporter", autoContinue: true, sisyphus: false });
	goal.taskList = {
		tasks: [
			{ id: "t1", title: "Read the spec", status: "complete" },
			{ id: "t2", title: "Write the exporter", status: "pending" },
			{ id: "t3", title: "Add tests", status: "pending" },
		],
		blockCompletion: false,
		proposedAt: goal.createdAt,
	};
	goal.currentTaskId = "t2";
	return goal;
}

test("unfocused: one short status line and no widget", async (t) => {
	const a = createGoal({ objective: "First goal", autoContinue: true, sisyphus: false });
	const b = createGoal({ objective: "Second goal", autoContinue: true, sisyphus: false });
	const h = harness(t, { goals: [a, b] });
	await h.core.loadState(h.ctx);
	h.core.updateUI(h.ctx);
	await h.flush();
	assert.equal(h.status.at(-1), "meta: 2 abertas · /goal-focus");
	assert.ok(h.widgets.every((w) => w === undefined), "no widget factory was ever registered");
	assert.deepEqual(statusEvents(h).at(-1), { text: "meta: 2 abertas · /goal-focus", focused: false, open: 2 });
});

test("unfocused with a single open goal uses the singular", async (t) => {
	const h = harness(t, { goals: [createGoal({ objective: "Only goal", autoContinue: true, sisyphus: false })] });
	await h.core.loadState(h.ctx);
	h.core.updateUI(h.ctx);
	await h.flush();
	assert.equal(h.status.at(-1), "meta: 1 aberta · /goal-focus");
});

test("focused running goal: title cut at 40, progress in the status, widget capped at one line", async (t) => {
	const goal = runningGoalWithTasks();
	goal.objective = "Ship the invoice exporter with every currency supported by the finance team";
	const h = harness(t, { goals: [goal], focus: goal.id });
	await h.core.loadState(h.ctx);
	h.core.updateUI(h.ctx);
	await h.flush();
	const text = h.status.at(-1)!;
	assert.match(text, /^meta: Ship the invoice exporter with every cu… · em andamento 1\/3$/);
	assert.ok(text.split(" · ")[0]!.length <= "meta: ".length + 40);
	const lines = h.renderWidget();
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /Write the exporter/);
	assert.deepEqual(statusEvents(h).at(-1), { text, focused: true, open: 1 });
});

test("focused running goal with nothing extra to say has no widget", async (t) => {
	const goal = createGoal({ objective: "Plain goal", autoContinue: true, sisyphus: false });
	const h = harness(t, { goals: [goal], focus: goal.id });
	await h.core.loadState(h.ctx);
	h.core.updateUI(h.ctx);
	await h.flush();
	assert.equal(h.status.at(-1), "meta: Plain goal · em andamento");
	assert.ok(h.widgets.every((w) => w === undefined));
});

test("focused paused goal: status only, no widget", async (t) => {
	const goal = runningGoalWithTasks();
	goal.status = "paused";
	goal.stopReason = "user";
	const h = harness(t, { goals: [goal], focus: goal.id });
	await h.core.loadState(h.ctx);
	h.core.updateUI(h.ctx);
	await h.flush();
	assert.match(h.status.at(-1)!, /^meta: Ship the invoice exporter · pausada 1\/3$/);
	assert.ok(h.widgets.every((w) => w === undefined));
});

test("the status event fires on every change and not on repeats", async (t) => {
	const goal = runningGoalWithTasks();
	const h = harness(t, { goals: [goal], focus: goal.id });
	await h.core.loadState(h.ctx);
	h.core.updateUI(h.ctx);
	await h.flush();
	const afterFirst = statusEvents(h).length;
	assert.ok(afterFirst >= 1);
	h.core.updateUI(h.ctx);
	await h.flush();
	assert.equal(statusEvents(h).length, afterFirst, "an unchanged state emits nothing");
	h.core.state.goal = { ...h.core.state.goal!, status: "paused", stopReason: "user" };
	h.core.updateUI(h.ctx);
	await h.flush();
	assert.equal(statusEvents(h).length, afterFirst + 1);
	assert.match(statusEvents(h).at(-1).text, /pausada/);
});

test("no goals at all clears the status and announces an empty one", async (t) => {
	const h = harness(t, { goals: [] });
	await h.core.loadState(h.ctx);
	h.core.updateUI(h.ctx);
	await h.flush();
	assert.equal(h.status.at(-1), undefined);
	assert.deepEqual(statusEvents(h).at(-1), { text: "", focused: false, open: 0 });
});

test("the expanded dashboard stays available on demand", async (t) => {
	const goal = runningGoalWithTasks();
	const h = harness(t, { goals: [goal], focus: goal.id });
	await h.core.loadState(h.ctx);
	h.core.toggleDashboardExpanded();
	h.core.updateUI(h.ctx);
	await h.flush();
	assert.ok(h.renderWidget().length > 1, "explicitly expanded dashboard renders the full box");
	h.core.toggleDashboardExpanded();
	h.core.updateUI(h.ctx);
	await h.flush();
	assert.equal(h.renderWidget().length, 1, "collapsing returns to the single line");
});
