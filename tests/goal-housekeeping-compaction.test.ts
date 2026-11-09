/**
 * Compactions that carry `details.housekeeping === true` are memory trims
 * started by a harness, not a context overflow of the goal's conversation.
 * They must still persist the goal, but arm no post-compaction reminder and
 * queue no continuation: nothing was lost that the goal needs to re-read.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import piGoalExtension from "../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import type { GoalCore } from "../extensions/goal-state.ts";

const FIXTURE_GOAL = readFileSync(
	new URL("./fixtures/goals/active_goal_fixture.md", import.meta.url),
	"utf8",
);

// ── Harness (mirrors tests/goal-stale-continuation-golden.test.ts) ──────────

interface HandlerMap {
	[key: string]: (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;
}

function createHarness(cwd: string) {
	const handlers: HandlerMap = {};
	const sentMessages: Array<{ customType?: string; details?: unknown }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	let aborts = 0;

	const mockPi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (...args: never[]) => unknown) => {
			handlers[event] = handler as HandlerMap[string];
		},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
		sendMessage: (msg: { customType?: string; details?: unknown }) => {
			sentMessages.push(msg);
		},
		sendUserMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
	};

	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => [],
			getCwd: () => cwd,
			getSessionId: () => "test-session",
			getRoot: () => cwd,
			append: () => {},
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
			appendCompetingWriteCheck: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "",
		isIdle: () => false,
		hasPendingMessages: () => true,
		abort: () => {
			aborts++;
		},
		ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
	} as unknown as ExtensionContext & { abort: () => void };

	piGoalExtension(mockPi as never);

	return {
		core: (mockPi as unknown as { _goalCore: GoalCore })._goalCore,
		handlers,
		sentMessages,
		notifications,
		get aborts() {
			return aborts;
		},
		ctx,
	};
}

function fixtureCwd(): { cwd: string; goal: GoalRecord } {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-network-recovery-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "goals", "active_goal_fixture.md"), FIXTURE_GOAL);
	const parsed = createGoal(
		{ objective: "Golden fixture goal objective", autoContinue: true, sisyphus: false },
		Date.UTC(2026, 7, 3, 9, 0, 0),
	);
	return { cwd, goal: { ...parsed, id: "golden_fixture_goal" } };
}

function sessionEntriesFor(goal: GoalRecord) {
	const stateEntry: GoalStateEntry = {
		version: 3,
		goal: {
			...goal,
			activePath: ".pi/goals/active_goal_fixture.md",
			usage: { tokensUsed: 0, activeSeconds: 0 },
			taskList: undefined,
			verificationContract: undefined,
		},
	};
	return [
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
		{ type: "custom", customType: "pi-goal-state", data: stateEntry },
	];
}

async function startSession(handlers: HandlerMap, ctx: ExtensionContext, entries: unknown[]) {
	const ss = handlers["session_start"];
	assert.ok(ss, "session_start handler must be registered");
	await ss({ reason: "start" }, {
		...ctx,
		sessionManager: { ...ctx.sessionManager, getBranch: () => entries },
	} as unknown as ExtensionContext);
}

async function compactWith(details: unknown) {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
	await h.handlers["before_agent_start"]!({ systemPrompt: "base", prompt: "go", systemPromptOptions: {} }, h.ctx);

	const calls = { continuations: 0, flushes: 0, persists: 0 };
	const core = h.core;
	const queue = core.queueContinuation;
	core.queueContinuation = (...args) => {
		calls.continuations++;
		return queue(...args);
	};
	const flush = core.goalService.flushTurn;
	core.goalService.flushTurn = (...args) => {
		calls.flushes++;
		return flush.apply(core.goalService, args);
	};
	const persist = core.persist;
	core.persist = (...args) => {
		calls.persists++;
		return persist(...args);
	};

	await h.handlers["session_compact"]!({
		type: "session_compact",
		compactionEntry: { type: "compaction", id: "c1", summary: "s", firstKeptEntryId: "e1", tokensBefore: 1, details },
		fromExtension: true,
		reason: "manual",
		willRetry: false,
	}, h.ctx);
	return { calls, reminderPending: core.runtime.isPostCompactReminderPending() };
}

test("a housekeeping compaction persists the goal but arms no reminder and queues no continuation", async () => {
	const { calls, reminderPending } = await compactWith({ housekeeping: true });
	assert.equal(calls.flushes, 1, "the buffered transaction is still flushed");
	assert.equal(calls.persists, 1, "the goal is still persisted");
	assert.equal(reminderPending, false, "no post-compaction reminder is armed");
	assert.equal(calls.continuations, 0, "no continuation is queued");
});

test("a regular compaction still arms the reminder and queues the continuation", async () => {
	for (const details of [undefined, {}, { housekeeping: false }, { housekeeping: "true" }]) {
		const { calls, reminderPending } = await compactWith(details);
		assert.equal(calls.flushes, 1, JSON.stringify(details));
		assert.equal(calls.persists, 1, JSON.stringify(details));
		assert.equal(reminderPending, true, `reminder armed for ${JSON.stringify(details)}`);
		assert.equal(calls.continuations, 1, `continuation queued for ${JSON.stringify(details)}`);
	}
});
