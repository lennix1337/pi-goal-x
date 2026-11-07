import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGoalRecord, normalizeGoalStatus, normalizeTaskList, type GoalTask } from "../extensions/goal-record.ts";
import { countTaskSubtree } from "../extensions/goal-task-count.ts";
import {
	checkSubtasksComplete,
	findTaskInTree,
	shouldArmPostCompactReminder,
	shouldQueueContinuation,
	skipAllSubtasks,
	taskCompletionBlockWarning,
	updateTaskInTree,
	validateGoalAgentPause,
	validateGoalBlock,
	validateGoalCompletion,
	validateResumeGoal,
	type GoalPolicyRecordLike,
	type GoalStatusLike,
} from "../extensions/goal-policy.ts";
import { newGoalScheduler, normalizeGoalScheduler } from "../extensions/goal-scheduler-state.ts";
import { GoalAccounting, budgetReached, budgetRemaining } from "../extensions/goal-accounting.ts";
import { effectiveRunLimit, normalizeRunLimit } from "../extensions/goal-run-budget.ts";
import { NETWORK_ERROR_BACKOFF_DELAYS_MS, networkErrorBackoffPlan } from "../extensions/network-error-backoff.ts";

// Property tests over seeded generators: every failing case reproduces from its seed (the assertion message names it).
const rng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const CASES = 200;
type Next = () => number;
const pick = <T>(next: Next, items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
const T0 = "2026-11-07T00:00:00.000Z";

// ---- Target 1: task tree (counts, completion gate, subtree operations, persisted task lists) ----

const STATUSES: GoalTask["status"][] = ["pending", "complete", "skipped"];

/** Random task tree. With `forceDone`, every node is complete or skipped and so is every descendant of a complete node: the consistent states the tools can produce. */
function genTasks(next: Next, depth: number, counter: { n: number }, forceDone = false): GoalTask[] {
	const count = 1 + Math.floor(next() * 3);
	return Array.from({ length: count }, () => {
		counter.n++;
		const id = `t${counter.n}`;
		const status = forceDone ? pick<GoalTask["status"]>(next, ["complete", "skipped"]) : pick(next, STATUSES);
		const subtasks = depth > 0 && next() < 0.5 ? genTasks(next, depth - 1, counter, forceDone || status === "complete") : undefined;
		return { id, title: `Task ${id}`, status, ...(subtasks ? { subtasks } : {}) };
	});
}

const flat = (tasks: readonly GoalTask[]): GoalTask[] => tasks.flatMap(t => [t, ...flat(t.subtasks ?? [])]);

test("property task counts partition the tree and pending means neither complete nor skipped", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed), tasks = genTasks(next, 2, { n: 0 }), nodes = flat(tasks);
		const counts = countTaskSubtree(tasks);
		assert.deepEqual(
			{ total: counts.total, complete: counts.complete, skipped: counts.skipped, pending: counts.pending },
			{
				total: nodes.length,
				complete: nodes.filter(t => t.status === "complete").length,
				skipped: nodes.filter(t => t.status === "skipped").length,
				pending: nodes.filter(t => t.status === "pending").length,
			},
			`seed ${seed}`,
		);
		assert.equal(counts.complete + counts.skipped + counts.pending, counts.total, `seed ${seed}: counts do not partition the tree`);
	}
});

test("property completion gate blocks exactly when a task is pending and names how many", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed), tasks = genTasks(next, 2, { n: 0 });
		const pending = flat(tasks).filter(t => t.status === "pending").length;
		const warning = taskCompletionBlockWarning({ tasks, blockCompletion: true, proposedAt: T0 });
		if (pending === 0) assert.equal(warning, null, `seed ${seed}: skipped or complete tasks must not block completion`);
		else assert.match(warning ?? "", new RegExp(`^${pending} task`), `seed ${seed}`);
		assert.equal(taskCompletionBlockWarning({ tasks, blockCompletion: false, proposedAt: T0 }), null, `seed ${seed}: gate off`);
	}
});

test("property skipping subtasks leaves no pending work below and keeps completed tasks", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed), counter = { n: 0 };
		const root: GoalTask = { id: "root", title: "Root", status: "pending", subtasks: genTasks(next, 2, counter) };
		const out = skipAllSubtasks(root, T0, "not needed");
		assert.equal(checkSubtasksComplete(out), undefined, `seed ${seed}: pending work left below the skipped parent`);
		const before = flat(root.subtasks!), after = flat(out.subtasks!);
		assert.deepEqual(after.map(t => t.id), before.map(t => t.id), `seed ${seed}: task ids changed`);
		before.forEach((task, i) => {
			if (task.status === "complete") assert.equal(after[i]!.status, "complete", `seed ${seed}: completed task ${task.id} reopened`);
		});
	}
});

test("property updateTaskInTree touches only the addressed task and an unknown id changes nothing", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed), tasks = genTasks(next, 2, { n: 0 }), nodes = flat(tasks);
		const target = pick(next, nodes);
		assert.equal(findTaskInTree(tasks, target.id)?.id, target.id, `seed ${seed}`);
		const updated = updateTaskInTree(tasks, target.id, t => ({ ...t, title: `${t.title}!` }));
		assert.deepEqual(
			flat(updated).map(t => [t.id, t.title]),
			nodes.map(t => [t.id, t.id === target.id ? `${t.title}!` : t.title]),
			`seed ${seed}: wrong task changed`,
		);
		assert.equal(updateTaskInTree(tasks, "no-such-task", t => ({ ...t, status: "skipped" })), tasks, `seed ${seed}: unknown id must return the same list`);
	}
});

const TASK_JUNK: unknown[] = [null, undefined, 0, 7, "text", true, [], [{ id: "x", title: "x" }], {}, { id: "", title: "t" }, { id: "  ", title: "t" },
	{ id: "empty-title", title: "" }, { title: "no id" }, { id: 12, title: "numeric id" }];
const isUsableTask = (item: unknown): boolean => !!item && typeof item === "object" && !Array.isArray(item)
	&& typeof (item as { id?: unknown }).id === "string" && (item as { id: string }).id.trim() !== ""
	&& typeof (item as { title?: unknown }).title === "string" && (item as { title: string }).title.trim() !== "";

test("property persisted task list never throws on junk and keeps only usable task objects", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		const items = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, k) => next() < 0.5
			? pick(next, TASK_JUNK)
			: { id: `i${k}`, title: "T", status: pick(next, ["pending", "complete", "skipped", "bogus"]),
				subtasks: next() < 0.5 ? [pick(next, TASK_JUNK), { id: `s${k}`, title: "S" }] : undefined });
		const expectedKept = items.filter(isUsableTask).length;
		assert.doesNotThrow(() => normalizeTaskList({ tasks: items }), `seed ${seed}: normalizeTaskList threw`);
		assert.equal(normalizeTaskList({ tasks: items })?.tasks.length ?? 0, expectedKept, `seed ${seed}`);
		const raw = { id: "g", objective: "o", status: "active", taskList: { tasks: items, proposedAt: T0 } };
		assert.doesNotThrow(() => normalizeGoalRecord(raw), `seed ${seed}: goal read threw`);
		assert.equal(normalizeGoalRecord(raw)?.status, "active", `seed ${seed}`);
	}
});

// ---- Target 2: goal status read-back and the action matrix that depends on it ----

const KNOWN_STATUSES = ["active", "paused", "blocked", "budget_limited", "complete"] as const;
const STATUS_VALUES: unknown[] = ["active", "ACTIVE", " paused ", "Blocked", "budget_limited", "BUDGET_LIMITED", "complete", "Complete ", "failed",
	"done", "", " ", "activ", "budget-limited", 0, 1, true, null, {}, [], "running"];

function expectedStatus(value: unknown): string {
	if (value === undefined) return "active";
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	return (KNOWN_STATUSES as readonly string[]).includes(text) ? text : "paused";
}

test("property persisted status is kept only when recognized, otherwise paused, never active", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed), value = next() < 0.8 ? pick(next, STATUS_VALUES) : undefined;
		assert.equal(normalizeGoalStatus(value), expectedStatus(value), `seed ${seed}: ${JSON.stringify(value)}`);
		if (normalizeGoalStatus(value) === "active") assert.ok(value === undefined || String(value).trim().toLowerCase() === "active", `seed ${seed}: ${JSON.stringify(value)} started a run`);
	}
});

test("property persisted goal read back keeps its status and reading it again changes nothing", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		const raw = {
			id: "goal-prop", objective: "Objective", status: pick(next, STATUS_VALUES), autoContinue: next() < 0.5,
			usage: { tokensUsed: Math.floor(next() * 1e6), activeSeconds: Math.floor(next() * 1e4) }, sisyphus: next() < 0.3,
			createdAt: T0, updatedAt: T0, revision: Math.floor(next() * 9), tokenBudget: next() < 0.5 ? 1 + Math.floor(next() * 5000) : undefined,
			taskList: next() < 0.5 ? { tasks: [{ id: "a", title: "A", status: "skipped" }], blockCompletion: true, proposedAt: T0 } : undefined,
			currentTaskId: next() < 0.3 ? "a" : undefined,
		};
		const once = normalizeGoalRecord(raw);
		assert.ok(once, `seed ${seed}`);
		assert.equal(once.status, expectedStatus(raw.status), `seed ${seed}`);
		assert.deepEqual(normalizeGoalRecord(once), once, `seed ${seed}: read-back is not idempotent`);
	}
});

test("property status action matrix: complete is absorbing and only active goals run", () => {
	const statuses: GoalStatusLike[] = ["active", "paused", "blocked", "budget_limited", "complete"];
	for (const status of statuses) {
		for (const autoContinue of [true, false]) {
			const goal = { id: "g", objective: "o", status, autoContinue, sisyphus: false, usage: { tokensUsed: 0, activeSeconds: 0 } } as GoalPolicyRecordLike;
			const allowed = {
				complete: validateGoalCompletion({ goal }).ok,
				block: validateGoalBlock({ goal }).ok,
				agentPause: validateGoalAgentPause({ goal }).ok,
				resume: validateResumeGoal(goal).ok,
				queue: shouldQueueContinuation(goal),
				postCompactReminder: shouldArmPostCompactReminder(goal),
			};
			assert.deepEqual(allowed, {
				complete: status === "active" || status === "paused" || status === "budget_limited",
				block: status === "active",
				agentPause: status === "active",
				resume: status !== "complete" && !(status === "active" && autoContinue),
				queue: status === "active" && autoContinue,
				postCompactReminder: status === "active",
			}, `${status} autoContinue=${autoContinue}`);
		}
	}
});

// ---- Target 3: persisted scheduler state (run counters and dispatch phases) ----

const PHASES = ["idle", "ready", "waiting", "claimed", "running", "interrupted"];
const SCHEDULER_WEIRD: unknown[] = [undefined, null, 0, 1, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 2 ** 53, "", "x", "ready", "waiting",
	"claimed", "running", "interrupted", "idle", "wrong", true, false, {}, [], { kind: "ready", purpose: "ready" }, { kind: "ready", purpose: "check" },
	{ kind: "ready", purpose: "recovery" }, { kind: "wait" }, { kind: "other" }, { id: "w", token: "t", reason: "r", deadline: 1e12 },
	{ id: "w", token: "t", reason: "r", deadline: 1e12, intervalMs: 1000, remainingChecks: 2, nextCheckAt: 5 }, { id: "d", kind: "ready", claimedAt: 1 },
	{ id: "d", kind: "check", claimedAt: 2 }];

function genScheduler(next: Next): Record<string, unknown> {
	const raw: Record<string, unknown> = {
		version: next() < 0.9 ? 1 : pick(next, SCHEDULER_WEIRD),
		owner: next() < 0.9 ? "owner" : pick(next, SCHEDULER_WEIRD),
		generation: next() < 0.9 ? "gen-1" : pick(next, SCHEDULER_WEIRD),
		used: next() < 0.7 ? Math.floor(next() * 50) : pick(next, SCHEDULER_WEIRD),
		phase: next() < 0.9 ? pick(next, PHASES) : pick(next, SCHEDULER_WEIRD),
		repairUsed: next() < 0.9 ? next() < 0.5 : pick(next, SCHEDULER_WEIRD),
	};
	if (next() < 0.6) raw.decision = next() < 0.5 ? { kind: "ready", purpose: pick(next, ["ready", "repair", "kickoff", "recovery", "check"]) }
		: next() < 0.8 ? { kind: "wait" } : pick(next, SCHEDULER_WEIRD);
	if (next() < 0.5) raw.wait = next() < 0.7
		? { id: "w", token: "t", reason: "r", deadline: Date.now() + 1e6, ...(next() < 0.5 ? { intervalMs: pick(next, [500, 1000, 5000]), remainingChecks: pick(next, [0, 1, 2]), nextCheckAt: 5 } : {}) }
		: pick(next, SCHEDULER_WEIRD);
	if (next() < 0.5) raw.dispatch = next() < 0.7 ? { id: "d", kind: pick(next, ["ready", "check", "wake", "repair", "kickoff", "recovery"]), claimedAt: 3 } : pick(next, SCHEDULER_WEIRD);
	return raw;
}

test("property persisted scheduler keeps phase invariants, never loses spent allowance, and is idempotent", () => {
	let accepted = 0, rejected = 0;
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed), raw = genScheduler(next);
		assert.doesNotThrow(() => normalizeGoalScheduler(raw), `seed ${seed}: normalizeGoalScheduler threw`);
		const s = normalizeGoalScheduler(raw)!;
		if (s.used === raw.used) accepted++; else rejected++;
		assert.ok(PHASES.includes(s.phase), `seed ${seed}`);
		assert.ok(Number.isSafeInteger(s.used) && s.used >= 0, `seed ${seed}: used ${s.used}`);
		if (typeof raw.used === "number" && Number.isSafeInteger(raw.used) && raw.used >= 0) assert.ok(s.used >= raw.used, `seed ${seed}: spent allowance lost`);
		if (s.phase === "claimed" || s.phase === "running") assert.ok(s.dispatch, `seed ${seed}: ${s.phase} without dispatch`);
		if (s.phase === "ready") assert.equal(s.decision?.kind, "ready", `seed ${seed}`);
		if (s.phase === "waiting") { assert.ok(s.wait, `seed ${seed}`); assert.equal(s.decision?.kind, "wait", `seed ${seed}`); }
		assert.ok(!s.decision || !("nextAction" in s.decision), `seed ${seed}: legacy nextAction kept`);
		assert.deepEqual(normalizeGoalScheduler(s), s, `seed ${seed}: not idempotent`);
	}
	assert.equal(normalizeGoalScheduler(newGoalScheduler("owner"))?.used, 0);
	// The generator must reach both outcomes, or the invariants above would hold vacuously.
	assert.ok(accepted >= 20 && rejected >= 20, `generator covers both outcomes: accepted ${accepted}, rejected ${rejected}`);
});

// ---- Target 4: accounting clock, budgets, run allowance, network recovery ladder ----

/** Replace Date.now for the duration of `body`, so charges are deterministic. */
function withClock<T>(start: number, body: (set: (ms: number) => void) => T): T {
	const realNow = Date.now;
	let now = start;
	Date.now = () => now;
	try { return body(ms => { now = ms; }); } finally { Date.now = realNow; }
}

test("property charged seconds never exceed the wall clock and a repeated charge at one instant is free", () => {
	const start = 1_700_000_000_000;
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		withClock(start, set => {
			const accounting = new GoalAccounting();
			accounting.begin("goal");
			let now = start, total = 0;
			for (let i = 0; i < 40; i++) {
				now += Math.floor(next() * 90_000);
				set(now);
				total += accounting.charge({ completedTurnTokens: Math.floor(next() * 1000) }).seconds;
				assert.ok(total <= Math.floor((now - start) / 1000), `seed ${seed} step ${i}: charged ${total}s over ${(now - start) / 1000}s`);
				assert.equal(accounting.charge().seconds, 0, `seed ${seed} step ${i}: same instant charged twice`);
			}
		});
	}
});

test("property a clock stepping back never charges the same wall-clock interval twice", () => {
	const start = 1_700_000_000_000;
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		withClock(start, set => {
			const accounting = new GoalAccounting();
			accounting.begin("goal");
			let now = start, high = start, total = 0;
			for (let i = 0; i < 40; i++) {
				now += Math.floor(next() * 90_000) - (next() < 0.4 ? Math.floor(next() * 60_000) : 0);
				high = Math.max(high, now);
				set(now);
				total += accounting.charge().seconds;
				assert.ok(total <= Math.floor((high - start) / 1000), `seed ${seed} step ${i}: interval charged twice (${total}s for ${(high - start) / 1000}s)`);
			}
		});
	}
});

test("property token budget remaining and reached agree with usage, and an unset budget never limits", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed), tokenBudget = 1 + Math.floor(next() * 1000);
		// Half the cases sit at the boundary (budget - 2 .. budget + 2), where an off-by-one changes the answer.
		const used = next() < 0.5 ? Math.max(0, tokenBudget + Math.floor(next() * 5) - 2) : Math.floor(next() * 2000);
		const goal = { tokenBudget, usage: { tokensUsed: used } };
		const remaining = budgetRemaining(goal);
		assert.equal(remaining, Math.max(0, tokenBudget - used), `seed ${seed}`);
		assert.equal(budgetReached(goal), used >= tokenBudget, `seed ${seed}: reached at ${used}/${tokenBudget}`);
	}
	for (const tokenBudget of [undefined, 0, -5, NaN, Infinity]) {
		assert.equal(budgetRemaining({ tokenBudget, usage: { tokensUsed: 5 } }), null, String(tokenBudget));
		assert.equal(budgetReached({ tokenBudget, usage: { tokensUsed: 5 } }), false, String(tokenBudget));
	}
});

test("property persisted run limit that is not a nonnegative safe integer disables continuation instead of lifting the cap", () => {
	const invalid: unknown[] = ["5", -1, 1.5, NaN, Infinity, {}, [], true, ""];
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed), value = pick(next, [...invalid, 0, 1, 30, 2 ** 40, null, undefined]);
		const normalized = normalizeRunLimit(value);
		if (invalid.includes(value)) assert.equal(normalized, 0, `seed ${seed}: ${JSON.stringify(value)} lifted the cap`);
		else assert.equal(normalized, value as number | null | undefined, `seed ${seed}`);
		const configured = Math.floor(next() * 100);
		assert.equal(effectiveRunLimit({ maxAutonomousRuns: null }, configured), undefined, `seed ${seed}: null means unlimited`);
		assert.equal(effectiveRunLimit({}, configured), configured, `seed ${seed}: absent inherits settings`);
		assert.equal(effectiveRunLimit({ maxAutonomousRuns: 3 }, configured), 3, `seed ${seed}: override wins`);
	}
});

test("property network recovery ladder escalates, plateaus at its cap, and a bounded policy ends", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		const policy = { maxAttempts: next() < 0.5 ? 0 : 1 + Math.floor(next() * 12), maxDelayMs: 1000 + Math.floor(next() * 120_000) };
		let previous = 0;
		for (let attempt = 1; attempt <= 15; attempt++) {
			const plan = networkErrorBackoffPlan(attempt, policy);
			if (policy.maxAttempts > 0 && attempt > policy.maxAttempts) { assert.equal(plan, undefined, `seed ${seed} attempt ${attempt}`); continue; }
			assert.ok(plan, `seed ${seed} attempt ${attempt}`);
			const ladder = NETWORK_ERROR_BACKOFF_DELAYS_MS[Math.min(attempt - 1, NETWORK_ERROR_BACKOFF_DELAYS_MS.length - 1)]!;
			assert.equal(plan.delayMs, Math.min(ladder, policy.maxDelayMs), `seed ${seed} attempt ${attempt}`);
			assert.ok(plan.delayMs >= previous, `seed ${seed} attempt ${attempt}: delay shrank`);
			previous = plan.delayMs;
		}
		assert.equal(networkErrorBackoffPlan(0, policy), undefined, `seed ${seed}`);
		assert.equal(networkErrorBackoffPlan(1.5, policy), undefined, `seed ${seed}`);
	}
});

// ---- Red-first regressions for the defects the properties above found ----

test("regression a block gate ignores skipped tasks: all complete or skipped does not block completion", () => {
	const block = (tasks: GoalTask[]) => taskCompletionBlockWarning({ tasks, blockCompletion: true, proposedAt: T0 });
	assert.equal(block([{ id: "t1", title: "A", status: "complete" }, { id: "t2", title: "B", status: "skipped", skipReason: "not needed" }]), null);
	assert.equal(block([{ id: "t1", title: "A", status: "skipped", skipReason: "not needed" }]), null);
	assert.match(block([{ id: "t1", title: "A", status: "skipped" }, { id: "t2", title: "B", status: "pending" }]) ?? "", /^1 task still pending/);
});

test("regression a null entry in a persisted task list is dropped instead of making the goal unreadable", () => {
	assert.doesNotThrow(() => normalizeTaskList({ tasks: [null, { id: "a", title: "A", status: "pending" }] }));
	assert.equal(normalizeTaskList({ tasks: [null, { id: "a", title: "A", status: "pending" }] })?.tasks.length, 1);
	assert.doesNotThrow(() => normalizeGoalRecord({ id: "g", objective: "o", status: "active", taskList: { tasks: [null] } }));
	assert.equal(normalizeGoalRecord({ id: "g", objective: "o", status: "active", taskList: { tasks: [null] } })?.taskList, undefined);
});

test("regression a clock stepping back does not charge the elapsed interval again", () => {
	const start = 1_700_000_000_000;
	withClock(start, set => {
		const accounting = new GoalAccounting();
		accounting.begin("goal");
		set(start + 60_000);
		assert.equal(accounting.charge().seconds, 60);
		set(start + 30_000);
		assert.equal(accounting.charge().seconds, 0);
		set(start + 90_000);
		assert.equal(accounting.charge().seconds, 30, "only the 30 s after the 60 s already charged");
	});
});
