import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nowIso } from "./goal-record.ts";
import type { GoalCore } from "./goal-state.ts";

/** Both entry points use the durable scheduler; only the slash command renews an active allowance. */
export function resumeFocusedGoal(core: GoalCore, ctx: ExtensionContext, renewActiveAllowance = false): { ok: boolean; message: string } {
	core.reconcileFocusedGoalFromDisk(ctx);
	const goal = core.state.goal;
	if (!goal) return { ok: false, message: "No goal is focused. Ask the user to select an open goal with /goal-focus." };
	if (!renewActiveAllowance && goal.status === "active") {
		if (goal.scheduler && goal.scheduler.owner !== ctx.sessionManager.getSessionId()) {
			return { ok: false, message: "The active scheduler belongs to another session. Use /goal-resume to explicitly take ownership." };
		}
		if (goal.autoContinue && goal.scheduler?.phase !== "interrupted") return { ok: true, message: "Goal is already running; progress and spent allowance unchanged." };
	}
	const resumed = core.scheduler.resumeResult(ctx);
	if (!resumed.ok) return { ok: false, message: `Goal was not resumed: ${resumed.message}` };
	core.goalService.appendEvents(ctx, [{ type: "goal_resumed", goalId: goal.id, reason: "user", at: nowIso() }]);
	return { ok: true, message: "Goal resumed; autonomous allowance renewed. Progress, configured limits and token usage preserved." };
}
