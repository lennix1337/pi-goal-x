import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateToWidth } from "./text-cache.ts";
import {
	displayObjectiveTitle,
	formatDuration,
	formatTokenValue,
	truncateText,
	type GoalDisplayRecordLike,
} from "../goal-core.ts";
import type { GoalRecord, GoalTask, GoalTaskList, TaskStatus } from "../goal-record.ts";
import type { GoalDashboardKeybindings, GoalSettings } from "../goal-settings.ts";
import { sisyphusStepProgress } from "../goal-policy.ts";
import type { GoalLedgerEvent } from "../goal-ledger.ts";
import {
	anchoredScrollOffset,
	clampScrollOffset,
	compactTaskViewportRows,
	deriveGoalDashboardModel,
	expandedTaskViewportRows,
	latestCompletedNodeIndex,
	activeNodeIndex,
	maxScrollOffset,
	taskViewportPageSize,
	type GoalDashboardModel,
} from "./goal-dashboard-model.ts";
import {
	clampLinesToWidth,
	renderAuditResultCard,
	renderAuditorDashboard,
	renderCompactDashboard,
	renderExpandedDashboard,
	renderUnfocusedDashboard,
} from "./goal-dashboard-renderer.ts";
import { deriveAuditResultCard, deriveAuditorDashboardModel } from "./auditor-dashboard-model.ts";

type GoalWidgetColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text">;

export interface GoalWidgetRecord extends GoalDisplayRecordLike {
	id: string;
	createdAt: string;
	updatedAt: string;
	activePath?: string | null;
	archivedPath?: string | null;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	taskList?: GoalTaskList | null;
	verificationContract?: string;
	tokenBudget?: number;
	currentTaskId?: string;
}

export const GOAL_WIDGET_KEY = "goal";

/** Return a live usage view when accounting is active, otherwise the goal. */
export function liveDisplayGoal(goal: GoalRecord | null, accounting: { isActiveFor(goalId: string): boolean; liveSeconds(): number }): GoalRecord | null {
	if (!goal || goal.status !== "active" || !accounting.isActiveFor(goal.id)) return goal;
	const liveSeconds = accounting.liveSeconds();
	if (liveSeconds === 0) return goal;
	return {
		...goal,
		usage: { ...goal.usage, activeSeconds: goal.usage.activeSeconds + liveSeconds },
	};
}

/** Create the above-editor widget using live state getters. */
export function makeGoalWidgetFactory(opts: {
	getGoal: () => GoalWidgetRecord | null;
	getOpenGoalCount: () => number;
	getAuditorProgress: () => AuditorWidgetProgress | null;
	getSettings: () => GoalSettings;
	getDebugMode: () => boolean;
	getStalled: () => boolean;
	getExpanded?: () => boolean;
	getLedgerEvents?: () => GoalLedgerEvent[];
	getAuditResult?: () => AuditResultView | null;
	componentRef?: { current: GoalWidgetComponent | null };
}) {
	return (tui: TUI, theme: Theme) => {
		const component = new GoalWidgetComponent({
			tui,
			theme,
			getGoal: opts.getGoal,
			getOpenGoalCount: opts.getOpenGoalCount,
			getAuditorProgress: opts.getAuditorProgress,
			getSettings: opts.getSettings,
			getDebugMode: opts.getDebugMode,
			getStalled: opts.getStalled,
			getExpanded: opts.getExpanded,
			getLedgerEvents: opts.getLedgerEvents,
			getAuditResult: opts.getAuditResult,
		});
		if (opts.componentRef) opts.componentRef.current = component;
		return component;
	};
}

export interface AuditorWidgetProgress {
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	recentOutput: string[];
	phase: "running" | "tool_executing" | "producing_report" | "thinking" | "done";
	elapsedMs: number;
	label?: string;
	percentage?: number;
	/** §15: auditor identity (provider/model) for the audit dashboard header. */
	auditorLabel?: string;
}

export interface GoalWidgetOptions {
	theme: Theme;
	tui: TUI;
	getGoal: () => GoalWidgetRecord | null;
	getOpenGoalCount?: () => number;
	getAuditorProgress?: () => AuditorWidgetProgress | null;
	getSettings?: () => GoalSettings;
	getDebugMode?: () => boolean;
	getStalled?: () => boolean;
	getExpanded?: () => boolean;
	getLedgerEvents?: () => GoalLedgerEvent[];
	getAuditResult?: () => AuditResultView | null;
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}


// external: pi-tui can erase scrollback on a full render.
/** Minimum rows reserved for surrounding terminal chrome and chat. */
export const WIDGET_HEIGHT_RESERVE = 6;

/** Bound widget lines to terminal height, or leave them unbounded without dimensions. */
export function boundWidgetRenderLines(lines: string[], terminalRows: number | undefined): string[] {
	if (!terminalRows || terminalRows <= 0) return lines;
	const cap = Math.max(1, terminalRows - WIDGET_HEIGHT_RESERVE);
	if (lines.length <= cap) return lines;
	return lines.slice(0, cap);
}

/** Keep widget height stable within a regime; reset on regime or terminal changes. */
export function applyStableHeightBound(
	lines: string[],
	terminalRows: number | undefined,
	state: { stickyCap: number | undefined; stickyRegime: string | undefined; stickyTerminalRows: number | undefined; stickyReserve?: number },
	regime: string,
	reserve: number = WIDGET_HEIGHT_RESERVE,
): string[] {
	if (!terminalRows || terminalRows <= 0) return lines;
	const cap = Math.max(1, terminalRows - reserve);
	if (state.stickyTerminalRows !== terminalRows) {
		state.stickyCap = undefined;
		state.stickyTerminalRows = terminalRows;
	}
	if (state.stickyReserve !== reserve) {
		// external: pi-tui wipes scrollback when changed lines precede its viewport.
		state.stickyCap = undefined;
		state.stickyReserve = reserve;
	}
	if (state.stickyRegime !== regime) {
		state.stickyCap = undefined;
		state.stickyRegime = regime;
	}
	if (state.stickyCap === undefined) {
		state.stickyCap = Math.min(lines.length, cap);
	}
	if (lines.length > state.stickyCap) {
		return lines.slice(0, state.stickyCap);
	}
	if (lines.length < state.stickyCap) {
		const padded = lines.slice();
		while (padded.length < state.stickyCap) padded.push("");
		return padded;
	}
	return lines;
}

function heading(theme: Theme, width: number, left: string, right = ""): string {
	if (!right) return fit(left, width);
	const rightPart = ` ${right}`;
	const fill = Math.max(1, width - visibleWidth(left) - visibleWidth(rightPart));
	return fit(`${left}${theme.fg("dim", " ".repeat(fill))}${rightPart}`, width);
}

function branchLine(theme: Theme, width: number, isLast: boolean, content: string): string {
	const prefix = isLast ? "└─" : "├─";
	return fit(`${theme.fg("dim", prefix)} ${content}`, width);
}

function progressBar(pct: number, barWidth: number, theme: Theme): string {
	const safeBar = Math.max(3, barWidth);
	const filled = Math.min(safeBar, Math.max(0, Math.round((pct / 100) * safeBar)));
	const empty = safeBar - filled;
	return `[${theme.fg("accent", "█".repeat(filled))}${theme.fg("dim", "░".repeat(empty))}]`;
}


const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!;
}

export interface AuditResultView {
	verdict: "approved" | "disapproved" | "error";
	report: string;
}

/**
 * Structured audit dashboard (§15): five check stages, elapsed duration, and a
 * progress bar, derived from the raw auditor progress stream. Raw tools and
 * recent output appear only with showToolDetails (expanded/debug audit mode)
 * or after a failed audit.
 */
export function renderAuditorWidgetLines(
	progress: AuditorWidgetProgress,
	theme: Theme,
	width: number,
	opts: { showToolDetails?: boolean; verdict?: "approved" | "disapproved" | "error" | null } = {},
): string[] {
	const model = deriveAuditorDashboardModel(progress, { auditorLabel: progress.auditorLabel, verdict: opts.verdict });
	return renderAuditorDashboard(model, theme, width, { showToolDetails: opts.showToolDetails });
}

/** §15.4: approval / rejection result card for a finished audit. */
export function renderAuditResultCardView(
	view: AuditResultView,
	theme: Theme,
	width: number,
): string[] {
	return renderAuditResultCard(deriveAuditResultCard(view.verdict, view.report), theme, width);
}

export function renderGoalWidgetLines(goal: GoalWidgetRecord | null, theme: Theme, width: number, options: { openGoalCount?: number; auditorProgress?: AuditorWidgetProgress | null; disableTasks?: boolean; stalled?: boolean; ledgerEvents?: GoalLedgerEvent[]; expanded?: boolean; debug?: boolean; model?: GoalDashboardModel | null; compactScrollOffset?: number; expandedScrollOffset?: number; expandedTaskRows?: number; keybindings?: GoalDashboardKeybindings; terminalRows?: number } = {}): string[] {
	if (options.auditorProgress) {
		return boundWidgetRenderLines(renderAuditorWidgetLines(options.auditorProgress, theme, width, {
			showToolDetails: options.expanded === true || options.debug === true,
		}), options.terminalRows);
	}
	const openGoalCount = options.openGoalCount ?? 0;
	if (!goal) {
		return boundWidgetRenderLines(openGoalCount > 0 ? renderUnfocusedDashboard(openGoalCount, theme, width) : [], options.terminalRows);
	}
	const safeWidth = Math.max(1, width);
	const otherCount = Math.max(0, openGoalCount - 1);
	const model = options.model ?? deriveGoalDashboardModel(goal as GoalRecord | null, {
		focused: true,
		otherOpenGoals: otherCount,
		ledgerEvents: options.ledgerEvents ?? [],
		tasksDisabled: options.disableTasks === true,
	});
	if (!model) return [];
	const lines = options.expanded
		? renderExpandedDashboard(model, theme, safeWidth, { scrollOffset: options.expandedScrollOffset, rows: options.expandedTaskRows, keybindings: options.keybindings })
		: renderCompactDashboard(model, theme, safeWidth, { scrollOffset: options.compactScrollOffset, keybindings: options.keybindings });
	return boundWidgetRenderLines(clampLinesToWidth(lines, width), options.terminalRows);
}

export class GoalWidgetComponent implements Component {
	private theme: Theme;
	private tui: TUI;
	private getGoal: () => GoalWidgetRecord | null;
	private getOpenGoalCount: () => number;
	private getAuditorProgress: () => AuditorWidgetProgress | null;
	private getSettings: () => GoalSettings;
	private getDebugMode: () => boolean;
	private getStalled: () => boolean;
	private getExpanded: () => boolean;
	private getLedgerEvents: () => GoalLedgerEvent[];
	private getAuditResult: () => AuditResultView | null;

	private compactScrollOffset = 0;
	private expandedScrollOffset = 0;
	private lastRenderWidth = 100;
	private lastSeenGoalId: string | undefined;
	private lastSeenLatestCompletedAt: string | undefined;
	private lastSeenActiveId: string | undefined;

	private stableHeightState: { stickyCap: number | undefined; stickyRegime: string | undefined; stickyTerminalRows: number | undefined; stickyReserve?: number } = {
		stickyCap: undefined,
		stickyRegime: undefined,
		stickyTerminalRows: undefined,
		stickyReserve: undefined,
	};

	constructor(options: GoalWidgetOptions) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.getGoal = options.getGoal;
		this.getOpenGoalCount = options.getOpenGoalCount ?? (() => (this.getGoal() ? 1 : 0));
		this.getAuditorProgress = options.getAuditorProgress ?? (() => null);
		this.getSettings = options.getSettings ?? (() => ({}));
		this.getDebugMode = options.getDebugMode ?? (() => false);
		this.getStalled = options.getStalled ?? (() => false);
		this.getExpanded = options.getExpanded ?? (() => false);
		this.getLedgerEvents = options.getLedgerEvents ?? (() => []);
		this.getAuditResult = options.getAuditResult ?? (() => null);
	}

	isExpanded(): boolean {
		return this.getExpanded();
	}

	update(): void {
		this.tui.requestRender();
	}

	private renderDebugPanel(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		const safeWidth = Math.max(20, width);

		lines.push(t.fg("dim", "─".repeat(safeWidth)));
		lines.push(t.fg("warning", "⊙ [DEBUG MODE]"));
		lines.push("");

		const goal = this.getGoal();
		if (goal) {
			lines.push(t.fg("dim", `  id: ${goal.id}`));
			lines.push(t.fg("dim", `  status: ${goal.status}`));
			lines.push(t.fg("dim", `  objective: ${truncateText(goal.objective, 80)}`));
			lines.push(t.fg("dim", `  sisyphus: ${goal.sisyphus}`));
			lines.push(t.fg("dim", `  autoContinue: ${goal.autoContinue}`));
			lines.push(t.fg("dim", `  tokens: ${goal.usage.tokensUsed}`));
			lines.push(t.fg("dim", `  activeSeconds: ${goal.usage.activeSeconds}`));
			lines.push(t.fg("dim", `  createdAt: ${goal.createdAt}`));
			lines.push(t.fg("dim", `  updatedAt: ${goal.updatedAt}`));
			if (goal.pauseReason) lines.push(t.fg("dim", `  pauseReason: ${goal.pauseReason}`));
			if (goal.pauseSuggestedAction) lines.push(t.fg("dim", `  pauseSuggestedAction: ${goal.pauseSuggestedAction}`));
			if (goal.stopReason) lines.push(t.fg("dim", `  stopReason: ${goal.stopReason}`));
			if (goal.activePath) lines.push(t.fg("dim", `  activePath: ${goal.activePath}`));
			if (goal.archivedPath) lines.push(t.fg("dim", `  archivedPath: ${goal.archivedPath}`));
			if (goal.verificationContract) lines.push(t.fg("dim", `  vContract: ${truncateText(goal.verificationContract, 60)}`));

			const model = deriveGoalDashboardModel(goal as GoalRecord | null, { focused: true, otherOpenGoals: 0 });
			if (model?.taskProgress) {
				lines.push(t.fg("dim", `  tasks: ${model.taskProgress.completed}/${model.taskProgress.total}`));
			}
			if (model?.currentTask) {
				lines.push(t.fg("dim", `  next: ${model.currentTask.id} (${truncateText(model.currentTask.title, 40)})`));
			}
		} else {
			lines.push(t.fg("dim", "  (no goal)"));
		}

		lines.push("");
		lines.push(t.fg("dim", "── Debug keybindings ──"));
		lines.push(t.fg("dim", "  Ctrl+Shift+X  Toggle debug mode"));
		lines.push(t.fg("dim", "  Ctrl+Shift+N  Create test goal"));
		lines.push(t.fg("dim", "  Ctrl+Shift+T  Inject sample tasks"));
		lines.push(t.fg("dim", "  Ctrl+Shift+R  Mock audit animation"));
		lines.push(t.fg("dim", "  Ctrl+Shift+O  Open proposal dialog"));

		return lines;
	}

	render(width: number): string[] {
		const settings = this.getSettings();
		this.lastRenderWidth = Math.max(1, width);
		// external: pi-tui can wipe scrollback when the widget overflows the terminal.
		const terminalRows = (this.tui as unknown as { terminal?: { rows?: number } }).terminal?.rows;
		const natural = this.renderNatural(width);
		const regime = this.stableHeightRegime();
		const reserve = this.measureDockReserve(width) ?? WIDGET_HEIGHT_RESERVE;
		return applyStableHeightBound(natural, terminalRows, this.stableHeightState, regime, reserve);
	}

	// external: pi-tui full renders erase scrollback when changes precede the viewport.
	private measureDockReserve(width: number): number | undefined {
		type DockChild = { children?: DockChild[]; render?: (w: number) => string[] };
		const tui = this.tui as unknown as { children?: DockChild[] };
		const top = tui.children;
		if (!Array.isArray(top) || top.length < 2) return undefined;
		let dockList: typeof top | undefined;
		let widgetContainer: (typeof top)[number] | undefined;
		for (const c of top) {
			const kids = Array.isArray(c.children) ? c.children : undefined;
			if (kids?.includes(this)) {
				dockList = top;
				widgetContainer = c;
				break;
			}
			const nested = kids?.find((cc) => Array.isArray(cc.children) && cc.children!.includes(this)) as (typeof top)[number] | undefined;
			if (nested) {
				dockList = kids!;
				widgetContainer = nested;
				break;
			}
		}
		if (!dockList || !widgetContainer) return undefined;
		let total = 0;
		for (let i = 0; i < dockList.length; i++) {
			const c = dockList[i]!;
			if (dockList === top && i === 0) continue;
			if (c === widgetContainer) continue;
			if (typeof c?.render !== "function") continue;
			try {
				const lines = c.render(width);
				if (Array.isArray(lines)) total += lines.length;
			} catch {
				return undefined;
			}
		}
		// external: one line of slack keeps the chat append point below the viewport.
		return total + 1;
	}

	private renderNatural(width: number): string[] {
		const settings = this.getSettings();
		const safeWidth = Math.max(1, width);
		const auditResult = this.getAuditResult();
		if (auditResult) {
			return clampLinesToWidth(renderAuditResultCardView(auditResult, this.theme, width), width);
		}
		const goal = this.getGoal();
		const otherCount = Math.max(0, this.getOpenGoalCount() - 1);
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord | null, {
			focused: true,
			otherOpenGoals: otherCount,
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
			maxAutonomousRuns: settings.maxAutonomousRuns,
			showAutonomousRuns: settings.showAutonomousRuns,
		}) : null;
		this.maybeReanchor(model);
		const lines = renderGoalWidgetLines(this.getGoal(), this.theme, safeWidth, {
			openGoalCount: this.getOpenGoalCount(),
			auditorProgress: this.getAuditorProgress(),
			disableTasks: settings.disableTasks,
			stalled: this.getStalled(),
			expanded: this.getExpanded(),
			ledgerEvents: this.getLedgerEvents(),
			debug: this.getDebugMode(),
			model,
			compactScrollOffset: this.compactScrollOffset,
			expandedScrollOffset: this.expandedScrollOffset,
			expandedTaskRows: expandedTaskViewportRows(this.lastRenderWidth),
			keybindings: settings.keybindings?.dashboard,
		});
		if (this.getDebugMode()) {
			lines.push(...this.renderDebugPanel(width));
		}
		return clampLinesToWidth(lines, width);
	}

	private stableHeightRegime(): string {
		const settings = this.getSettings();
		const goal = this.getGoal();
		let stateKind: string;
		if (this.getAuditResult()) stateKind = "result";
		else if (this.getAuditorProgress()) stateKind = "audit";
		else if (goal) stateKind = "focused";
		else stateKind = this.getOpenGoalCount() > 0 ? "unfocused" : "none";
		const hasTasks = (goal?.taskList?.tasks?.length ?? 0) > 0;
		return [goal?.id ?? "∅", goal?.status ?? "∅", stateKind, String(this.getExpanded()), String(this.getDebugMode()), String(settings.disableTasks === true), String(hasTasks)].join("|");
	}

	private maybeReanchor(model: GoalDashboardModel | null): void {
		const tree = model?.taskTree ?? [];
		const latest = latestCompletedNodeIndex(tree);
		const latestAt = latest >= 0 ? tree[latest]!.completedAt : undefined;
		const activeId = tree[activeNodeIndex(tree)]?.id;
		if (model?.goalId === this.lastSeenGoalId && latestAt === this.lastSeenLatestCompletedAt && activeId === this.lastSeenActiveId) return;
		this.lastSeenGoalId = model?.goalId;
		this.lastSeenLatestCompletedAt = latestAt;
		this.lastSeenActiveId = activeId;
		if (!model || model.taskTree.length === 0) {
			this.compactScrollOffset = 0;
			this.expandedScrollOffset = 0;
			return;
		}
		const topLevel = model.taskTree.filter((n) => n.depth === 0);
		this.compactScrollOffset = anchoredScrollOffset(topLevel, compactTaskViewportRows(this.lastRenderWidth));
		this.expandedScrollOffset = anchoredScrollOffset(model.taskTree, expandedTaskViewportRows(this.lastRenderWidth));
	}

	// external: Pi's editor owns the plain arrow keys.
	/** Scroll the compact task list; return true only when the key is consumed. */
	handleCompactScrollKey(key: "up" | "down" | "pageUp" | "pageDown" | "home" | "end"): boolean {
		if (this.getExpanded()) return false;
		const settings = this.getSettings();
		const goal = this.getGoal();
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord | null, {
			focused: true,
			otherOpenGoals: Math.max(0, this.getOpenGoalCount() - 1),
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
			maxAutonomousRuns: settings.maxAutonomousRuns,
		}) : null;
		this.maybeReanchor(model);
		const list = model?.taskTree.filter((n) => n.depth === 0) ?? [];
		const rows = compactTaskViewportRows(this.lastRenderWidth);
		if (list.length <= rows) return false;
		let offset = clampScrollOffset(this.compactScrollOffset, list.length, rows);
		if (key === "up") offset -= 1;
		else if (key === "down") offset += 1;
		else if (key === "pageUp") offset -= taskViewportPageSize(rows);
		else if (key === "pageDown") offset += taskViewportPageSize(rows);
		else if (key === "home") offset = 0;
		else if (key === "end") offset = maxScrollOffset(list.length, rows);
		offset = clampScrollOffset(offset, list.length, rows);
		this.compactScrollOffset = offset;
		this.tui.requestRender();
		return true;
	}

	/** Scroll the expanded dashboard; return true if the key was consumed. */
	handleNavigationKey(key: "up" | "down" | "pageUp" | "pageDown" | "home" | "end"): boolean {
		if (!this.getExpanded()) return false;
		const settings = this.getSettings();
		const goal = this.getGoal();
		const model = goal ? deriveGoalDashboardModel(goal as GoalRecord | null, {
			focused: true,
			otherOpenGoals: Math.max(0, this.getOpenGoalCount() - 1),
			ledgerEvents: this.getLedgerEvents(),
			tasksDisabled: settings.disableTasks === true,
			maxAutonomousRuns: settings.maxAutonomousRuns,
		}) : null;
		this.maybeReanchor(model);
		const list = model?.taskTree ?? [];
		if (list.length === 0) return false;
		const rows = expandedTaskViewportRows(this.lastRenderWidth);
		const maxO = maxScrollOffset(list.length, rows);
		if (maxO <= 0) return true;
		let offset = clampScrollOffset(this.expandedScrollOffset, list.length, rows);
		if (key === "up") offset -= 1;
		else if (key === "down") offset += 1;
		else if (key === "pageUp") offset -= taskViewportPageSize(rows);
		else if (key === "pageDown") offset += taskViewportPageSize(rows);
		else if (key === "home") offset = 0;
		else if (key === "end") offset = maxO;
		offset = clampScrollOffset(offset, list.length, rows);
		this.expandedScrollOffset = offset;
		this.tui.requestRender();
		return true;
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}
