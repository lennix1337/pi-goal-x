import { newGoalRunLimit, formatRunLimit, effectiveRunLimit } from "./goal-run-budget.ts";
import * as path from "node:path";
import { goalStorageContext, goalStorageRoot } from "./storage/goal-root.ts";
import { type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FOCUS_ENTRY, STATE_ENTRY, GOAL_EVENT_ENTRY, goalDetails } from "./goal-format.ts";
import { loadGoalSettings, loadGoalSettingsFileConfig } from "./goal-settings.ts";
import {
	ALL_REGISTERED_GOAL_TOOLS,
	DRAFTING_GOAL_TOOLS,
	applicableGoalTools,
} from "./goal-tool-names.ts";
import { budgetReached } from "./goal-accounting.ts";
import {
	asRecord,
	cloneGoal,
	createGoal,
	goalFocusDetails,
	normalizeGoalFocusEntry,
	normalizeGoalRecord,
	nowIso,
	type GoalCreationConfig,
	type GoalEventDetails,
	type GoalFocusEntry,
	type GoalFocusReason,
	type GoalRecord,
	type GoalStatus,
	type StopReason,
} from "./goal-record.ts";
import {
	mergeGoalPromptFromDisk,
	readActiveGoalPoolAsync,
	sanitizeGoalPaths,
} from "./storage/goal-files.ts";
import { GoalService } from "./goal-service.ts";
import { goalActivityEvents } from "./goal-ledger.ts";
import { GoalAccounting } from "./goal-accounting.ts";
import { newGoalScheduler } from "./goal-scheduler-state.ts";
import { GoalScheduler } from "./goal-scheduler.ts";
import { CONTINUATION_HOLD_EVENT, GoalRuntime } from "./goal-runtime.ts";
import { GoalAuditMessages } from "./goal-session-safety.ts";
import {
	focusedGoalFromPool,
	openGoalsFromPool,
	otherOpenGoalCount,
	resolveSessionFocus,
} from "./goal-pool.ts";
import { buildGoalRunningNotification } from "./widgets/goal-notifications.ts";
import { GOAL_WIDGET_KEY, GoalWidgetComponent, liveDisplayGoal, makeGoalWidgetFactory, type AuditorWidgetProgress } from "./widgets/goal-widget.ts";
import { GOAL_STATUS_EVENT, GoalLineWidget, goalStatusPayload, goalWidgetLine, type GoalStatusPayload } from "./goal-status-line.ts";
import type { AuditVerdict } from "./widgets/auditor-dashboard-model.ts";
import { runGoalCompletionAuditor } from "./goal-auditor.ts";
import type { runBlockerOracle } from "./goal-oracle.ts";



/** Injectable runners; production defaults are the real auditor and Oracle. */
export interface GoalCoreDependencies {
	runCompletionAuditor?: typeof runGoalCompletionAuditor;
	runBlockerOracle?: typeof runBlockerOracle;
}

/**
 * The shared mutable core of the goal extension. All state lives here; the
 * tools/commands/events/widget modules receive this core and operate on it.
 * `state.goal` mirrors the old `state` object: reading returns the focused
 * goal, assigning replaces it in the pool and updates the focus.
 */
export interface GoalCore {
	pi: ExtensionAPI;
	dependencies: GoalCoreDependencies;
	state: { goal: GoalRecord | null };
	readonly goalsById: Map<string, GoalRecord>;
	readonly focusedGoalId: string | null;
	readonly focusRevision: number;
	hasExplicitSessionFocus: boolean;
	runningGoalId: string | null;
	auditProgress: AuditorWidgetProgress | null;
	auditAnimationTimer: ReturnType<typeof setInterval> | null;
	auditAbortController: AbortController | null;
	auditResult: { verdict: AuditVerdict; report: string; at: string } | null;
	setAuditResult(verdict: AuditVerdict, report: string): void;
	clearAuditResult(): void;
	goalModalDepth: number;
	enterGoalModal(): void;
	exitGoalModal(): void;
	tasksEnabled: boolean;
	debugMode: boolean;
	terminalInputUnsubscribe: (() => void) | null;
	goalWidgetComponentRef: { current: GoalWidgetComponent | null };
	goalService: GoalService;
	runtime: GoalRuntime;
	scheduler: GoalScheduler;
	auditMessages: GoalAuditMessages;
	accounting: GoalAccounting;

	assignFocusedGoalId(goalId: string | null): void;
	focusedOperationToken(goalId: string): { goalId: string; revision: number };
	isFocusedOperationCurrent(token: { goalId: string; revision: number }): boolean;
	focusedOperationCancelledResult(action: string, token: { goalId: string; revision: number }): AgentToolResult<unknown>;
	installGoalToolProfile(tasksEnabled: boolean): void;
	installDraftingToolProfile(): void;
	stopAuditAnimation(): void;
	abortAudit(ctx: ExtensionContext): void;
	clearContinuationTimer(): void;
	clearContinuationState(resetNetworkErrorBackoff?: boolean): void;
	clearActiveAccounting(): void;
	advanceTurnSeq(): void;
	currentTurnStoppedGoalId(): string | null;
	isActionableContinuationGoal(goalId: string | null | undefined): goalId is string;
	isStaleCheckpointBlockedToolCall(toolName: string): boolean;
	clearStoppedRuntimeState(): void;
	openGoals(): GoalRecord[];
	toggleDashboardExpanded(): void;
	isDashboardExpanded(): boolean;
	reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts?: { preserveMemoryUsage?: boolean }): boolean;
	appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void;
	setFocusedGoalId(goalId: string | null, ctx: ExtensionContext, reason: GoalFocusReason, opts?: { recordLedger?: boolean }): void;
	updateFocusedGoal(next: GoalRecord, ctx: ExtensionContext, shouldPersist?: boolean): void;
	armFocusedContinuation(ctx: ExtensionContext): void;
	removeFocusedGoal(ctx: ExtensionContext, reason: GoalFocusReason): void;
	beginAccounting(): void;
	goalForDisplay(): GoalRecord | null;
	accountProgress(ctx: ExtensionContext, opts?: { completedTurnTokens?: number }): void;
	syncGoalPromptFromDisk(ctx: ExtensionContext): boolean;
	persist(ctx?: ExtensionContext): void;
	refreshGoalDisplayFromDisk(ctx: ExtensionContext): void;
	updateUI(ctx: ExtensionContext): void;
	clearGoalWidget(ctx: ExtensionContext): void;
	loadState(ctx: ExtensionContext): Promise<void>;
	setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist?: boolean, focusReason?: GoalFocusReason): void;
	archiveCurrentGoal(ctx: ExtensionContext, reason: StopReason | undefined): GoalRecord | null;
	stopActiveGoal(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void;
	pauseActiveGoal(ctx: ExtensionContext): void;
	toggleGoalAuditor(ctx: ExtensionContext): void;
	queueContinuation(ctx: ExtensionContext, force?: boolean): void;
	flushGoalTransaction(ctx: ExtensionContext): void;
	replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow?: boolean, verificationContract?: string, tokenBudget?: number): void;
	touchGoalActivity(): void;
	/** Return a steering note when an active auto-continue goal has stalled. */
	checkStall(ctx: ExtensionContext): string;
}

export function createGoalCore(
	pi: ExtensionAPI,
	dependencies: GoalCoreDependencies = {},
): GoalCore {
	let goalsById = new Map<string, GoalRecord>();
	let focusedGoalId: string | null = null;
	let focusRevision = 0;
	let hasExplicitSessionFocus = false;

	function assignFocusedGoalId(next: string | null): void {
		if (focusedGoalId !== next) focusRevision += 1;
		focusedGoalId = next;
		if (toolProfile === "execution") installGoalToolProfile(tasksEnabled);
	}

	function focusedOperationToken(goalId: string): { goalId: string; revision: number } {
		return { goalId, revision: focusRevision };
	}

	function isFocusedOperationCurrent(token: { goalId: string; revision: number }): boolean {
		return focusedGoalId === token.goalId && focusRevision === token.revision;
	}

	function focusedOperationCancelledResult(action: string, token: { goalId: string; revision: number }) {
		return {
			content: [{
				type: "text" as const,
				text: `${action} cancelled because goal ${token.goalId} is no longer focused in this session. The shared goal was not modified.`,
			}],
			details: goalDetails(state.goal),
			terminate: true,
		};
	}

	const state = {
		get goal(): GoalRecord | null {
			return focusedGoalFromPool(goalsById, focusedGoalId);
		},
		set goal(next: GoalRecord | null) {
			if (next) {
				goalsById.set(next.id, next);
				assignFocusedGoalId(next.id);
				return;
			}
			if (focusedGoalId) goalsById.delete(focusedGoalId);
			assignFocusedGoalId(null);
		},
	};

	const goalService = new GoalService({
		getFocused: () => state.goal,
		setFocused: (goal) => {
			state.goal = goal;
		},
		getPool: () => goalsById,
		replacePool: (pool) => {
			goalsById = pool;
		},
		getFocusedGoalId: () => focusedGoalId,
		assignFocusedGoalId: (goalId) => assignFocusedGoalId(goalId),
		focusToken: (goalId) => focusedOperationToken(goalId),
		isTokenCurrent: (token) => isFocusedOperationCurrent(token),
		appendFocusEntry: (goalId, reason) => appendFocusEntry(goalId, reason),
		onFocusedGoalLost: (lostGoalId, ctx) => {
			clearStoppedRuntimeState();
			updateUI(ctx as unknown as ExtensionContext);
		},
		onReconciled: (goal) => {
			if (goal.status !== "active" || !goal.autoContinue) clearContinuationState();
			if (goal.status !== "active") clearActiveAccounting();
		},
		onFocusChanged: () => {
			clearContinuationState();
			clearActiveAccounting();
		},
		onDiagnostic: (diagnostic) => {
			console.warn(`[pi-goal] ${diagnostic.source} diagnostic: ${diagnostic.message}`);
		},
	});
	let runningGoalId: string | null = null;
	let terminalInputUnsubscribe: (() => void) | null = null;
	let auditProgress: AuditorWidgetProgress | null = null;
	let auditAnimationTimer: ReturnType<typeof setInterval> | null = null;
	let auditResult: { verdict: AuditVerdict; report: string; at: string } | null = null;
	let auditResultClearTimer: ReturnType<typeof setTimeout> | null = null;

	function setAuditResult(verdict: AuditVerdict, report: string): void {
		auditResult = { verdict, report, at: nowIso() };
		if (auditResultClearTimer) clearTimeout(auditResultClearTimer);
		auditResultClearTimer = setTimeout(() => {
			auditResult = null;
			auditResultClearTimer = null;
			goalWidgetComponentRef.current?.invalidate();
		}, 6000);
		auditResultClearTimer.unref?.();
		goalWidgetComponentRef.current?.invalidate();
	}

	function clearAuditResult(): void {
		if (auditResultClearTimer) clearTimeout(auditResultClearTimer);
		auditResultClearTimer = null;
		auditResult = null;
	}
	let auditAbortController: AbortController | null = null;

	let goalModalDepth = 0;
	let debugMode = false;
	let dashboardExpanded = false;


	let scheduler: GoalScheduler;
	const runtime = new GoalRuntime({
		authorize: ctx => scheduler.claim(ctx),
		recover: ctx => scheduler.recover(ctx),
		dispatchFailed: ctx => scheduler.failedDispatch(ctx),
		sendFollowUp: (content, details) => {
			pi.sendMessage<GoalEventDetails>(
				{
					customType: GOAL_EVENT_ENTRY,
					content,
					display: false,
					details: details as unknown as GoalEventDetails,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		held: () => {
			let reason: string | undefined;
			pi.events.emit(CONTINUATION_HOLD_EVENT, { hold: (why: string) => { reason ??= why; } });
			return reason;
		},
		getGoal: () => state.goal,
		isActionable: (goalId) => isActionableContinuationGoal(goalId),
	});
	const accounting = new GoalAccounting();

	let tasksEnabled = true;
	let toolProfile: "uninitialized" | "execution" | "drafting" = "uninitialized";


	function installGoalToolProfile(tasksEnabledArg: boolean): void {
		toolProfile = "execution";
		try {
			const current = new Set(pi.getActiveTools());
			for (const knownGoalTool of ALL_REGISTERED_GOAL_TOOLS) current.delete(knownGoalTool);
			for (const goalTool of applicableGoalTools(state.goal, tasksEnabledArg)) current.add(goalTool);
			const next = [...current].sort();
			const before = [...pi.getActiveTools()].sort();
			if (next.length !== before.length || next.some((name, index) => name !== before[index])) {
				pi.setActiveTools([...current]);
			}
			tasksEnabled = tasksEnabledArg;
		} catch (err) {
			console.error("[pi-goal] installGoalToolProfile error:", err instanceof Error ? err.message : String(err));
		}
	}

	function installDraftingToolProfile(): void {
		toolProfile = "drafting";
		try {
			const current = new Set(pi.getActiveTools());
			for (const knownGoalTool of ALL_REGISTERED_GOAL_TOOLS) current.delete(knownGoalTool);
			for (const goalTool of DRAFTING_GOAL_TOOLS) current.add(goalTool);
			const next = [...current].sort();
			const before = [...pi.getActiveTools()].sort();
			if (next.length !== before.length || next.some((name, index) => name !== before[index])) {
				pi.setActiveTools([...current]);
			}
		} catch (err) {
			console.error("[pi-goal] installDraftingToolProfile error:", err instanceof Error ? err.message : String(err));
		}
	}

	function stopAuditAnimation(): void {
		if (auditAnimationTimer) {
			clearInterval(auditAnimationTimer);
			auditAnimationTimer = null;
		}
	}

	function abortAudit(ctx: ExtensionContext): void {
		if (!auditAbortController || !auditProgress) return;
		auditAbortController.abort();
		auditAbortController = null;
		stopAuditAnimation();
		auditProgress = null;
		goalWidgetComponentRef.current?.invalidate();
	}

	function clearContinuationTimer(): void {
		runtime.clearContinuationTimer();
	}

	function clearContinuationState(resetNetworkErrorBackoff = true): void {
		scheduler?.cancelTimer();
		runtime.clearContinuationState(resetNetworkErrorBackoff);
	}

	function clearActiveAccounting(): void {
		accounting.clear();
	}

	function advanceTurnSeq(): void {
		runtime.advanceTurn();
	}

	function currentTurnStoppedGoalId(): string | null {
		return runtime.currentTurnStoppedGoalId();
	}

	function isActionableContinuationGoal(goalId: string | null | undefined): goalId is string {
		return !!goalId && state.goal?.id === goalId && state.goal.status === "active" && state.goal.autoContinue;
	}

	function isStaleCheckpointBlockedToolCall(toolName: string): boolean {
		return runtime.isStaleCheckpointBlocked(toolName);
	}

	function clearStoppedRuntimeState(): void {
		clearContinuationState();
		clearActiveAccounting();
	}

	function openGoals(): GoalRecord[] {
		return openGoalsFromPool(goalsById);
	}

	function reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts: { preserveMemoryUsage?: boolean } = {}): boolean {
		return goalService.reconcileFocused(ctx, opts);
	}

	let focusStorageRoot: string | undefined;
	let externalFocusRoot = false;
	function appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void {
		hasExplicitSessionFocus = true;
		pi.appendEntry(FOCUS_ENTRY, { ...goalFocusDetails(goalId, reason), ...(externalFocusRoot ? { storageRoot: focusStorageRoot } : {}) });
	}

	function setFocusedGoalId(
		goalId: string | null,
		ctx: ExtensionContext,
		reason: GoalFocusReason,
		opts: { recordLedger?: boolean } = {},
	): void {
		const previousGoalId = focusedGoalId;
		if (previousGoalId !== goalId) scheduler.takeover(ctx);
		if (previousGoalId !== goalId) goalService.flushTurn(ctx);
		assignFocusedGoalId(goalId && goalsById.has(goalId) ? goalId : null);
		if (previousGoalId !== focusedGoalId) {
			clearContinuationState();
			clearActiveAccounting();
		}
		appendFocusEntry(focusedGoalId, reason);
		try {
			if (opts.recordLedger !== false && focusedGoalId) {
				goalService.appendEvents(ctx, [{ type: "goal_focused", goalId: focusedGoalId, reason, at: nowIso() }]);
			} else if (opts.recordLedger !== false && previousGoalId) {
				goalService.appendEvents(ctx, [{ type: "goal_unfocused", reason, at: nowIso() }]);
			}
		} catch {
		}
		updateUI(ctx);
	}

	function updateFocusedGoal(next: GoalRecord, ctx: ExtensionContext, shouldPersist = true): void {
		goalsById.set(next.id, next);
		assignFocusedGoalId(next.id);
		if (shouldPersist) persist(ctx);
		updateUI(ctx);
	}

	function armFocusedContinuation(ctx: ExtensionContext): void {
		beginAccounting();
		if (state.goal?.status === "active" && state.goal.autoContinue) queueContinuation(ctx, true);
	}

	function removeFocusedGoal(ctx: ExtensionContext, reason: GoalFocusReason): void {
		goalService.flushTurn(ctx);
		if (focusedGoalId) goalsById.delete(focusedGoalId);
		assignFocusedGoalId(null);
		clearStoppedRuntimeState();
		appendFocusEntry(null, reason);
		updateUI(ctx);
	}

	function beginAccounting(): void {
		if (scheduler?.isWaiting()) { clearActiveAccounting(); return; }
		if (!state.goal || (state.goal.status !== "active")) {
			clearActiveAccounting();
			return;
		}
		accounting.begin(state.goal.id);
	}

	function goalForDisplay(): GoalRecord | null {
		return liveDisplayGoal(state.goal, accounting);
	}

	function accountProgress(ctx: ExtensionContext, opts: { completedTurnTokens?: number } = {}): void {
		if (state.goal?.activePath && state.goal?.status !== "complete" && !reconcileFocusedGoalFromDisk(ctx, { preserveMemoryUsage: true })) return;
		if (!state.goal || state.goal.status !== "active" || !accounting.isActiveFor(state.goal.id)) {
			beginAccounting();
			return;
		}

		const { tokens, seconds } = accounting.charge({ completedTurnTokens: opts.completedTurnTokens });
		if (tokens === 0 && seconds === 0) return;

		const next = cloneGoal(state.goal);
		next.usage.tokensUsed += tokens;
		next.usage.activeSeconds += seconds;
		next.updatedAt = nowIso();
		state.goal = next;
		persist(ctx);

		const budgetGoal = state.goal;
		if (budgetGoal && budgetGoal.status === "active" && typeof budgetGoal.tokenBudget === "number" && budgetGoal.tokenBudget > 0 && budgetGoal.usage.tokensUsed > 0) {
			const pct = budgetGoal.usage.tokensUsed / budgetGoal.tokenBudget;
			const crossed = [0.5, 0.75, 0.9].filter(threshold => pct >= threshold && !budgetWarningsFired.has(`${budgetGoal.id}:${budgetGoal.tokenBudget}:${threshold}`));
			for (const threshold of crossed) budgetWarningsFired.add(`${budgetGoal.id}:${budgetGoal.tokenBudget}:${threshold}`);
			if (crossed.length) {
				try {
					goalService.appendEvents(ctx, [{type: "goal_budget_warning", goalId: budgetGoal.id, budget: budgetGoal.tokenBudget, tokensUsed: budgetGoal.usage.tokensUsed, pct: Math.round(pct * 100), at: nowIso()}]);
				} catch { }
				ctx.ui.notify(`Token budget ${Math.round(pct * 100)}% used (${budgetGoal.usage.tokensUsed}/${budgetGoal.tokenBudget} tokens). Use /goal-tweak to change or remove the budget.`, "warning");
			}
		}

		if (budgetGoal && budgetGoal.status === "active" && typeof budgetGoal.tokenBudget === "number" && budgetReached(budgetGoal)) {
			const transition = goalService.apply(ctx, {
				reconcile: false,
				mutate: (g) => ({ ...g, status: "budget_limited" as const, updatedAt: nowIso() }),
				ledger: (written) => [{
					type: "goal_budget_limited",
					goalId: written.id,
					budget: budgetGoal.tokenBudget ?? 0,
					tokensUsed: written.usage.tokensUsed,
					at: written.updatedAt,
				}],
			});
			if (transition.ok) {
				runtime.armPostBudgetReminder();
				runtime.clearContinuationState();
				accounting.clear();
				updateUI(ctx);
			}
		}
	}

	function syncGoalPromptFromDisk(ctx: ExtensionContext): boolean {
		if (!state.goal || state.goal.status === "complete") return false;
		const previousObjective = state.goal.objective;
		state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
		return state.goal.objective !== previousObjective;
	}

	function persist(ctx?: ExtensionContext): void {
		if (ctx) {
			goalService.persist(ctx);
		} else {
			const current = state.goal;
			if (current) state.goal = { ...current, updatedAt: nowIso() };
		}
		if (ctx) updateUI(ctx);
	}

	function refreshGoalDisplayFromDisk(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status === "complete") return;
		if (syncGoalPromptFromDisk(ctx)) {
			state.goal = { ...state.goal, updatedAt: nowIso() };
		}
		updateUI(ctx);
	}

	const goalWidgetComponentRef: { current: GoalWidgetComponent | null } = { current: null };
	const goalLineWidgetRef: { current: GoalLineWidget | null } = { current: null };
	type WidgetMode = "none" | "line" | "full";
	let widgetMode: WidgetMode = "none";
	const EMPTY_STATUS: GoalStatusPayload = { text: "", focused: false, open: 0 };
	let lastPublishedStatus = "";

	function emitGoalStatus(payload: GoalStatusPayload): void {
		const key = JSON.stringify(payload);
		if (key === lastPublishedStatus) return;
		lastPublishedStatus = key;
		pi.events?.emit(GOAL_STATUS_EVENT, payload);
	}

	function clearGoalWidget(ctx: ExtensionContext): void {
		lastUiCtx = null;
		if (ctx.hasUI) {
			ctx.ui.setStatus("goal", undefined);
			ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
			emitGoalStatus(EMPTY_STATUS);
		}
		widgetMode = "none";
		goalWidgetComponentRef.current = null;
		goalLineWidgetRef.current = null;
	}

	// external: terminal redraws can pull users out of scrollback.

	let lastGoalActivityAt = Date.now();
	let stallNotified = false;
	const budgetWarningsFired = new Set<string>();

	function touchGoalActivity(): void {
		lastGoalActivityAt = Date.now();
		stallNotified = false;
	}

	function checkStall(ctx: ExtensionContext): string {
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return "";
		const timeoutMinutes = loadGoalSettings(ctx.cwd).stallTimeoutMinutes ?? 0;
		if (timeoutMinutes <= 0 || stallNotified) return "";
		const idleMs = Date.now() - lastGoalActivityAt;
		if (idleMs < timeoutMinutes * 60_000) return "";
		stallNotified = true;
		const goalId = state.goal.id;
		try {
			goalService.appendEvents(ctx, [{
				type: "goal_stalled",
				goalId,
				reason: `No continuation or tool activity for ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}.`,
				at: nowIso(),
			}]);
		} catch {
		}
		ctx.ui.notify(`Goal stalled: no activity for ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}.`, "warning");
		return `\n\n[GOAL STALLED goalId=${goalId}]\nNo continuation or tool activity for ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"}. Report your progress or ask the user to pause or resume the goal.`;
	}

	let uiFlushScheduled = false;
	let lastUiCtx: ExtensionContext | null = null;

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		lastUiCtx = ctx;
		if (uiFlushScheduled) return;
		uiFlushScheduled = true;
		queueMicrotask(() => {
			uiFlushScheduled = false;
			if (lastUiCtx) renderUI(lastUiCtx);
		});
	}

	function renderUI(ctx: ExtensionContext): void {
		const totalOpen = otherOpenGoalCount(goalsById, null);
		if (!state.goal && totalOpen === 0) {
			clearGoalWidget(ctx);
			return;
		}
		if (!state.goal && loadGoalSettings(ctx.cwd).hideUnfocusedBanner === true) {
			clearGoalWidget(ctx);
			return;
		}

		const display = goalForDisplay() ?? state.goal;
		const payload = goalStatusPayload({ goal: display, openCount: totalOpen, auditing: auditProgress !== null, stalled: stallNotified });
		const published = JSON.stringify(payload);
		if (published !== lastPublishedStatus) ctx.ui.setStatus("goal", payload.text || undefined);
		emitGoalStatus(payload);

		const fullDashboard = state.goal !== null && (dashboardExpanded || auditProgress !== null || auditResult !== null);
		const mode: WidgetMode = fullDashboard
			? "full"
			: goalWidgetLine(display, { auditor: auditProgress, stalled: stallNotified }) !== null ? "line" : "none";
		syncWidgetMode(ctx, mode);
	}

	function syncWidgetMode(ctx: ExtensionContext, mode: WidgetMode): void {
		if (mode === widgetMode) {
			goalWidgetComponentRef.current?.update();
			goalLineWidgetRef.current?.update();
			return;
		}
		widgetMode = mode;
		goalWidgetComponentRef.current = null;
		goalLineWidgetRef.current = null;
		if (mode === "none") {
			ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
			return;
		}
		if (mode === "line") {
			ctx.ui.setWidget(
				GOAL_WIDGET_KEY,
				(tui, theme) => {
					const component = new GoalLineWidget(tui, theme, () => goalWidgetLine(goalForDisplay() ?? state.goal, { auditor: auditProgress, stalled: stallNotified }));
					goalLineWidgetRef.current = component;
					return component;
				},
				{ placement: "aboveEditor" },
			);
			return;
		}
		const goalCwd = ctx.cwd;
		const storage = goalStorageContext(ctx);
		ctx.ui.setWidget(
			GOAL_WIDGET_KEY,
			makeGoalWidgetFactory({
				getGoal: () => goalForDisplay() ?? state.goal,
				getOpenGoalCount: () => otherOpenGoalCount(goalsById, null),
				getAuditorProgress: () => auditProgress,
				getSettings: () => loadGoalSettings(goalCwd),
				getDebugMode: () => debugMode,
				getStalled: () => stallNotified,
				getExpanded: () => dashboardExpanded,
				getLedgerEvents: () => state.goal ? goalActivityEvents(storage, state.goal.id) : [],
				getAuditResult: () => auditResult,
				componentRef: goalWidgetComponentRef,
			}),
			{ placement: "aboveEditor" },
		);
	}

	async function loadState(ctx: ExtensionContext): Promise<void> {
		clearGoalWidget(ctx);
		focusStorageRoot = goalStorageRoot(ctx);
		externalFocusRoot = focusStorageRoot !== path.resolve(ctx.cwd, ".pi/goals");
		goalsById = await readActiveGoalPoolAsync(ctx);
		tasksEnabled = !loadGoalSettings(ctx.cwd).disableTasks;
		focusRevision += 1;
		assignFocusedGoalId(null);
		hasExplicitSessionFocus = false;
		let focusEntry: GoalFocusEntry | null = null;
		let legacyGoal: GoalRecord | null = null;
		let legacyStateSeen = false;
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
			if (entry.type !== "custom") continue;
			if (!focusEntry && entry.customType === FOCUS_ENTRY) {
				focusEntry = normalizeGoalFocusEntry(entry.data);
			}
			if (!legacyStateSeen && entry.customType === STATE_ENTRY) {
				legacyGoal = normalizeGoalRecord(asRecord(entry.data)?.goal);
				legacyStateSeen = true;
			}
			if (focusEntry && legacyStateSeen) break;
		}
		if (legacyGoal && legacyGoal.status !== "complete") {
			legacyGoal = sanitizeGoalPaths(ctx, mergeGoalPromptFromDisk(ctx, legacyGoal));
		}
		const settings = loadGoalSettings(ctx.cwd);
		if (focusEntry && (focusEntry.storageRoot ?? path.resolve(ctx.cwd, ".pi/goals")) !== focusStorageRoot) {
			focusEntry = { ...focusEntry, focusedGoalId: null };
			legacyGoal = null;
		}
		if (focusStorageRoot !== path.resolve(ctx.cwd, ".pi/goals")) legacyGoal = null;
		hasExplicitSessionFocus = focusEntry !== null;
		assignFocusedGoalId(resolveSessionFocus({ pool: goalsById, focusEntry, legacyGoal, autoSelectSingleGoal: settings.autoSelectSingleGoal }));
		if (!focusEntry && focusedGoalId) {
			try {
				appendFocusEntry(focusedGoalId, legacyGoal?.id === focusedGoalId ? "migrated" : "selected");
			} catch {}
		}
		for (const [id, current] of goalsById) {
			if (current.status === "complete") {
				goalsById.delete(id);
			}
		}
		clearStoppedRuntimeState();
		runningGoalId = null;
		updateUI(ctx);
	}

	function setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist = true, focusReason?: GoalFocusReason): void {
		const previousGoalId = state.goal?.id ?? null;
		state.goal = next;
		const focusChanged = previousGoalId !== focusedGoalId;
		if (focusChanged) {
			clearContinuationState();
			clearActiveAccounting();
		}
		if (focusReason && focusChanged) appendFocusEntry(focusedGoalId, focusReason);
		if (!state.goal || (state.goal.status !== "active") || !state.goal.autoContinue) {
			clearContinuationState();
		}
		if (!state.goal || state.goal.status === "paused" || state.goal.status === "complete") {
			clearActiveAccounting();
		}
		if (shouldPersist) persist(ctx);
		updateUI(ctx);
	}

	function archiveCurrentGoal(ctx: ExtensionContext, reason: StopReason | undefined): GoalRecord | null {
		if (!state.goal) return null;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			archive: true,
			commitFocused: false,
			mutate: (g) => {
				const status = g.status === "complete" ? "complete" : "paused";
				return { ...g, status, stopReason: reason };
			},
		});
		return result.ok ? result.goal : null;
	}

	function stopActiveGoal(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void {
		if (!state.goal) return;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({ ...g, status, stopReason: reason, updatedAt: nowIso() }),
			ledger: (written) => status === "paused"
				? [{
					type: "goal_paused",
					goalId: written.id,
					reason: reason ?? "unknown",
					suggestedAction: written.pauseSuggestedAction,
					status,
					at: written.updatedAt,
				}]
				: [],
		});
		if (result.ok) {
			clearContinuationState();
			clearActiveAccounting();
			goalService.flushTurn(ctx);
			updateUI(ctx);
		}
	}

	function pauseActiveGoal(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status !== "active") return;
		const pausedGoalId = state.goal.id;
		state.goal = { ...state.goal, autoContinue: false, pauseReason: undefined, pauseSuggestedAction: undefined };
		stopActiveGoal("paused", "user", ctx);
		ctx.ui.notify("Goal paused.", "info");
	}

	function toggleGoalAuditor(ctx: ExtensionContext): void {
		if (!state.goal) {
			ctx.ui.notify("No focused goal to toggle the auditor for.", "info");
			return;
		}
		if (state.goal.status === "complete") {
			ctx.ui.notify("This goal is complete; the auditor no longer applies.", "info");
			return;
		}
		const nextEnabled = state.goal.skipAuditor === true;
		const result = goalService.apply(ctx, {
			reconcile: false,
			refreshFromDisk: true,
			mutate: (g) => ({ ...g, skipAuditor: g.skipAuditor === true ? undefined : true, updatedAt: nowIso() }),
			ledger: (written) => [{ type: "auditor_toggled" as const, goalId: written.id, enabled: nextEnabled, at: written.updatedAt }],
		});
		if (!result.ok) {
			ctx.ui.notify("Could not toggle the auditor: " + result.message, "error");
			return;
		}
		goalService.flushTurn(ctx);
		updateUI(ctx);
		ctx.ui.notify(nextEnabled ? "Auditor enabled for this goal." : "Auditor disabled for this goal.", "info");
	}

	function flushGoalTransaction(ctx: ExtensionContext): void {
		goalService.flushTurn(ctx);
	}

	function queueContinuation(ctx: ExtensionContext, force = false): void {
		void force;
		scheduler.schedule(ctx);
	}

	function enterGoalModal(): void {
		goalModalDepth++;
	}

	function exitGoalModal(): void {
		goalModalDepth = Math.max(0, goalModalDepth - 1);
	}

	function replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow = true, verificationContract?: string, tokenBudget?: number): void {
		const goal = createGoal({...config, maxAutonomousRuns: newGoalRunLimit(config.maxAutonomousRuns, loadGoalSettings(ctx.cwd).maxAutonomousRuns)});
		goal.scheduler = newGoalScheduler(ctx.sessionManager.getSessionId());
		if (verificationContract) goal.verificationContract = verificationContract;
		if (config.taskList) goal.taskList = config.taskList;
		if (typeof tokenBudget === "number" && tokenBudget > 0) goal.tokenBudget = Math.floor(tokenBudget);
		const result = goalService.create(ctx, {
			goal,
		ledger: [
			{
				type: "goal_created",
				goalId: goal.id,
				objective: goal.objective,
				sisyphus: goal.sisyphus,
				autoContinue: goal.autoContinue,
				at: goal.createdAt,
			},
			...(goal.taskList ? [{
				type: "task_list_set" as const,
				goalId: goal.id,
				taskCount: goal.taskList.tasks.length,
				blockCompletion: goal.taskList.blockCompletion,
				at: goal.createdAt,
			}] : []),
		],
		});
		if (result.focusChanged) appendFocusEntry(result.goalId, "created");
		beginAccounting();
		ctx.ui.notify(`${buildGoalRunningNotification(config)}\nBudget: ${goal.tokenBudget === undefined ? "none" : `${goal.tokenBudget} tokens`}\n${formatRunLimit(effectiveRunLimit(goal, loadGoalSettings(ctx.cwd).maxAutonomousRuns))}`, "info");
		if (startNow && state.goal?.autoContinue) scheduler.kickoff(ctx);
	}

	const core: GoalCore = {
		pi,
		dependencies,
		state,
		get goalsById() {
			return goalsById;
		},
		get focusedGoalId() {
			return focusedGoalId;
		},
		get focusRevision() {
			return focusRevision;
		},
		get hasExplicitSessionFocus() {
			return hasExplicitSessionFocus;
		},
		set hasExplicitSessionFocus(value: boolean) {
			hasExplicitSessionFocus = value;
		},
		get runningGoalId() {
			return runningGoalId;
		},
		set runningGoalId(value: string | null) {
			runningGoalId = value;
		},
		get auditProgress() {
			return auditProgress;
		},
		set auditProgress(value: AuditorWidgetProgress | null) {
			auditProgress = value;
		},
		get auditResult() {
			return auditResult;
		},
		set auditResult(value: { verdict: AuditVerdict; report: string; at: string } | null) {
			auditResult = value;
		},
		setAuditResult,
		clearAuditResult,
		get auditAnimationTimer() {
			return auditAnimationTimer;
		},
		set auditAnimationTimer(value: ReturnType<typeof setInterval> | null) {
			auditAnimationTimer = value;
		},
		get auditAbortController() {
			return auditAbortController;
		},
		set auditAbortController(value: AbortController | null) {
			auditAbortController = value;
		},
		get goalModalDepth() {
			return goalModalDepth;
		},
		set goalModalDepth(value: number) {
			goalModalDepth = value;
		},
		get tasksEnabled() {
			return tasksEnabled;
		},
		set tasksEnabled(value: boolean) {
			tasksEnabled = value;
		},
		get debugMode() {
			return debugMode;
		},
		set debugMode(value: boolean) {
			debugMode = value;
		},
		get terminalInputUnsubscribe() {
			return terminalInputUnsubscribe;
		},
		set terminalInputUnsubscribe(value: (() => void) | null) {
			terminalInputUnsubscribe = value;
		},
		toggleDashboardExpanded() {
			dashboardExpanded = !dashboardExpanded;
			goalWidgetComponentRef.current?.invalidate();
			if (lastUiCtx) updateUI(lastUiCtx);
		},
		isDashboardExpanded() {
			return dashboardExpanded;
		},
		goalWidgetComponentRef,
		goalService,
		runtime,
		get scheduler() { return scheduler; },
		auditMessages: new GoalAuditMessages(),
		accounting,
		assignFocusedGoalId,
		focusedOperationToken,
		isFocusedOperationCurrent,
		focusedOperationCancelledResult,
		installGoalToolProfile,
		installDraftingToolProfile,
		stopAuditAnimation,
		abortAudit,
		clearContinuationTimer,
		clearContinuationState,
		clearActiveAccounting,
		advanceTurnSeq,
		currentTurnStoppedGoalId,
		isActionableContinuationGoal,
		isStaleCheckpointBlockedToolCall,
		clearStoppedRuntimeState,
		enterGoalModal,
		exitGoalModal,
		openGoals,
		reconcileFocusedGoalFromDisk,
		appendFocusEntry,
		setFocusedGoalId,
		updateFocusedGoal,
		armFocusedContinuation,
		removeFocusedGoal,
		beginAccounting,
		goalForDisplay,
		accountProgress,
		syncGoalPromptFromDisk,
		persist,
		refreshGoalDisplayFromDisk,
		updateUI,
		clearGoalWidget,
		loadState,
		setGoal,
		archiveCurrentGoal,
		stopActiveGoal,
		pauseActiveGoal,
		toggleGoalAuditor,
		queueContinuation,
		flushGoalTransaction,
		touchGoalActivity,
		checkStall,
		replaceGoal,
	};
	scheduler = new GoalScheduler(core);
	return core;
}
