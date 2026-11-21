
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "./text-cache.ts";
import {
	anchoredScrollOffset,
	compactTaskViewportRows,
	deriveTaskListViewport,
	formatAuditElapsed,
	formatBudget,
	type DashboardStatusCode,
	type DashboardTaskNode,
	type GoalDashboardModel,
	type TaskListViewport,
} from "./goal-dashboard-model.ts";
import type { GoalActivityItem } from "../goal-activity.ts";
import { truncateText } from "../goal-core.ts";
import { DEFAULT_GOAL_KEYBINDINGS, formatGoalKeybinding, type GoalDashboardKeybindings } from "../goal-settings.ts";

type RenderColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text" | "mdHeading">;


const H = "─";
const V = "│";

function frame(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

function boxHeader(theme: Theme, width: number, left: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	const l = `${frame(theme, H)} ${left}`;
	const r = right ? ` ${right} ${frame(theme, H)}` : "";
	const fixed = visibleWidth(l) + visibleWidth(r);
	if (fixed > inner - 2) {
		const budget = Math.max(4, inner - visibleWidth(r) - 4);
		const l2 = `${frame(theme, H)} ${fit(left, budget)}`;
		const fill = Math.max(1, inner - visibleWidth(l2) - visibleWidth(r));
		return `${frame(theme, "╭")}${l2}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╮")}`;
	}
	const fill = Math.max(1, inner - fixed);
	return `${frame(theme, "╭")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╮")}`;
}

function boxLine(theme: Theme, width: number, content: string): string {
	const inner = Math.max(2, width - 2);
	const contentFit = fit(content, inner - 1);
	const pad = Math.max(0, inner - 1 - visibleWidth(contentFit));
	return `${frame(theme, V)} ${contentFit}${" ".repeat(pad)}${frame(theme, V)}`;
}

function boxRule(theme: Theme, width: number): string {
	return frame(theme, `├${H.repeat(Math.max(1, width - 2))}┤`);
}

function boxSectionRule(theme: Theme, width: number, label: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	const left = frame(theme, `${H} ${label} `);
	const r = right ? ` ${right} ` : "";
	let l = left;
	if (visibleWidth(left) + visibleWidth(r) > inner) {
		const budget = Math.max(4, inner - visibleWidth(r) - 3);
		l = frame(theme, `${H} ${fit(label, budget)} `);
	}
	const fill = Math.max(0, inner - visibleWidth(l) - visibleWidth(r));
	return `${frame(theme, "├")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "┤")}`;
}

function boxFooter(theme: Theme, width: number, content: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	const r = right ? ` ${right} ${frame(theme, H)}` : "";
	if (!content && !r) {
		return frame(theme, `╰${H.repeat(inner)}╯`);
	}
	const l = content ? frame(theme, `${H} ${fit(content, Math.max(0, inner - 4 - visibleWidth(r)))}`) : "";
	const fill = Math.max(1, inner - visibleWidth(l) - visibleWidth(r));
	return `${frame(theme, "╰")}${l}${frame(theme, H.repeat(fill))}${r}${frame(theme, "╯")}`;
}


const STATUS_COLOR: Record<DashboardStatusCode, RenderColor> = {
	running: "accent",
	idle: "muted",
	paused: "muted",
	blocked: "error",
	budget_limited: "mdHeading",
	complete: "success",
};

function statusLine(theme: Theme, model: GoalDashboardModel): string {
	const color = STATUS_COLOR[model.status.code];
	const usage = model.usage.footerBits ? ` [${model.usage.footerBits}]` : "";
	const open = model.otherOpenGoals > 0 ? ` (+${model.otherOpenGoals} open)` : "";
	return `${theme.fg(color, `goal: ${model.status.footerLabel}`)}${muted(theme, `${usage}${open}`)}`;
}


function progressBar(theme: Theme, pct: number, barWidth: number): string {
	const safeBar = Math.max(2, barWidth);
	const filled = Math.min(safeBar, Math.max(0, Math.round((pct / 100) * safeBar)));
	return `[${theme.fg("muted", "█".repeat(filled))}${theme.fg("dim", "░".repeat(safeBar - filled))}]`;
}


type LayoutMode = "wide" | "medium" | "narrow" | "minimal";

function layoutMode(width: number): LayoutMode {
	if (width >= 100) return "wide";
	if (width >= 70) return "medium";
	if (width >= 50) return "narrow";
	return "minimal";
}

interface LayoutSpec {
	barWidth: number;
	headerBarWidth: number;
	subtaskBarWidth: number;
	showPath: boolean;
	showPauseAction: boolean;
	footerHint: string;
}

function specFor(mode: LayoutMode): LayoutSpec {
	switch (mode) {
		case "wide":
			return { barWidth: 26, headerBarWidth: 8, subtaskBarWidth: 4, showPath: true, showPauseAction: true, footerHint: "Ctrl+Shift+T: expand tasks" };
		case "medium":
			return { barWidth: 18, headerBarWidth: 6, subtaskBarWidth: 3, showPath: true, showPauseAction: true, footerHint: "Ctrl+Shift+T: expand tasks" };
		case "narrow":
			return { barWidth: 12, headerBarWidth: 5, subtaskBarWidth: 2, showPath: false, showPauseAction: false, footerHint: "Ctrl+Shift+T: expand" };
		case "minimal":
			return { barWidth: 8, headerBarWidth: 4, subtaskBarWidth: 2, showPath: false, showPauseAction: false, footerHint: "Ctrl+Shift+T: expand" };
	}
}


function muted(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

function dim(theme: Theme, value: string): string {
	return theme.fg("dim", value);
}

function accent(theme: Theme, value: string): string {
	return theme.fg("accent", value);
}

function success(theme: Theme, value: string): string {
	return theme.fg("success", value);
}

function amber(theme: Theme, value: string): string {
	return theme.fg("mdHeading", value);
}


function taskMarker(node: DashboardTaskNode): { symbol: string; color: RenderColor } {
	if (node.isCurrent) return { symbol: "▸", color: "accent" };
	if (node.status === "complete") return { symbol: "✓", color: "success" };
	if (node.status === "skipped") return { symbol: "~", color: "muted" };
	return { symbol: "·", color: "mdHeading" };
}

function renderTaskRow(theme: Theme, node: DashboardTaskNode, indent: number, available: number): string {
	const marker = taskMarker(node);
	const indentText = "  ".repeat(indent);
	const prefix = `${indentText}${marker.symbol} ${node.id}  `;
	const contractMark = node.verificationContract ? dim(theme, " ☑") : "";
	const titleBudget = Math.max(4, available - visibleWidth(prefix) - visibleWidth(contractMark));
	const title = fit(node.title, titleBudget);
	const markerText = theme.fg(marker.color, marker.symbol);
	const idText = node.isCurrent ? accent(theme, node.id) : theme.fg(marker.color, node.id);
	const titleText = node.isCurrent ? accent(theme, title) : amber(theme, title);
	return `${indentText}${markerText} ${idText}  ${titleText}${contractMark}`;
}

function renderCompactTaskRows(theme: Theme, nodes: DashboardTaskNode[], viewport: TaskListViewport, available: number): string[] {
	const rows: string[] = [];
	if (viewport.hiddenAbove > 0) {
		rows.push(muted(theme, `↑ ${viewport.hiddenAbove} more task${viewport.hiddenAbove === 1 ? "" : "s"}`));
	}
	const shown = nodes.slice(viewport.offset, viewport.offset + viewport.rows);
	const idWidth = shown.length === 0 ? 0 : Math.min(10, Math.max(...shown.map((node) => node.id.length)));
	for (const node of shown) {
		const marker = taskMarker(node);
		const contractMark = node.verificationContract ? dim(theme, " ☑") : "";
		const subtaskMark = node.totalSubtasks > 0 ? muted(theme, ` ▸ ${node.completedSubtasks}/${node.totalSubtasks}`) : "";
		const id = node.id.padEnd(idWidth);
		const prefix = `${marker.symbol} ${id}  `;
		const titleBudget = Math.max(4, available - visibleWidth(prefix) - visibleWidth(contractMark) - visibleWidth(subtaskMark));
		const title = fit(node.title, titleBudget);
		const markerText = theme.fg(marker.color, marker.symbol);
		const idText = node.isCurrent ? accent(theme, id) : theme.fg(marker.color, id);
		const body = node.isCurrent ? accent(theme, title) : amber(theme, title);
		rows.push(`${markerText} ${idText}  ${body}${contractMark}${subtaskMark}`);
	}
	if (viewport.hiddenBelow > 0) {
		rows.push(muted(theme, `… +${viewport.hiddenBelow} more task${viewport.hiddenBelow === 1 ? "" : "s"}`));
	}
	return rows;
}


function activityMarker(item: GoalActivityItem): { symbol: string; color: RenderColor } {
	if (item.marker === "done") return { symbol: "✓", color: "success" };
	if (item.marker === "current") return { symbol: "▸", color: "accent" };
	if (item.marker === "skipped") return { symbol: "~", color: "mdHeading" };
	return { symbol: "·", color: "muted" };
}


/**
 * Persistent summary above the editor while a goal is focused. Visually rich
 * but compact; the footer hints at the expansion shortcut.
 */
export function renderCompactDashboard(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	opts: { footerHint?: string; scrollOffset?: number; keybindings?: GoalDashboardKeybindings } = {},
): string[] {
	const safeWidth = Math.max(10, width);
	const mode = layoutMode(safeWidth);
	const spec = specFor(mode);
	const inner = safeWidth - 2;
	const lines: string[] = [];

	lines.push(boxHeader(theme, safeWidth, `${accent(theme, "pi-goal-x")} ${frame(theme, `─ ${model.title}`)}`));

	if (model.status.code === "complete") {
		lines.push(boxLine(theme, safeWidth, `${success(theme, "✓")} ${success(theme, "All required work is complete.")}`));
	} else {
		lines.push(boxLine(theme, safeWidth, statusLine(theme, model)));
	}

	for (const row of model.scheduling ?? []) lines.push(boxLine(theme, safeWidth, muted(theme, fit(row, inner))));

	if (model.budget) {
		const fuel = model.budget.used >= model.budget.total ? "error" : "mdHeading";
		lines.push(boxLine(theme, safeWidth, `${theme.fg(fuel as RenderColor, "⛽")} ${muted(theme, "Budget")} ${theme.fg(fuel as RenderColor, formatBudget(model.budget.used, model.budget.total))}`));
	}

	const topLevel = model.taskTree.filter((node) => node.depth === 0);
	const compactRows = compactTaskViewportRows(safeWidth);
	const listOverflows = topLevel.length > compactRows;
	if (topLevel.length > 0) {
		const offset = opts.scrollOffset ?? anchoredScrollOffset(topLevel, compactRows);
		const viewport = deriveTaskListViewport(topLevel.length, compactRows, offset);
		const headerLabel = model.taskProgress
			? `Tasks · ✓${model.taskProgress.completed} done · ${model.taskProgress.total - model.taskProgress.completed} open`
			: "Tasks";
		let headerRight = model.taskProgress ? progressBar(theme, model.taskProgress.percentage, spec.headerBarWidth) : "";
		if (model.currentTask && model.currentTask.totalSubtasks > 0 && mode !== "minimal") {
			const subBar = progressBar(theme, model.currentTask.subtaskPercentage, spec.subtaskBarWidth);
			const subWord = mode === "narrow" ? "" : "Sub ";
			headerRight += `${muted(theme, ` · ${subWord}`)}${muted(theme, `${model.currentTask.completedSubtasks}/${model.currentTask.totalSubtasks}`)} ${subBar}`;
		}
		lines.push(boxSectionRule(theme, safeWidth, headerLabel, headerRight));
		for (const row of renderCompactTaskRows(theme, topLevel, viewport, inner)) {
			lines.push(boxLine(theme, safeWidth, row));
		}
	}

	if (!model.currentTask && model.taskProgress && model.taskProgress.completed === model.taskProgress.total && model.status.code !== "complete") {
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Current")}  ${accent(theme, "All tasks complete")}`));
	}

	if (model.currentTask) {
		if (mode === "minimal") {
			lines.push(boxLine(theme, safeWidth, `${accent(theme, "▸")} ${accent(theme, fit(model.currentTask.title, inner - 3))}`));
		} else {
			const titleBudget = inner - visibleWidth(`Current  ${model.currentTask.id} · `);
			lines.push(boxLine(theme, safeWidth, `${muted(theme, "Current")}  ${accent(theme, model.currentTask.id)} · ${accent(theme, fit(model.currentTask.title, titleBudget))}`));
		}
	}

	if (model.goalVerificationContract && mode !== "minimal") {
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Verify")}   ${fit(model.goalVerificationContract.replace(/\s+/g, " "), inner - 9)}`));
	}

	if (model.status.code === "blocked") {
		if (model.status.reason) lines.push(boxLine(theme, safeWidth, `${theme.fg("error", "Blocker")}  ${muted(theme, fit(model.status.reason, inner - 10))}`));
		if (spec.showPauseAction && model.status.suggestedAction) lines.push(boxLine(theme, safeWidth, `${muted(theme, "Action")}   ${fit(model.status.suggestedAction, inner - 9)}`));
	}

	if (model.status.code === "paused" && model.status.reason) {
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Reason")}   ${fit(model.status.reason, inner - 9)}`));
	}

	if (spec.showPath && model.filePath) {
		lines.push(boxLine(theme, safeWidth, `${dim(theme, `File     ${model.filePath}`)}`));
	}

	const keybindings = opts.keybindings ?? DEFAULT_GOAL_KEYBINDINGS.dashboard;
	const toggleShortcut = formatGoalKeybinding(keybindings.toggleExpand);
	const scrollShortcut = `${formatGoalKeybinding(keybindings.scrollUp)}/${formatGoalKeybinding(keybindings.scrollDown)}`;
	const usesDefaultScrollKeys = keybindings.scrollUp === DEFAULT_GOAL_KEYBINDINGS.dashboard.scrollUp && keybindings.scrollDown === DEFAULT_GOAL_KEYBINDINGS.dashboard.scrollDown;
	const scrollHint = usesDefaultScrollKeys
		? mode === "minimal" ? "↑↓" : "Ctrl+Shift+↑↓"
		: scrollShortcut;
	const expandHint = mode === "wide" || mode === "medium"
		? `${toggleShortcut}: expand tasks`
		: `${toggleShortcut}: expand`;
	const footerHint = opts.footerHint
		?? (listOverflows
			? mode === "wide" || mode === "medium"
				? `${toggleShortcut}: expand · ${scrollHint}: scroll`
				: `${scrollHint}: scroll`
			: expandHint);
	const auditorDot = model.auditorEnabled ? success(theme, "●") : muted(theme, "●");
	const right =
		mode === "wide" || mode === "medium"
			? `${frame(theme, "Ctrl+Shift+A: toggle auditor")} ${auditorDot}`
			: auditorDot;
	lines.push(boxFooter(theme, safeWidth, footerHint, right));
	return lines;
}


/**
 * The full dashboard: goal header, status, usage, progress, a window over the
 * task tree, current-task details with contract/evidence, verification, and
 * recent activity. Replaces the separate task overlay. The task-tree window
 * defaults to the whole tree; pass `rows` (and optionally `scrollOffset`) to
 * bound the panel for interactive scrolling — the default offset anchors to
 * the most recently completed task.
 */
export function renderExpandedDashboard(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	opts: { scrollOffset?: number; rows?: number; keybindings?: GoalDashboardKeybindings } = {},
): string[] {
	const safeWidth = Math.max(10, width);
	const mode = layoutMode(safeWidth);
	const spec = specFor(mode);
	const inner = safeWidth - 2;
	const lines: string[] = [];

	lines.push(boxHeader(theme, safeWidth, `${accent(theme, "pi-goal-x")} ${frame(theme, `─ ${model.title}`)}`));

	lines.push(boxLine(theme, safeWidth, statusLine(theme, model)));
	for (const row of model.scheduling ?? []) lines.push(boxLine(theme, safeWidth, muted(theme, fit(row, inner))));

	if (spec.showPath && model.filePath) {
		lines.push(boxLine(theme, safeWidth, dim(theme, `File: ${model.filePath}`)));
	}
	if (model.budget) {
		lines.push(boxLine(theme, safeWidth, `${theme.fg("mdHeading", "⛽")} ${muted(theme, `Budget ${formatBudget(model.budget.used, model.budget.total)}`)}`));
	}

	if (model.taskProgress) {
		lines.push(boxSectionRule(theme, safeWidth, "Progress"));
		const bar = progressBar(theme, model.taskProgress.percentage, Math.max(10, spec.barWidth + 8));
		lines.push(boxLine(theme, safeWidth, `${bar} ${muted(theme, `${model.taskProgress.completed}/${model.taskProgress.total} tasks · ${model.taskProgress.percentage}%`)}`));
	}

	if (model.taskTree.length > 0) {
		lines.push(boxSectionRule(theme, safeWidth, "Tasks"));
		const totalRows = model.taskTree.length;
		const rows = opts.rows ?? totalRows;
		const offset = opts.scrollOffset ?? anchoredScrollOffset(model.taskTree, rows);
		const viewport = deriveTaskListViewport(totalRows, rows, offset);
		if (viewport.hiddenAbove > 0) {
			lines.push(boxLine(theme, safeWidth, dim(theme, `↑ ${viewport.hiddenAbove} more task${viewport.hiddenAbove === 1 ? "" : "s"}`)));
		}
		for (const node of model.taskTree.slice(viewport.offset, viewport.offset + viewport.rows)) {
			const indent = Math.min(node.depth, 6);
			lines.push(boxLine(theme, safeWidth, renderTaskRow(theme, node, indent, inner)));
		}
		if (viewport.hiddenBelow > 0) {
			lines.push(boxLine(theme, safeWidth, dim(theme, `… +${viewport.hiddenBelow} more task${viewport.hiddenBelow === 1 ? "" : "s"}`)));
		}
	}

	if (model.currentTask) {
		lines.push(...renderCurrentTaskBlock(model, theme, safeWidth, spec.barWidth));
	}

	if (model.goalVerificationContract) {
		lines.push(boxSectionRule(theme, safeWidth, "Verification"));
		lines.push(...wrappedBlock(theme, safeWidth, "", model.goalVerificationContract));
	}

	if (model.recentActivity.length > 0) {
		lines.push(...renderActivityBlock(model.recentActivity, theme, safeWidth));
	}

	const toggleShortcut = formatGoalKeybinding(opts.keybindings?.toggleExpand ?? DEFAULT_GOAL_KEYBINDINGS.dashboard.toggleExpand);
	lines.push(boxFooter(theme, safeWidth, `Esc/${toggleShortcut}: collapse`));
	return lines;
}

/**
 * The current-task detail block (§4.2): title, subtask progress, contract,
 * evidence, and the inferred-focus note. Shared by the expanded dashboard and
 * the standard /goal-status output (§13.3).
 */
export function renderCurrentTaskBlock(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	barWidth = 16,
): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	lines.push(boxSectionRule(theme, safeWidth, "Current task"));
	lines.push(boxLine(theme, safeWidth, `${accent(theme, model.currentTask!.id)} · ${fit(model.currentTask!.title, inner - visibleWidth(`${model.currentTask!.id} · `))}`));
	if (model.currentTask!.totalSubtasks > 0) {
		const bar = progressBar(theme, model.currentTask!.subtaskPercentage, Math.max(8, barWidth));
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Subtasks")} ${bar} ${model.currentTask!.completedSubtasks}/${model.currentTask!.totalSubtasks} · ${model.currentTask!.subtaskPercentage}%`));
	}
	if (model.currentTask!.verificationContract) {
		lines.push(...wrappedBlock(theme, safeWidth, "Contract", model.currentTask!.verificationContract));
	}
	if (model.currentTask!.evidence) {
		lines.push(...wrappedBlock(theme, safeWidth, "Evidence", model.currentTask!.evidence));
	}
	if (model.currentTask!.inferred) {
		lines.push(boxLine(theme, safeWidth, dim(theme, "Inferred from the first pending task — no persisted current task.")));
	}
	return lines;
}

/** The recent-activity block (§12), shared by the expanded dashboard and /goal-status. */
export function renderActivityBlock(items: GoalActivityItem[], theme: Theme, width: number): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	lines.push(boxSectionRule(theme, safeWidth, "Recent activity"));
	for (const item of items) {
		const marker = activityMarker(item);
		const text = fit(item.text, inner - 4);
		lines.push(boxLine(theme, safeWidth, `${theme.fg(marker.color, marker.symbol)} ${text}`));
	}
	return lines;
}

function wrappedBlock(theme: Theme, width: number, label: string, text: string): string[] {
	const inner = Math.max(4, width - 2);
	const prefix = label ? `${label}: ` : "";
	const indent = " ".repeat(visibleWidth(prefix));
	const wrapped = wrapTextWithAnsi(text.replace(/\s+/g, " ").trim(), Math.max(8, inner - visibleWidth(prefix)));
	const lines: string[] = [];
	for (const [index, segment] of wrapped.entries()) {
		const content = index === 0 ? `${prefix}${segment}` : `${indent}${segment}`;
		lines.push(boxLine(theme, width, muted(theme, content)));
	}
	return lines;
}


/**
 * Shown when open goals exist but none is focused. The widget's default
 * no-goal branch renders nothing (surfaces without goals).
 */
export function renderUnfocusedDashboard(openGoalCount: number, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(10, width);
	const lines: string[] = [];
	lines.push(boxHeader(theme, safeWidth, frame(theme, "pi-goal-x ─ Goal focus required")));
	const goals = openGoalCount === 1 ? "1 open goal is available." : `${openGoalCount} open goals are available.`;
	lines.push(boxLine(theme, safeWidth, muted(theme, goals)));
	lines.push(boxLine(theme, safeWidth, muted(theme, "Run /goal-focus to choose the goal for this session.")));
	lines.push(boxFooter(theme, safeWidth, ""));
	return lines;
}


/** Clamp every rendered line to the terminal width (used by the component). */
export function clampLinesToWidth(lines: string[], width: number): string[] {
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}


import type { AuditorDashboardModel, AuditResultCard } from "./auditor-dashboard-model.ts";

const CHECK_SYMBOL = { passed: "✓", running: "◌", pending: "·", failed: "✗" } as const;
const CHECK_COLOR = { passed: "success", running: "accent", pending: "muted", failed: "error" } as const;

/**
 * Structured audit dashboard (§15.3): five check stages, a progress bar, and
 * the elapsed duration, using the same visual system as the goal dashboard.
 * Raw tools and recent output appear only when showToolDetails is set
 * (expanded/debug audit mode) or when the audit finished with a failure.
 */
export function renderAuditorDashboard(
	model: AuditorDashboardModel,
	theme: Theme,
	width: number,
	opts: { showToolDetails?: boolean } = {},
): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	const duration = formatAuditElapsed(model.elapsedMs);
	lines.push(boxHeader(theme, safeWidth, frame(theme, `Independent completion audit ─ ${model.auditorLabel}`), frame(theme, duration)));

	for (const check of model.checks) {
		const symbol = CHECK_SYMBOL[check.state];
		const color = CHECK_COLOR[check.state];
		lines.push(boxLine(theme, safeWidth, `${theme.fg(color as RenderColor, symbol)} ${check.label}`));
	}

	if (model.percentage !== undefined) {
		const barWidth = Math.max(8, Math.min(inner - 12, 30));
		const bar = progressBar(theme, model.percentage, barWidth);
		lines.push(boxLine(theme, safeWidth, `${bar} ${theme.fg("muted", `${model.percentage}%`)}`));
	}

	const showDiagnostics = opts.showToolDetails === true || model.verdict === "disapproved" || model.verdict === "error";
	if (showDiagnostics) {
		if (model.currentTool) {
			const args = model.currentToolArgs ? ` ${dim(theme, truncateText(model.currentToolArgs, Math.max(10, inner - 20)))}` : "";
			lines.push(boxLine(theme, safeWidth, `${accent(theme, "tool")} ${model.currentTool}${args}`));
		}
		if (model.recentOutput.length > 0) {
			lines.push(boxLine(theme, safeWidth, dim(theme, "─".repeat(Math.max(4, inner - 8)))));
			for (const output of model.recentOutput.slice(0, 3)) {
				lines.push(boxLine(theme, safeWidth, dim(theme, truncateText(output, Math.max(8, inner - 4)))));
			}
		}
	}

	lines.push(boxFooter(theme, safeWidth, model.active ? "Esc: stop audit" : ""));
	return lines;
}

/** Audit result card (§15.4): APPROVED or CHANGES REQUIRED / ERROR. */
export function renderAuditResultCard(card: AuditResultCard, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	const success = card.verdict === "approved";
	const accentColor = success ? "success" : "error";
	lines.push(boxHeader(theme, safeWidth, frame(theme, `Audit result ─ ${card.label}`)));
	for (const line of card.lines) {
		const symbol = success ? "✓" : "✗";
		lines.push(boxLine(theme, safeWidth, `${theme.fg(accentColor as RenderColor, symbol)} ${fit(line, inner - 4)}`));
	}
	lines.push(boxFooter(theme, safeWidth, ""));
	return lines;
}
