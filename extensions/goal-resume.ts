import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nowIso } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";

/**
 * Both entry points use the durable scheduler. The slash command ("user") renews the run
 * allowance; the update_goal tool ("agent") keeps the user's cap and refuses once it is spent.
 */
export function resumeFocusedGoal(core: GoalCore, ctx: ExtensionContext, source: "user" | "agent" = "agent"): { ok: boolean; message: string } {
	const renewAllowance = source === "user";
	core.reconcileFocusedGoalFromDisk(ctx);
	const goal = core.state.goal;
	if (!goal) return { ok: false, message: "No goal is focused. Ask the user to select an open goal with /goal-focus." };
	if (!renewAllowance && goal.status === "active") {
		if (goal.scheduler && goal.scheduler.owner !== ctx.sessionManager.getSessionId()) {
			return { ok: false, message: "The active scheduler belongs to another session. Use /goal-resume to explicitly take ownership." };
		}
		if (goal.autoContinue && goal.scheduler?.phase !== "interrupted") return { ok: true, message: "Goal is already running; progress and spent allowance unchanged." };
	}
	const resumed = core.scheduler.resumeResult(ctx, { preserveAllowance: !renewAllowance });
	if (!resumed.ok) return { ok: false, message: `Goal was not resumed: ${resumed.message}` };
	core.goalService.appendEvents(ctx, [{ type: "goal_resumed", goalId: goal.id, reason: source, at: nowIso() }]);
	return { ok: true, message: renewAllowance
		? "Goal resumed; autonomous allowance renewed. Progress, configured limits and token usage preserved."
		: "Goal resumed; spent run allowance, progress, configured limits and token usage preserved." };
}
