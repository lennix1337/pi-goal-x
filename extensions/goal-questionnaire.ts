import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "./widgets/text-cache.ts";


export type GoalDraftingFocus = "goal" | "sisyphus";

export interface GoalQuestionnaireQuestion {
	id: string;
	question: string;
	context?: string;
	options: string[];
	recommended?: number;
	allowCustom?: boolean;
}

export interface GoalQuestionnaireAnswer {
	id: string;
	question: string;
	answer: string;
	wasCustom: boolean;
}

export interface GoalQuestionnaireResult {
	questions: GoalQuestionnaireQuestion[];
	answers: GoalQuestionnaireAnswer[];
	cancelled: boolean;
	auditorEnabled?: boolean;
	/**
	 * The host could not present the dialog at all, so `cancelled` reflects an
	 * absent UI rather than a decision the user made. Hosts that expose a
	 * non-terminal UI keep `ctx.hasUI` true while `ctx.ui.custom` stays the
	 * SDK's headless default, which resolves to `undefined`.
	 */
	unavailable?: boolean;
}

export type ProposalDecision = "confirm" | "continue" | "cancel";

/**
 * Bound a custom dialog using the regular renderer's frame cache when
 * available. The pi 0.84 fullscreen renderer does not expose that cache, so
 * reserve four rows for host chrome and use the remaining terminal height.
 */
export function computeDialogLineLimit(args: { terminalRows?: number; baseFrameLines?: number }): number | undefined {
	const rows = args.terminalRows;
	if (!rows || rows <= 0) return undefined;
	if (args.baseFrameLines && args.baseFrameLines > 0) {
		return Math.min(rows, Math.max(10, rows - args.baseFrameLines + 1));
	}
	return Math.min(rows, Math.max(4, rows - 4));
}

/**
 * Proposal-confirmation segment descriptor: absolute line indices of the
 * tasks section (header + every task line) and the start of the options tail
 * inside a rendered questionnaire dialog.
 */
export interface ProposalPresentationSegments {
	tasksStart: number;
	tasksEnd: number;
	tailStart: number;
}

function stripAnsiCodes(value: string): string {
	// eslint-disable-next-line no-control-regex -- deliberate ANSI SGR escape-sequence matching
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Locate the proposal tasks segment and the options tail in a rendered dialog.
 * Returns null when the dialog is not a proposal-style confirmation (no
 * "Tasks proposed for confirmation:" header / "┌─ TASKS ─" box).
 *
 * The scan is ANSI-aware: every rendered line carries `theme.fg(...)` escape
 * sequences in the real TUI (the mock theme does not), so plain-text regexes
 * must be run against the stripped line or the tasks section collapses to its
 * header and every styled task line is sliced out of the bounded frame. The
 * box-drawn bottom border (`└───┘`) after the last task line is kept so the
 * `┌─ TASKS ─┐` box renders complete.
 *
 * The interactive auditor toggle line ("press 'a' to toggle") renders between
 * the context and the options; `tailStart` is pulled back to it so the bounded
 * fit always keeps the auditor status visible (its status text is the only
 * visible toggle feedback in the dialog).
 */
export function findProposalPresentationSegments(lines: string[], tailStart: number): ProposalPresentationSegments | null {
	if (tailStart < 0) return null;
	const tasksStart = lines.findIndex((l) => l.includes("Tasks proposed for confirmation:") || l.includes("┌─ TASKS ─"));
	if (tasksStart < 0 || tasksStart >= tailStart) return null;
	let tasksEnd = tasksStart;
	for (let i = tasksStart + 1; i < tailStart; i++) {
		const plain = stripAnsiCodes(lines[i]!);
		if (/^\s*\[[ x~]\]/.test(plain)) {
			tasksEnd = i;
			continue;
		}
		if (tasksEnd > tasksStart && /^[└┐┤┘─]/.test(plain.trim())) tasksEnd = i;
		break;
	}
	let effectiveTail = tailStart;
	for (let i = tailStart - 1; i > tasksEnd; i--) {
		if (lines[i]!.includes("press 'a' to toggle")) {
			effectiveTail = i;
			break;
		}
	}
	return { tasksStart, tasksEnd, tailStart: effectiveTail };
}

/**
 * Fit a rendered dialog to the terminal-height bound without ever hiding the
 * question. The protected head (top border + tabs + question line) is always
 * kept; the remaining budget is spent on the tail — options/footer/bottom
 * border — so long context blocks (proposal confirmations) are sliced from
 * their head exactly as the pre-fix tail-slice did (383ae52 surface). The
 * footer hint and bottom border are always the last rendered lines. Never
 * returns more than maxDialogLines.
 *
 * Proposal confirmations (proposal segments given) keep the head, the tasks
 * section (header + every task line), and the options/footer/bottom border in
 * frame; only the objective-box middle is sacrificed in-frame — the full
 * objective is always present in the scrollable transcript presentation
 * (propose_goal_draft renderCall), so nothing of the goal is ever omitted.
 *
 * §options-scroll: when a `scroll` state is given (select-mode question tabs
 * and the submit summary), the dialog becomes a `less`-style viewport over the
 * FULL content — nothing is truncated, nothing is sliced away — and the
 * options are always reachable by scrolling (PageUp/PageDown, Ctrl+↑/↓, and
 * ↑/↓ selection auto-follow). See fitDialogViewport.
 */
export interface DialogScrollState {
	scrollTop: number;
	needsFollow: boolean;
	optionRanges: Array<[number, number]>;
	followIndex: number;
}

export function fitDialogLines(
	lines: string[],
	maxDialogLines: number,
	protectedHead: number,
	proposal: ProposalPresentationSegments | null = null,
	scroll: DialogScrollState | null = null,
	dimStyle: (s: string) => string = (s) => s,
): string[] {
	if (maxDialogLines <= 0 || lines.length <= maxDialogLines) return lines;
	const keepHead = Math.min(protectedHead, maxDialogLines);
	if (proposal) {
		return fitProposalPresentation(lines, maxDialogLines, keepHead, proposal);
	}
	if (scroll) {
		return fitDialogViewport(lines, maxDialogLines, scroll, dimStyle);
	}
	const budget = maxDialogLines - keepHead;
	if (budget <= 0) return lines.slice(0, keepHead);
	const rest = lines.slice(protectedHead);
	if (rest.length <= budget) return [...lines.slice(0, keepHead), ...rest];
	return [...lines.slice(0, keepHead), ...rest.slice(rest.length - budget)];
}

function fitDialogViewport(
	lines: string[],
	maxDialogLines: number,
	scroll: DialogScrollState,
	dimStyle: (s: string) => string,
): string[] {
	const contentWindow = Math.max(0, maxDialogLines - 1);
	const contentEnd = Math.max(0, lines.length - 1);
	if (scroll.needsFollow && scroll.optionRanges[scroll.followIndex]) {
		const [os, oe] = scroll.optionRanges[scroll.followIndex]!;
		if (os < scroll.scrollTop || oe >= scroll.scrollTop + contentWindow) {
			scroll.scrollTop = oe >= scroll.scrollTop + contentWindow
				? Math.min(os, Math.max(0, oe - contentWindow + 1))
				: os;
		}
		scroll.needsFollow = false;
	}
	scroll.scrollTop = Math.max(0, Math.min(scroll.scrollTop, Math.max(0, contentEnd - contentWindow)));
	const s = scroll.scrollTop;
	const hiddenAbove = s;
	const hiddenBelow = contentEnd - (s + contentWindow);
	const viewport = lines.slice(s, s + contentWindow);
	if (hiddenAbove > 0 && viewport.length > 0) {
		viewport[0] = dimStyle(`▲ ${hiddenAbove} more`);
	}
	if (hiddenBelow > 0) {
		viewport.push(dimStyle(`… +${hiddenBelow} more · PgUp/PgDn scroll`));
	} else {
		viewport.push(lines[lines.length - 1]!);
	}
	return viewport;
}

function fitProposalPresentation(
	lines: string[],
	maxDialogLines: number,
	keepHead: number,
	proposal: ProposalPresentationSegments,
): string[] {
	const { tasksStart, tasksEnd, tailStart } = proposal;
	const head = lines.slice(0, keepHead);
	const tasks = lines.slice(Math.max(tasksStart, keepHead), Math.min(tasksEnd, tailStart) + 1);
	const tail = lines.slice(Math.max(tailStart, keepHead));
	const candidate = [...head, ...tasks, ...tail];
	if (candidate.length <= maxDialogLines) return candidate;
	const stripped = candidate.filter((l, i) => i < keepHead || l.trim() !== "");
	if (stripped.length <= maxDialogLines) return stripped;
	const tailNoBlanks = tail.filter((l) => l.trim() !== "");
	const hasAuditor = tail.length > 0 && tail[0]!.includes("press 'a' to toggle");
	const restTail = hasAuditor ? tailNoBlanks.slice(1) : tailNoBlanks;
	const keepRest = Math.min(restTail.length, Math.max(0, maxDialogLines - keepHead - (hasAuditor ? 1 : 0)));
	const tailKept = [...(hasAuditor ? [tail[0]!] : []), ...restTail.slice(restTail.length - keepRest)];
	const keepTasks = Math.min(tasks.length, Math.max(0, maxDialogLines - keepHead - tailKept.length));
	return [...head, ...tasks.slice(0, keepTasks), ...tailKept];
}

export function normalizeQuestionnaireQuestions(rawQuestions: GoalQuestionnaireQuestion[]): GoalQuestionnaireQuestion[] {
	const seenIds = new Set<string>();
	return rawQuestions.map((q, i) => {
		let id = q.id.trim() || `q${i + 1}`;
		if (seenIds.has(id)) id = `${id}-${i + 1}`;
		seenIds.add(id);
		const options = q.options.filter((option) => option.trim().length > 0);
		const recommended = q.recommended !== undefined && q.recommended >= 0 && q.recommended < options.length
			? q.recommended
			: undefined;
		return { ...q, id, options, recommended, allowCustom: q.allowCustom ?? true };
	});
}

export function formatQuestionnaireAnswers(result: GoalQuestionnaireResult): string {
	return result.answers.map((answer) => {
		const question = result.questions.find((q) => q.id === answer.id);
		const lines = [`**Q:** ${answer.question}`];
		if (question?.context) lines.push(`\n${question.context}`);
		if (question && question.options.length > 0) lines.push(`\nOptions: ${question.options.join(" / ")}`);
		lines.push(`\n**A:** ${answer.answer}`);
		return lines.join("");
	}).join("\n\n---\n\n");
}

export function shouldAutoConfirmProposal(args: { hasUI: boolean; autoConfirmEnv?: string }): boolean {
	if (args.autoConfirmEnv === "0") return false;
	return !args.hasUI || args.autoConfirmEnv === "1";
}

export function proposalDecisionFromQuestionnaireResult(args: { cancelled: boolean; answer?: string }): ProposalDecision {
	if (args.cancelled) return "continue";
	if ((args.answer ?? "").startsWith("Confirm")) return "confirm";
	if ((args.answer ?? "").startsWith("Cancel")) return "cancel";
	return "continue";
}

export function isHeadlessQuestionSufficientForDraft(args: { topic: string; questionText: string }): boolean {
	const topic = args.topic.toLowerCase();
	void args;
	const vagueTopic = topic.trim().length < 20 || /(整理笔记|organize notes|notes|笔记)$/.test(topic.trim());
	return !vagueTopic;
}

const CUSTOM_ANSWER_LABEL = "Write your own answer...";

async function runQuestionnaireWithBasicDialogs(
	ctx: ExtensionContext,
	questions: GoalQuestionnaireQuestion[],
	auditorToggleInit?: { defaultEnabled: boolean },
): Promise<GoalQuestionnaireResult> {
	const unavailable = (): GoalQuestionnaireResult => ({ questions: [], answers: [], cancelled: true, unavailable: true, ...(auditorToggleInit ? { auditorEnabled: auditorToggleInit.defaultEnabled } : {}) });
	if ((auditorToggleInit || questions.some(q => q.options.length > 0)) && typeof ctx.ui.select !== "function") return unavailable();
	if (questions.some(q => q.options.length === 0 || q.allowCustom !== false) && typeof ctx.ui.input !== "function") return unavailable();
	let auditorEnabled = auditorToggleInit?.defaultEnabled;
	const cancelled = (): GoalQuestionnaireResult => ({ questions, answers: [], cancelled: true, auditorEnabled });
	if (auditorToggleInit) {
		const enabled = "Enabled — require independent approval";
		const disabled = "Disabled — skip the completion audit";
		const choices = auditorEnabled ? [enabled, disabled] : [disabled, enabled];
		const picked = await ctx.ui.select(`Completion auditor (currently ${auditorEnabled ? "enabled" : "disabled"})`, choices);
		if (picked === undefined) return cancelled();
		if (!choices.includes(picked)) throw new Error("The host returned an unknown auditor choice");
		auditorEnabled = picked === enabled;
	}
	const answers: GoalQuestionnaireAnswer[] = [];
	for (const question of questions) {
		let prompt = question.context ? `${question.question}\n\n${question.context}` : question.question;
		if (auditorToggleInit) prompt += `\n\nAuditor for this goal: ${auditorEnabled ? "enabled (independent approval required)" : "disabled (completion skips the audit)"}.`;
		let answer: string | undefined;
		let wasCustom = question.options.length === 0;
		if (!wasCustom) {
			const labels = question.options.map((option, i) => `${i + 1}. ${option}${question.recommended === i ? " (Recommended)" : ""}`);
			const customLabel = `${labels.length + 1}. ${CUSTOM_ANSWER_LABEL}`;
			const options = question.allowCustom === false ? labels : [...labels, customLabel];
			const picked = await ctx.ui.select(prompt, options);
			if (picked === undefined) return cancelled();
			if (!options.includes(picked)) throw new Error("The host returned an unknown questionnaire choice");
			wasCustom = picked === customLabel && question.allowCustom !== false;
			if (!wasCustom) answer = question.options[labels.indexOf(picked)];
		}
		if (wasCustom) {
			do {
				answer = (await ctx.ui.input(prompt, "Write your answer"))?.trim();
			} while (answer === "");
		}
		if (answer === undefined) return cancelled();
		answers.push({ id: question.id, question: question.question, answer, wasCustom });
	}
	return { questions, answers, cancelled: false, auditorEnabled };
}

export const DIALOG_UNAVAILABLE_HINT = "This host cannot display the required goal-drafting dialogs. Use a host with select/input support or the pi TUI, or explicitly restart with PI_GOAL_AUTO_CONFIRM=1 to confirm proposals without a dialog.";

export function proposalDialogFailureMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `Goal draft confirmation failed: ${detail}. The goal was NOT created; drafting remains active.`;
}

/**
 * Shared question UI used by both the agent-callable goal_questionnaire tool and
 * the internal draft-confirm prompt. This keeps pi-goal self-contained and
 * avoids depending on external question/questionnaire packages.
 */
export async function runGoalQuestionnaire(ctx: ExtensionContext, rawQuestions: GoalQuestionnaireQuestion[], auditorToggleInit?: { defaultEnabled: boolean }): Promise<GoalQuestionnaireResult> {
	if (!ctx.hasUI) {
		return { questions: [], answers: [], cancelled: true };
	}

	const questions = normalizeQuestionnaireQuestions(rawQuestions);
	if (typeof ctx.ui.custom !== "function") {
		return runQuestionnaireWithBasicDialogs(ctx, questions, auditorToggleInit);
	}
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1;

	const showRichDialog = async () => await ctx.ui.custom<GoalQuestionnaireResult | undefined>((tui, theme, _kb, done) => {
		if (!tui || typeof tui.getShowHardwareCursor !== "function" || typeof tui.setShowHardwareCursor !== "function" || typeof tui.requestRender !== "function") {
			done(undefined);
			return { render: () => [], invalidate: () => {} };
		}
		const wasHardwareCursorShown = tui.getShowHardwareCursor();
		tui.setShowHardwareCursor(false);
		ctx.ui.setWorkingVisible(false);
		// external: pi-tui can erase scrollback when a dialog taller than the terminal closes.
		const tuiInfo = tui as unknown as { terminal?: { rows?: number }; previousLines?: string[] };
		const terminalRows = tuiInfo.terminal?.rows;
		const baseFrame = tuiInfo.previousLines?.length;
		const maxDialogLines = computeDialogLineLimit({ terminalRows, baseFrameLines: baseFrame });
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let dialogFocused = false;
		let cachedLines: string[] | undefined;
		let optionsStartIndex = -1;
		let scrollTop = 0;
		let needsFollow = false;
		let optionRanges: Array<[number, number]> = [];
		let questionBlockEnd = -1;
		let auditorEnabled = auditorToggleInit?.defaultEnabled ?? true;
		const answers = new Map<string, GoalQuestionnaireAnswer>();
		const drafts = new Map<string, string>();

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean) {
			tui.setShowHardwareCursor(wasHardwareCursorShown);
			ctx.ui.setWorkingVisible(true);
			const ordered = questions.map((q) => answers.get(q.id)).filter((a): a is GoalQuestionnaireAnswer => !!a);
			done({ questions, answers: ordered, cancelled, auditorEnabled: auditorToggleInit ? auditorEnabled : undefined });
		}

		function currentQuestion(): GoalQuestionnaireQuestion | undefined {
			return questions[currentTab];
		}

		function displayOptions(): Array<{ label: string; isCustom?: boolean }> {
			const q = currentQuestion();
			if (!q) return [];
			const opts: Array<{ label: string; isCustom?: boolean }> = q.options.map((label) => ({ label }));
			if (q.allowCustom !== false) opts.push({ label: "Write your own answer...", isCustom: true });
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function enterQuestion(q: GoalQuestionnaireQuestion) {
			const existing = answers.get(q.id);
			const draft = drafts.get(q.id);
			scrollTop = 0;
			needsFollow = false;
			if (q.options.length === 0) {
				inputMode = true;
				inputQuestionId = q.id;
				editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
				editor.focused = dialogFocused;
				tui.setShowHardwareCursor(dialogFocused);
			} else if (existing?.wasCustom) {
				optionIndex = q.options.length;
			} else if (existing && !existing.wasCustom) {
				const idx = q.options.indexOf(existing.answer);
				optionIndex = idx >= 0 ? idx : 0;
			} else {
				optionIndex = q.recommended ?? 0;
			}
		}

		function enterSubmitTab() {
	optionIndex = 0;
	scrollTop = 0;
	needsFollow = false;
}

function advanceAfterAnswer() {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) currentTab++;
			else currentTab = questions.length;
			const nextQ = currentQuestion();
			if (nextQ) enterQuestion(nextQ);
			else enterSubmitTab();
			refresh();
		}

		function saveAnswer(qId: string, value: string, wasCustom: boolean) {
			const q = questions.find((qq) => qq.id === qId);
			answers.set(qId, { id: qId, question: q?.question ?? qId, answer: value, wasCustom });
		}

	function fitOptionsInFrame(
		lines: string[],
		maxDialogLines: number,
		questionBlockEnd: number,
		optionsStart: number,
		lastOptionLine: number,
	): string[] | null {
		if (maxDialogLines <= 0 || lines.length <= maxDialogLines) return lines;
		if (optionsStart < 0 || lastOptionLine < optionsStart) return null;
		const head = lines.slice(0, Math.max(questionBlockEnd, 1));
		const middle = lines.slice(Math.max(questionBlockEnd, 1), optionsStart);
		const tail = lines.slice(optionsStart);
		const optionsBlockLen = lastOptionLine - optionsStart + 1;
		if (optionsBlockLen + 1 > maxDialogLines) return null;
		const mid = middle.slice();
		while (head.length + mid.length + tail.length > maxDialogLines && mid.length > 0) {
			let blankIdx = -1;
			for (let i = mid.length - 1; i >= 0; i--) {
				if (mid[i]!.trim() === "") { blankIdx = i; break; }
			}
			if (blankIdx >= 0) mid.splice(blankIdx, 1);
			else mid.pop();
		}
		const tailKept = tail.slice();
		while (head.length + mid.length + tailKept.length > maxDialogLines && tailKept.length > optionsBlockLen + 1) {
			let tailBlank = -1;
			for (let i = tailKept.length - 2; i >= 1; i--) {
				if (tailKept[i]!.trim() === "") { tailBlank = i; break; }
			}
			if (tailBlank >= 1) tailKept.splice(tailBlank, 1);
			else tailKept.splice(tailKept.length - 2, 1);
		}
		const headKept = head.slice();
		while (head.length + mid.length + tailKept.length > maxDialogLines && headKept.length > 1) {
			headKept.pop();
		}
		if (headKept.length + mid.length + tailKept.length > maxDialogLines) return null;
		return [...headKept, ...mid, ...tailKept];
	}

	function enterInputMode(qId: string) {
			inputMode = true;
			inputQuestionId = qId;
			const draft = drafts.get(qId);
			const existing = answers.get(qId);
			editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
			editor.focused = dialogFocused;
			tui.setShowHardwareCursor(dialogFocused);
		}

		function leaveInputMode() {
			inputMode = false;
			inputQuestionId = null;
			editor.focused = false;
			tui.setShowHardwareCursor(false);
			editor.setText("");
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim();
			if (!trimmed) {
				refresh();
				return;
			}
			drafts.delete(inputQuestionId);
			saveAnswer(inputQuestionId, trimmed, true);
			leaveInputMode();
			advanceAfterAnswer();
		};

		function exitEditor() {
			if (inputQuestionId) {
				const text = editor.getText();
				if (text.trim()) drafts.set(inputQuestionId, text);
				else drafts.delete(inputQuestionId);
			}
			leaveInputMode();
		}

		enterQuestion(questions[0]!);

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					const q = currentQuestion();
					if (q && q.options.length === 0 && !isMulti) submit(true);
					else {
						exitEditor();
						refresh();
					}
					return;
				}
				if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
					exitEditor();
					currentTab = matchesKey(data, Key.tab) ? (currentTab + 1) % totalTabs : (currentTab - 1 + totalTabs) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else enterSubmitTab();
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const q = currentQuestion();
			const opts = displayOptions();

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					currentTab = (currentTab + 1) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else enterSubmitTab();
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else enterSubmitTab();
					refresh();
					return;
				}
			}

			if (matchesKey(data, Key.pageUp)) {
				scrollTop -= Math.max(1, (maxDialogLines ?? 10) - 1);
				needsFollow = false;
				refresh();
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				scrollTop += Math.max(1, (maxDialogLines ?? 10) - 1);
				needsFollow = false;
				refresh();
				return;
			}
			if (matchesKey(data, Key.ctrl("up"))) {
				scrollTop -= 1;
				needsFollow = false;
				refresh();
				return;
			}
			if (matchesKey(data, Key.ctrl("down"))) {
				scrollTop += 1;
				needsFollow = false;
				refresh();
				return;
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
				else if (matchesKey(data, Key.escape)) submit(true);
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				needsFollow = true;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				needsFollow = true;
				refresh();
				return;
			}

			if (matchesKey(data, "a") && auditorToggleInit) {
				auditorEnabled = !auditorEnabled;
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter) && q) {
				if (q.options.length === 0 || opts[optionIndex]?.isCustom) {
					enterInputMode(q.id);
					refresh();
					return;
				}
				const opt = opts[optionIndex];
				if (opt) {
					saveAnswer(q.id, opt.label, false);
					advanceAfterAnswer();
				}
				return;
			}

			if (matchesKey(data, Key.escape)) submit(true);
		}

			function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const safeWidth = Math.max(20, width);
			let lines: string[] = [];
			const q = currentQuestion();
			const opts = displayOptions();
			const add = (s: string) => lines.push(truncateToWidth(s, safeWidth, "…", true));
			const addWrapped = (s: string) => lines.push(...wrapTextWithAnsi(s, safeWidth));
			const PIPE_PREFIX = "│   ";
			const PIPE_WIDTH = visibleWidth(PIPE_PREFIX);
			const addWrappedPipe = (styledLine: string) => {
				const wrapWidth = Math.max(1, safeWidth - PIPE_WIDTH);
				const wrapped = wrapTextWithAnsi(styledLine, wrapWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(i === 0 ? wrapped[i]! : PIPE_PREFIX + wrapped[i]!);
				}
			};

			const renderContextLines = (context: string): void => {
				const rawLines = context.split("\n");
				for (const rawLine of rawLines) {
					const trimmed = rawLine.trim();
					if (!trimmed) {
						lines.push("");
						continue;
					}

					if (/^● Goal (draft|tweak) ready for confirmation\.$/.test(trimmed)) {
						addWrapped(theme.fg("accent", rawLine));
						continue;
					}

					const sectionMatch = trimmed.match(/^───\s+(.+?)\s+───$/);
					if (sectionMatch) {
						const sectionName = sectionMatch[1];
						const namePart = ` ${sectionName} `;
						const left = "┌─";
						const right = "─┐";
						const fill = Math.max(0, safeWidth - 2 - visibleWidth(left + namePart + right));
						add(theme.fg("accent", left + namePart + "─".repeat(fill) + right));
						continue;
					}

					if (trimmed.startsWith("│")) {
						const afterPipe = trimmed.slice(1).trim();
						const pipeTaskMatch = afterPipe.match(/^(\[.\])(\s+)(.+)$/);
						if (pipeTaskMatch) {
							const bracket = pipeTaskMatch[1]!;
							const sep = pipeTaskMatch[2]!;
							const rest = pipeTaskMatch[3]!;
							const pipeContent = trimmed.slice(1);
							const innerWs = pipeContent.slice(0, pipeContent.length - pipeContent.trimStart().length);
							const linePrefix = "│" + innerWs;
							const color = bracket === "[x]" ? "success" : "warning";
							addWrappedPipe(linePrefix + theme.fg(color, bracket) + sep + theme.fg("muted", rest));
							continue;
						}
						if (afterPipe.includes(": ")) {
							const colonIdx = afterPipe.indexOf(": ");
							const val = afterPipe.slice(colonIdx + 2).trim();
							const keyPart = rawLine.slice(0, rawLine.indexOf(afterPipe) + colonIdx + 2);
							if (val === "yes" || val === "no") {
								addWrappedPipe(theme.fg("muted", keyPart) + theme.fg(val === "yes" ? "success" : "warning", val));
								continue;
							}
							addWrappedPipe(theme.fg("muted", rawLine));
							continue;
						}
						addWrappedPipe(theme.fg("muted", rawLine));
						continue;
					}

					const GOAL_SECTION_RE = /^(=== (Goal|Sisyphus Goal) ===|Objective:|Success criteria:|Boundaries:|Constraints:|Verification contract:|If blocked:)/;
					if (GOAL_SECTION_RE.test(trimmed)) {
						addWrapped(theme.fg("accent", rawLine));
						continue;
					}

					if (/^[┌├└┐┤┘─]/.test(trimmed)) {
						addWrapped(theme.fg("dim", rawLine));
						continue;
					}

					const checkMatch = trimmed.match(/^(\[.\])(\s+)(.+)$/);
					if (checkMatch) {
						const bracket = checkMatch[1]!;
						const sep = checkMatch[2]!;
						const rest = checkMatch[3]!;
						const indent = rawLine.slice(0, rawLine.length - trimmed.length);
						const color = bracket === "[x]" ? "success" : "warning";
						addWrapped(indent + theme.fg(color, bracket) + sep + theme.fg("muted", rest));
						continue;
					}

					addWrapped(theme.fg("muted", rawLine));
				}
			};

			add(theme.fg("accent", "─".repeat(safeWidth)));
			let protectedCount = lines.length;
			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const isActive = i === currentTab;
					const isAnswered = answers.has(questions[i]!.id);
					const label = ` ${isAnswered ? "■" : "□"} ${questions[i]!.id} `;
					tabs.push(isActive ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(isAnswered ? "success" : "muted", label));
					tabs.push(" ");
				}
				const submitText = " ✓ Submit ";
				tabs.push(currentTab === questions.length ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg(allAnswered() ? "success" : "dim", submitText));
				tabs.push(" →");
				add(` ${tabs.join("")}`);
				lines.push("");
				protectedCount = lines.length;
			}

			function renderOptions() {
				optionsStartIndex = lines.length;
				for (let i = 0; i < opts.length; i++) {
					const start = lines.length;
					const opt = opts[i]!;
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const recTag = !opt.isCustom && q?.recommended === i ? theme.fg("success", " ★") : "";
					addWrapped(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`) + recTag);
					optionRanges[i] = [start, lines.length - 1];
				}
			}

			if (inputMode && q) {
				addWrapped(theme.fg("text", ` ${q.question}`));
				protectedCount = lines.length;
				if (q.context) renderContextLines(q.context);
				lines.push("");
				if (q.options.length > 0) {
					renderOptions();
					lines.push("");
				}
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(safeWidth - 2)) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to cancel"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", theme.bold(" Ready to submit")));
				protectedCount = lines.length;
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					add(`${theme.fg("muted", ` ${question.id}: `)}${answer ? theme.fg("text", `${answer.wasCustom ? "(wrote) " : ""}${answer.answer}`) : theme.fg("warning", "(unanswered)")}`);
				}
				lines.push("");
				add(allAnswered() ? theme.fg("success", " Press Enter to submit") : theme.fg("warning", ` Unanswered: ${questions.filter((qq) => !answers.has(qq.id)).map((qq) => qq.id).join(", ")}`));
			} else if (q) {
				addWrapped(theme.fg("text", ` ${q.question}`));
				questionBlockEnd = lines.length;
				protectedCount = lines.length;
				if (q.context) renderContextLines(q.context);
				if (auditorToggleInit) {
					const circle = auditorEnabled ? "●" : "○";
					const label = auditorEnabled ? "Auditor enabled" : "Auditor disabled";
					const color = auditorEnabled ? "success" : "warning";
					add(theme.fg(color, ` ${circle} ${label}`) + theme.fg("dim", "  (press 'a' to toggle)"));
					lines.push("");
				}
				const existing = answers.get(q.id);
				if (existing) add(theme.fg("dim", ` Current: ${existing.wasCustom ? "(wrote) " : ""}${existing.answer}`));
				lines.push("");
				if (opts.length > 0) renderOptions();
				else add(theme.fg("muted", " Press Enter to write your answer"));
			}

			lines.push("");
			if (!inputMode) {
				const auditorHint = auditorToggleInit ? " • a toggle auditor" : "";
				add(theme.fg("dim", isMulti ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" + auditorHint : " ↑↓ navigate • Enter select • Esc cancel" + auditorHint));
			}
			add(theme.fg("accent", "─".repeat(safeWidth)));
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (line && visibleWidth(line) > safeWidth) {
					lines[i] = truncateToWidth(line, safeWidth);
				}
			}
			if (maxDialogLines !== undefined && lines.length > maxDialogLines) {
				const proposalSegments = !inputMode && currentTab !== questions.length && !!q && q.context
					? findProposalPresentationSegments(lines, optionsStartIndex)
					: null;
				if (proposalSegments) {
					lines = fitDialogLines(lines, maxDialogLines, protectedCount, proposalSegments);
				} else if (!inputMode && currentTab !== questions.length && questionBlockEnd >= 0) {
					const fitted = fitOptionsInFrame(lines, maxDialogLines, questionBlockEnd, optionsStartIndex, optionRanges[optionRanges.length - 1]?.[1] ?? -1);
					if (fitted) {
						lines = fitted;
						scrollTop = 0;
						needsFollow = false;
					} else {
						const scrollState = { scrollTop, needsFollow, optionRanges, followIndex: optionIndex };
						lines = fitDialogLines(lines, maxDialogLines, protectedCount, null, scrollState, (s) => theme.fg("dim", s));
						scrollTop = scrollState.scrollTop;
						needsFollow = scrollState.needsFollow;
					}
				} else {
					const scrollState = !inputMode ? { scrollTop, needsFollow, optionRanges, followIndex: optionIndex } : null;
					lines = fitDialogLines(lines, maxDialogLines, protectedCount, null, scrollState, (s) => theme.fg("dim", s));
					if (scrollState) {
						scrollTop = scrollState.scrollTop;
						needsFollow = scrollState.needsFollow;
					}
				}
			}
			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => { cachedLines = undefined; },
			handleInput,
			get focused(): boolean { return dialogFocused; },
			set focused(v: boolean) {
				dialogFocused = v;
				editor.focused = v && inputMode;
				tui.setShowHardwareCursor(v && inputMode);
			},
		};
	});
	// external: RPC hosts may advertise custom components but fail to render them.
	const result = ctx.mode === "rpc"
		? await showRichDialog().catch((error) => {
			ctx.ui.notify(
				`Goal dialog could not be rendered by this host (${error instanceof Error ? error.message : String(error)}); falling back to one dialog per question.`,
				"warning",
			);
			return undefined;
		})
		: await showRichDialog();
	if (result !== undefined) return result;
	return runQuestionnaireWithBasicDialogs(ctx, questions, auditorToggleInit);
}

/**
 * Confirm a proposed draft through the shared questionnaire UI. Escape / cancel
 * maps to "continue" so the user is never trapped.
 */
export async function showProposalDialog(
	ctx: ExtensionContext,
	confirmationText: string,
	focus: GoalDraftingFocus,
	defaultAuditorEnabled?: boolean,
): Promise<{ decision: ProposalDecision; auditorEnabled: boolean; unavailable: boolean }> {
	const headerTitle = focus === "sisyphus" ? "Confirm Sisyphus Goal Draft" : "Confirm Goal Draft";
	const result = await runGoalQuestionnaire(ctx, [{
		id: "confirm",
		question: headerTitle,
		context: confirmationText,
		options: ["Confirm — create this goal now", "Continue chatting — keep refining", "Cancel — discard this draft"],
		recommended: 0,
		allowCustom: false,
	}], defaultAuditorEnabled !== undefined ? { defaultEnabled: defaultAuditorEnabled } : undefined);
	const decision = proposalDecisionFromQuestionnaireResult({
		cancelled: result.cancelled,
		answer: result.answers[0]?.answer,
	});
	return { decision, auditorEnabled: result.auditorEnabled ?? true, unavailable: result.unavailable === true };
}
