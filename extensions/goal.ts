import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommands } from "./goal-commands.ts";
import { registerGoalEvents } from "./goal-events.ts";
import {
	GOAL_AUDIT_ENTRY,
	GOAL_EVENT_ENTRY,
	renderGoalAuditEvent,
	renderGoalEvent,
	type GoalAuditEventDetails,
} from "./goal-format.ts";
import type { GoalEventDetails } from "./goal-record.ts";
import { createGoalCore, type GoalCoreDependencies } from "./goal-state.ts";
import { registerGoalTools } from "./goal-tools.ts";
import { filterGoalSessionContext, isDelegatedGoalSession } from "./goal-session-safety.ts";

/**
 * pi-goal thin installer. All state lives in the GoalCore (goal-state.ts);
 * the tool surface, command palette, event handlers, and widget/keybindings
 * are registered from their dedicated modules. No goal-file writes, ledger
 * appends, or prompt construction happen here.
 */
export default function goalExtension(
	pi: ExtensionAPI,
	dependencies: GoalCoreDependencies = {},
): void {
	if (isDelegatedGoalSession()) {
		pi.on("context", async event => {
			const messages = filterGoalSessionContext(event.messages, true);
			return messages === null ? undefined : { messages };
		});
		return;
	}
	pi.registerMessageRenderer<GoalEventDetails>(GOAL_EVENT_ENTRY, renderGoalEvent);
	pi.registerMessageRenderer<GoalAuditEventDetails>(GOAL_AUDIT_ENTRY, renderGoalAuditEvent);

	const core = createGoalCore(pi, dependencies);
	(pi as unknown as { _goalCore?: typeof core })._goalCore = core;
	registerGoalCommands(core);
	registerGoalTools(core);
	registerGoalEvents(core);
}
