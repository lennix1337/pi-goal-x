import { cacheGoalHistory } from "./goal-prompt-cache.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	GOAL_EVENT_ENTRY,
	assistantTurnTokens,
	extractGoalIdFromInjectedMessage,
	goalEventMessageId,
	hasAbortedAssistantMessage,
	hasErrorAssistantMessage,
	hasNetworkErrorAssistantMessage,
	isAbortedAssistantMessage,
	isErrorAssistantMessage,
	isMeaningfulProgressToolCall,
} from "./goal-format.ts";
import { buildCompactionSummary, buildPostCompactionGoalDelta } from "./goal-compaction.ts";
import { latestAuditorResultForGoal, readGoalLedger, goalRuntimeEvents, invalidateGoalLedgerCache } from "./goal-ledger.ts";
import { shouldArmPostCompactReminder, shouldInjectPostCompactReminder } from "./goal-policy.ts";
import { formatTokenValue } from "./goal-core.ts";
import { loadGoalSettings, invalidateGoalSettingsCache } from "./goal-settings.ts";
import { modelBudgetLine, budgetRemaining } from "./goal-accounting.ts";
import { asRecord, nowIso, type AssistantMessageLike, type GoalRecord } from "./goal-record.ts";
import { goalSelectorLabel, otherOpenGoalCount } from "./goal-pool.ts";
import { invalidateGoalPoolCache } from "./storage/goal-files.ts";
import { checkpointTriggerPrompt } from "./prompts/goal-prompts.ts";
import { consumeOracleFollowupMarker, hasPendingOracleAdviceForFocusedGoal } from "./goal-oracle.ts";
import { LiveTailRetention } from "./goal-live-retention.ts";
import {
	goalPromptParts,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";
import { hasActiveDraft, rehydrateDraft } from "./goal-drafting.ts";
import { syncTerminalInputPause } from "./goal-widget.ts";
import type { GoalCore } from "./goal-state.ts";
import { filterGoalSessionContext } from "./goal-session-safety.ts";
import type { GoalMutationOutcome } from "./goal-service.ts";

/** Normalize checkpoints independently: deleting old markers shifts the cached prefix. */
export function compactGoalCheckpointContext(
 messages: readonly unknown[],
 _currentGoal: GoalRecord | null,
): unknown[] | null {
 let output: unknown[] | null = null;
 for (let i = 0; i < messages.length; i++) {
  const message = messages[i] as { customType?: string; details?: unknown; content?: unknown };
  const id = goalEventMessageId(message);
  if (id === null) { output?.push(message); continue; }
  output ??= messages.slice(0, i);
  output.push({ ...message, content: checkpointTriggerPrompt(id), display: false,
   details: { version: 2, kind: "checkpoint", goalId: id } });
 }
 return output;
}

/** Register goal lifecycle event handlers. */
export function registerGoalEvents(core: GoalCore): void {
	const { pi } = core;
	const liveRetention = new LiveTailRetention();
	const sessionKeyFor = (ctx?: ExtensionContext): string =>
		ctx?.sessionManager?.getSessionId?.() ? JSON.stringify([ctx.sessionManager.getSessionId(), ctx.model?.provider, ctx.model?.id]) : "unidentified";
	pi.on("before_provider_request", (event, ctx) => cacheGoalHistory(event.payload, liveRetention.contents(sessionKeyFor(ctx as ExtensionContext | undefined))));
	let continuationAfterSettleFor: string | null = null;
	let networkErrorRecoveryAfterSettleFor: string | null = null;

	pi.on("context", async (event, ctx) => {
		const filtered = filterGoalSessionContext(event.messages);
		const messages = compactGoalCheckpointContext(filtered ?? event.messages, core.state.goal) ?? filtered;
		const base = messages ?? event.messages;
		const sessionKey = sessionKeyFor(ctx);
		if (sessionKey === "unidentified") liveRetention.clear(sessionKey);
		const parts = currentGoalContextParts(ctx);
		if (parts) {
			const { messages: retained } = liveRetention.apply(sessionKey, base, { state: parts.state, counters: parts.counters });
			return { messages: retained as typeof event.messages };
		}
		liveRetention.clear(sessionKey);
		return messages === null ? undefined : { messages: messages as typeof event.messages };
	});

	pi.on("agent_start", async (_event, ctx) => { core.scheduler.begin(ctx); });
	pi.on("message_start", async (event, ctx) => { core.scheduler.message(ctx, event.message); });
	pi.on("turn_start", async (_event, ctx) => {
		core.scheduler.turn(ctx);
		core.advanceTurnSeq();
		core.beginAccounting();
		core.goalService.beginTurn(ctx, core.focusedGoalId);
		core.touchGoalActivity();
		core.updateUI(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const stoppedGoalId = core.currentTurnStoppedGoalId();
		if (core.scheduler.isDenied()) return { block: true, reason: "Stale goal dispatch; use /goal-resume." };
		if (stoppedGoalId !== null && core.runtime.isStaleCheckpointBlocked(event.toolName)) {
			return {
				block: true,
				reason: `The goal was already stopped earlier in this turn (goalId=${stoppedGoalId}). ` +
					`Do not call more tools; end the turn with a brief summary and yield to the user.`,
			};
		}
		const checkpointGoalId = core.runtime.getCheckpointGoalId();
		if (checkpointGoalId !== null && !core.isActionableContinuationGoal(checkpointGoalId) && core.isStaleCheckpointBlockedToolCall(event.toolName)) {
			return {
				block: true,
				reason: `Cannot call ${event.toolName}: the goal checkpoint that triggered this turn is no longer active. ` +
					`Goal ${checkpointGoalId} has been paused, cleared, or replaced. ` +
					`End the turn with a brief summary and yield to the user.`,
			};
		}
		if (isMeaningfulProgressToolCall(event.toolName, asRecord(event)?.args)) {
			const focusedId = core.focusedGoalId;
			if (focusedId && hasPendingOracleAdviceForFocusedGoal(focusedId)) {
				const armed = consumeOracleFollowupMarker(focusedId);
				if (armed) {
					try {
						core.goalService.appendEvents(ctx, [{
							type: "oracle_followup_attempted",
							goalId: armed.goalId,
							fingerprint: armed.fingerprint,
							adviceId: armed.adviceId,
							firstToolName: event.toolName,
							at: nowIso(),
						}]);
					} catch { }
				}
			}
		}
		return;
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		core.touchGoalActivity();
		core.accountProgress(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as AssistantMessageLike;
		const tokens = assistantTurnTokens(message);
		core.touchGoalActivity();
		core.accountProgress(ctx, { completedTurnTokens: tokens });

		if (isAbortedAssistantMessage(message)) {
			// external: provider or transport aborts can occur without a user abort signal.
			if (ctx.signal?.aborted) core.pauseActiveGoal(ctx);
			return;
		}
		if (isErrorAssistantMessage(message)) {
			core.refreshGoalDisplayFromDisk(ctx);
			core.updateUI(ctx);
			return;
		}
		core.refreshGoalDisplayFromDisk(ctx);

		if (core.state.goal?.status === "complete" && !core.state.goal?.archivedPath) {
			const completedGoal = core.state.goal;
			let archiveResult: GoalMutationOutcome;
			try {
				archiveResult = core.goalService.apply(ctx, {
					reconcile: false,
					archive: true,
					commitFocused: false,
					mutate: () => completedGoal,
					ledger: (written) => [{
						type: "goal_completed",
						goalId: completedGoal.id,
						archivePath: written.archivedPath,
						at: nowIso(),
					}],
				});
			} catch (err) {
				archiveResult = { ok: false, message: err instanceof Error ? err.message : String(err) };
			}
			if (archiveResult.ok) {
				core.goalsById.delete(completedGoal.id);
				core.assignFocusedGoalId(null);
				core.appendFocusEntry(null, "completed");
				try {
					core.goalService.appendEvents(ctx, [{
						type: "goal_archived",
						goalId: completedGoal.id,
						archivePath: archiveResult.goal?.archivedPath ?? "",
						at: nowIso(),
					}]);
				} catch {
				}
				const path = archiveResult.goal?.archivedPath ?? "";
				ctx.ui.notify(path ? `Goal archived.\nFile: ${path}` : "Goal archived.", "info");
			} else {
				const remainingPath = completedGoal.activePath ?? "(unknown)";
				ctx.ui.notify(`Failed to archive completed goal: ${archiveResult.message}. The complete record remains at ${remainingPath}.`, "warning");
				try {
					core.goalService.appendEvents(ctx, [{
						type: "goal_archive_failed",
						goalId: completedGoal.id,
						message: archiveResult.message ?? "archive write failed",
						at: nowIso(),
					}]);
				} catch {
				}
			}
			core.updateUI(ctx);
		}

		core.goalService.endTurn(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (isAbortedAssistantMessage(event.message) && ctx.signal?.aborted) core.pauseActiveGoal(ctx);
		const raw = asRecord(event.message);
		if (raw?.role === "custom" && raw.customType === GOAL_EVENT_ENTRY && raw.display !== false) {
			return { message: { ...event.message, display: false } as typeof event.message };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		core.auditMessages.clear();
		invalidateGoalSettingsCache();
		invalidateGoalPoolCache();
		invalidateGoalLedgerCache();
		core.goalService.flushTurn(ctx);
		await core.loadState(ctx);
		core.installGoalToolProfile(!loadGoalSettings(ctx.cwd).disableTasks);
		rehydrateDraft(core, ctx);
		syncTerminalInputPause(core, ctx);
		if (event.reason === "resume" && !core.state.goal && !core.hasExplicitSessionFocus && otherOpenGoalCount(core.goalsById, null) > 1 && ctx.hasUI) {
			const open = core.openGoals();
			const labels = open.map((item) => goalSelectorLabel(item, core.focusedGoalId));
			const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
			core.enterGoalModal();
			try {
				const selected = await ctx.ui.select("Focus open goal", labels);
				const selectedId = selected ? byLabel.get(selected) : undefined;
				if (selectedId) {
					core.setFocusedGoalId(selectedId, ctx, "selected");
					core.armFocusedContinuation(ctx);
				}
			} finally {
				core.exitGoalModal();
			}
		}
		if (event.reason === "resume" && core.state.goal?.status === "paused" && ctx.hasUI) {
			const current = core.state.goal;
			const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${current.objective}`);
			if (shouldResume) {
				core.scheduler.resume(ctx);
			}
		}
		core.beginAccounting();
		core.scheduler.restore(ctx);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		core.accountProgress(ctx);
	});

	pi.on("session_compact", async (event, ctx) => {
		core.goalService.flushTurn(ctx);
		if (core.state.goal) core.persist(ctx);
		core.beginAccounting();
		if ((event.compactionEntry?.details as { housekeeping?: unknown } | undefined)?.housekeeping === true) return;
		if (shouldArmPostCompactReminder(core.state.goal)) {
			core.runtime.armPostCompactReminder();
		}
		core.queueContinuation(ctx, true);
	});

	type SessionCompactFailed = { reason: "manual" | "threshold" | "overflow"; errorMessage?: string; aborted: boolean; willRetry: boolean; fromExtension: boolean };
	// external: session_compact_failed is absent in Pi 0.83–0.87.
	type CompactFailedOn = (event: "session_compact_failed", handler: (event: SessionCompactFailed, ctx: ExtensionContext) => unknown) => unknown;
	(pi.on as unknown as CompactFailedOn)("session_compact_failed", async (event, ctx) => {
		core.goalService.flushTurn(ctx);
		if (core.state.goal) core.persist(ctx);
		if (event.aborted || !core.state.goal) return;
		const detail = event.errorMessage ? `: ${event.errorMessage}` : "";
		ctx.ui.notify(
			`Goal context compaction failed (${event.reason})${detail}. The goal stays active; retry with /compact or keep working.`,
			"warning",
		);
	});

	pi.on("session_tree", async (_event, ctx) => {
		core.auditMessages.clear();
		core.goalService.flushTurn(ctx);
		await core.loadState(ctx);
		rehydrateDraft(core, ctx);
		syncTerminalInputPause(core, ctx);
		core.beginAccounting();
		core.scheduler.restore(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		core.advanceTurnSeq();
  if (!hasActiveDraft(core)) core.installGoalToolProfile(!loadGoalSettings(ctx.cwd).disableTasks);
		const incomingGoalId = extractGoalIdFromInjectedMessage(event.prompt ?? "");

		if (incomingGoalId !== null) {
			core.reconcileFocusedGoalFromDisk(ctx);
			core.runtime.setCheckpoint(incomingGoalId);
			core.clearContinuationState(false);
			if (!core.isActionableContinuationGoal(incomingGoalId)) {
				try {
					ctx.abort?.();
				} catch {}
				core.updateUI(ctx);
				return;
			}
			core.runtime.setCheckpoint(null);
		} else {
			core.runtime.setCheckpoint(null);
			core.clearContinuationState();
			networkErrorRecoveryAfterSettleFor = null;
		}

		core.reconcileFocusedGoalFromDisk(ctx);
		core.runningGoalId = core.state.goal?.status === "active" ? core.state.goal.id : null;
	});

	/** Request-only state: no live counters, focus, or reminders enter the system prefix. */
	/** Request-only goal state split into a rarely-changing policy block and per-turn counters. Other branches are stable-only. */
	function currentGoalContextParts(ctx: ExtensionContext): { state: string; counters?: string } | undefined {
		const checkpoint = core.runtime.getCheckpointGoalId();
		if (checkpoint !== null && !core.isActionableContinuationGoal(checkpoint)) {
			return { state: staleContinuationPrompt(checkpoint, core.state.goal) };
		}
		let promptLedger: ReturnType<typeof readGoalLedger> | undefined;
		const getPromptLedger = () => promptLedger ??= { events: core.state.goal ? goalRuntimeEvents(ctx, core.state.goal.id) : [], malformed: 0 };

		if (!core.state.goal) {
			if (loadGoalSettings(ctx.cwd).hideUnfocusedPrompt === true) return;
			const openCount = otherOpenGoalCount(core.goalsById, null);
			if (openCount > 0) {
				return { state: unfocusedOpenGoalsPrompt(openCount) };
			}
			return;
		}
		if (core.state.goal.status === "complete") return;
		if (core.state.goal.status === "paused") {
			const current = core.state.goal;
			const pauseExtras: string[] = [];
			if (current.stopReason === "agent") {
				pauseExtras.push("");
				pauseExtras.push(`Pause reason: ${current.pauseReason ?? "(unknown)"}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`Suggested action: ${current.pauseSuggestedAction}`);
			}
				let auditorExtra = "";
				try {
					const ledger = getPromptLedger();
				const auditorResult = latestAuditorResultForGoal(ledger.events, current.id);
				if (auditorResult && auditorResult.verdict === "disapproved") {
					auditorExtra = `\n\n[AUDITOR REJECTION] An independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
				}
			} catch {
			}
		return { state: `[PI GOAL PAUSED goalId=${current.id}]\n${untrustedObjectiveBlock(current)}${pauseExtras.join("\n")}${auditorExtra}\n\n${current.stopReason === "agent"
			? "The goal is paused by the agent. Once the reason above is resolved (the user answered, the provider or quota is back, evidence settles it), call update_goal({status: \"active\"}) and keep working; /goal-resume is also available. Do not do substantive work while the reason still stands."
			: "The goal is paused. Do not autonomously continue substantive work. The user paused it: only when the user explicitly asks to resume, call update_goal({status: \"active\"}); /goal-resume is also available."} If the user explicitly asks to finish the paused goal and the objective is already satisfied based on available evidence, you may call update_goal({status: "complete"}). To abandon a goal, the user runs /goal-clear. Do not report the goal blocked in response to a pause.` };
		}
		if (core.state.goal?.status === "budget_limited") {
			const limitedGoal = core.state.goal;
			const budgetText = modelBudgetLine(limitedGoal);
			const remaining = budgetRemaining(limitedGoal);
			const balanceText = typeof remaining === "number"
				? remaining < 0
					? ` — ${formatTokenValue(-remaining)} over the budget`
					: ` — ${formatTokenValue(remaining)} remaining`
				: "";
			const reminder = core.runtime.consumePostBudgetReminder()
				? `\n\n[TOKEN BUDGET REACHED goalId=${limitedGoal.id}]\nThe goal's lifetime token-spending cap (not context capacity) has been reached${budgetText ? ` (${budgetText}${balanceText})` : ""}. Wrap up the current work in one final response: summarize what was accomplished and what remains, do not start new substantive work, and do not claim the goal is complete unless it actually is. To continue, the user can use /goal-tweak to raise or remove the token budget.`
				: "";
		return { state: `[PI GOAL BUDGET LIMITED goalId=${limitedGoal.id}]\n${untrustedObjectiveBlock(limitedGoal)}${budgetText ? `\n${budgetText}` : ""}${reminder}` };
		}
  if (core.state.goal.status === "blocked") {
   const blocked = core.state.goal;
   return { state: `[PI GOAL BLOCKED goalId=${blocked.id}]\n${untrustedObjectiveBlock(blocked)}\nBlocker: ${blocked.pauseReason ?? "unspecified"}\nThe goal is blocked. Once the blocker above is resolved (the user answered, the provider or quota is back, evidence settles it), call update_goal({status: "active"}) and keep working; /goal-resume is also available. Do not do substantive work while the blocker still stands.` };
  }
		const activeGoal = core.state.goal;
		const settings = loadGoalSettings(ctx.cwd);
		const { state: policy, counters } = goalPromptParts(activeGoal, settings, ctx.getContextUsage?.());
		let state = policy;
		const stalledNote = core.checkStall(ctx);
		if (stalledNote) state += stalledNote;
		try {
			const ledger = getPromptLedger();
			const auditorResult = latestAuditorResultForGoal(ledger.events, activeGoal.id);
			if (auditorResult && auditorResult.verdict === "disapproved" && ledger.events.some((e) => e.type === "completion_requested" && e.goalId === activeGoal.id)) {
				state = `${state}\n\n[AUDITOR REJECTION goalId=${activeGoal.id}]\nAn independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
			}
		} catch {
		}
		if (core.runtime.isPostCompactReminderPending() && shouldInjectPostCompactReminder({ pending: true, goal: activeGoal })) {
			core.runtime.clearPostCompactReminder();
			try {
				const ledger = getPromptLedger();
				const otherOpenCount = core.openGoals().filter((g) => g.id !== activeGoal.id).length;
				const delta = buildPostCompactionGoalDelta({ goal: activeGoal, ledgerEvents: ledger.events, otherOpenCount });
				state = `${state}\n\n${delta}`;
			} catch {
				state = `${state}\n\n[POST-COMPACTION RESYNC goalId=${core.state.goal.id}]\nThe conversation was just compacted. Re-read the objective and continue from the actual artifacts/state; do not rely on memory of the prior chat.`;
			}
		}
		return { state, counters };
	}

	pi.on("agent_end", async (event, ctx) => {
		const endedGoalId = core.runningGoalId;
		core.runningGoalId = null;
		continuationAfterSettleFor = null;
		networkErrorRecoveryAfterSettleFor = null;

		const abortedTokens = event.messages
			.filter(isAbortedAssistantMessage)
			.reduce((sum, message) => sum + assistantTurnTokens(message), 0);
		if (abortedTokens > 0 && endedGoalId && core.state.goal?.id === endedGoalId) {
			core.accountProgress(ctx, { completedTurnTokens: abortedTokens });
		}

		core.runtime.clearContinuationState(false);
		if (!core.state.goal || core.state.goal.status !== "active" || !core.state.goal.autoContinue) return;
		if (endedGoalId && core.state.goal.id !== endedGoalId) return;
		if (!core.reconcileFocusedGoalFromDisk(ctx)) return;
		if (ctx.signal?.aborted) {
			core.pauseActiveGoal(ctx);
			return;
		}
		if (hasNetworkErrorAssistantMessage(event.messages) || hasAbortedAssistantMessage(event.messages)) {
			core.persist(ctx);
			core.updateUI(ctx);
			networkErrorRecoveryAfterSettleFor = core.state.goal.id;
			return;
		}
		if (hasErrorAssistantMessage(event.messages)) {
			core.persist(ctx);
			core.updateUI(ctx);
			return;
		}
		core.runtime.clearNetworkErrorBackoff();
		core.persist(ctx);
		core.updateUI(ctx);
		// external: Pi agent_end precedes retries and queued work; agent_settled runs after them.
		continuationAfterSettleFor = core.state.goal.id;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		core.auditMessages.flush(ctx, pi);
		const goalId = continuationAfterSettleFor;
		continuationAfterSettleFor = null;
		const networkErrorGoalId = networkErrorRecoveryAfterSettleFor;
		networkErrorRecoveryAfterSettleFor = null;
		core.scheduler.settled(ctx, !!goalId && core.isActionableContinuationGoal(goalId));
		if (goalId && core.isActionableContinuationGoal(goalId)) return;
		if (!networkErrorGoalId || !core.isActionableContinuationGoal(networkErrorGoalId)) return;
		const recovery = loadGoalSettings(ctx.cwd).networkRecovery;
		const policy = recovery
			? { maxAttempts: recovery.maxAttempts, maxDelayMs: recovery.maxDelayMs }
			: undefined;
		const plan = core.runtime.scheduleNetworkErrorRetry(ctx, core.state.goal!, policy);
		if (plan) {
			const cap = plan.maxAttempts > 0 ? `/${plan.maxAttempts}` : ", unbounded";
			ctx.ui.notify(
				`Provider network error. Retrying the goal in ${Math.round(plan.delayMs / 1000)}s (recovery ${plan.attempt}${cap}).`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			"Provider network errors persisted after all recovery attempts. The goal remains active; resume it when the provider is healthy.",
			"warning",
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		core.auditMessages.clear();
		core.scheduler.shutdown();
		continuationAfterSettleFor = null;
		networkErrorRecoveryAfterSettleFor = null;
		core.accountProgress(ctx);
		core.clearContinuationState();
		core.terminalInputUnsubscribe?.();
		core.terminalInputUnsubscribe = null;
		if (core.state.goal) core.persist(ctx);
		core.clearGoalWidget(ctx);
		liveRetention.clear(sessionKeyFor(ctx));
	});
}
