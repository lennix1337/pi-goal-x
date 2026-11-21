import type { GoalCore } from "./goal-state.ts";
import { registerCoreTools } from "./goal-core-tools.ts";
import { registerTaskTools } from "./goal-task-tools.ts";
import { registerDraftingTools } from "./goal-drafting.ts";
import { runGoalCompletionFlow } from "./goal-completion.ts";

/** Register the goal tools and completion flow. */
export function registerGoalTools(core: GoalCore): void {
	registerCoreTools(core, { runGoalCompletionFlow });
	registerTaskTools(core);
	registerDraftingTools(core);
}
