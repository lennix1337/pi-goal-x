import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { displayObjectiveTitle } from "./goal-core.ts";
import type { GoalRecord } from "./goal-record.ts";
import { deriveCurrentTask, deriveTopLevelTaskProgress, flattenTaskTree } from "./widgets/goal-dashboard-model.ts";
import type { AuditorWidgetProgress } from "./widgets/goal-widget.ts";
import { truncateToWidth } from "./widgets/text-cache.ts";

/** pi.events channel carrying the short goal status for other extensions (footer). */
export const GOAL_STATUS_EVENT = "goal-x:status:v1";

export interface GoalStatusPayload {
	/** Short footer text; empty when there is nothing to show. */
	text: string;
	focused: boolean;
	/** Open (not complete) goals in the pool, the focused one included. */
	open: number;
}

const TITLE_MAX = 40;

function cut(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function phaseLabel(goal: GoalRecord, auditing: boolean, stalled: boolean): string {
	if (auditing) return "auditando";
	switch (goal.status) {
		case "active": return stalled ? "parada" : goal.autoContinue ? "em andamento" : "ociosa";
		case "paused": return "pausada";
		case "blocked": return "bloqueada";
		case "budget_limited": return "sem orçamento";
		case "complete": return "concluída";
	}
}

/** The one-line goal status: `meta: 3 abertas · /goal-focus` or `meta: <title> · <phase> <done>/<total>`. */
export function goalStatusPayload(args: {
	goal: GoalRecord | null;
	openCount: number;
	auditing?: boolean;
	stalled?: boolean;
}): GoalStatusPayload {
	const { goal, openCount } = args;
	if (!goal) {
		if (openCount <= 0) return { text: "", focused: false, open: 0 };
		const noun = openCount === 1 ? "aberta" : "abertas";
		return { text: `meta: ${openCount} ${noun} · /goal-focus`, focused: false, open: openCount };
	}
	const progress = deriveTopLevelTaskProgress(goal);
	const phase = phaseLabel(goal, args.auditing === true, args.stalled === true);
	const ratio = progress ? ` ${progress.completed}/${progress.total}` : "";
	return { text: `meta: ${cut(displayObjectiveTitle(goal.objective), TITLE_MAX)} · ${phase}${ratio}`, focused: true, open: openCount };
}

/**
 * The single widget line, only for a focused goal that is running AND has
 * something the status text cannot hold: a stall, the auditor's current step,
 * or the task being worked on. Returns null otherwise (no widget at all).
 */
export function goalWidgetLine(goal: GoalRecord | null, extra: { auditor?: AuditorWidgetProgress | null; stalled?: boolean }): string | null {
	if (!goal || goal.status !== "active" || !goal.autoContinue) return null;
	if (extra.stalled) return "⚠ sem atividade recente · /goal-status";
	const auditor = extra.auditor;
	if (auditor && auditor.phase !== "done") {
		const step = auditor.currentTool ?? auditor.label ?? auditor.phase;
		const pct = auditor.percentage === undefined ? "" : ` ${Math.round(auditor.percentage)}%`;
		return `⚖ auditor: ${cut(step, 60)}${pct}`;
	}
	const current = deriveCurrentTask(goal, flattenTaskTree(goal.taskList?.tasks, goal.currentTaskId));
	return current ? `▸ ${cut(current.title, 80)}` : null;
}

/** Live one-line widget; reads the line at render time like the full dashboard. */
export class GoalLineWidget implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly getLine: () => string | null;

	constructor(tui: TUI, theme: Theme, getLine: () => string | null) {
		this.tui = tui;
		this.theme = theme;
		this.getLine = getLine;
	}

	render(width: number): string[] {
		const line = this.getLine();
		if (!line || width <= 0) return [];
		return [truncateToWidth(this.theme.fg("dim", line), width)];
	}

	update(): void {
		this.tui.requestRender();
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}
