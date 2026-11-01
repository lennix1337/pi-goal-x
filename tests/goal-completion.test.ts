import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

function createHarness(cwd: string, sessionEntries: unknown[], runCompletionAuditor: (args: unknown) => Promise<unknown>) {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, ToolDefinition>();
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerTool: (def: ToolDefinition) => { tools.set(def.name, def); },
		registerCommand: () => {},
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => sessionEntries,
			getCwd: () => cwd,
			getSessionId: () => "completion-usage-session",
			getRoot: () => cwd,
		},
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, onTerminalInput: () => () => {}, select: async () => undefined, confirm: async () => false, custom: async () => undefined },
		getSystemPrompt: () => "base prompt",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as never, { runCompletionAuditor: runCompletionAuditor as never });
	return { handlers, tools, ctx, core: (pi as unknown as { _goalCore: any })._goalCore };
}

// Machine: goal status active -> complete (docs/state-machines.md, "Goal lifecycle").
// The completion commit must apply onto the goal as it is when the audit ends.
test("update_goal(complete) keeps the usage accrued while the auditor ran", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-completion-usage-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const realNow = Date.now;
	try {
		const goal = createGoal({ objective: "=== Goal ===\nObjective: usage during audit", autoContinue: true, sisyphus: false });
		writeActiveGoalFile({ cwd }, goal);
		const entries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
		const h = createHarness(cwd, entries, async () => {
			// The audit takes two minutes of wall-clock time.
			Date.now = () => realNow() + 125_000;
			return { approved: true, disapproved: false, output: "ok\n<approved/>", model: "mock" };
		});
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "test", systemPromptOptions: {} }, h.ctx);
		await (h.tools.get("update_goal")!.execute as any)("complete-1", { status: "complete" }, undefined, undefined, h.ctx);
		assert.equal(h.core.state.goal.status, "complete");
		assert.ok(h.core.state.goal.usage.activeSeconds >= 120, `audit time must be charged, got ${h.core.state.goal.usage.activeSeconds}s`);
	} finally {
		Date.now = realNow;
		rmSync(cwd, { recursive: true, force: true });
	}
});

// Machine: completion audit (idle -> running -> done) held in auditProgress + auditAnimationTimer + auditAbortController.
test("update_goal(complete) leaves no audit running when the auditor rejects", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-completion-throw-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const goal = createGoal({ objective: "=== Goal ===\nObjective: auditor failure", autoContinue: true, sisyphus: false });
		writeActiveGoalFile({ cwd }, goal);
		const entries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
		const h = createHarness(cwd, entries, async () => { throw new Error("auditor session could not start"); });
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "test", systemPromptOptions: {} }, h.ctx);
		await assert.rejects((h.tools.get("update_goal")!.execute as any)("complete-2", { status: "complete" }, undefined, undefined, h.ctx), /auditor session could not start/);
		assert.equal(h.core.auditProgress, null, "a phantom audit would make Escape abort nothing instead of pausing the goal");
		assert.equal(h.core.auditAnimationTimer, null, "the spinner interval must be cleared");
		assert.equal(h.core.auditAbortController, null);
		assert.equal(h.core.state.goal.status, "active");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
