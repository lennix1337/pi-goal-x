---
name: goal-budgets
description: Configure conversational run or token limits when drafting a persistent /goal, or changing an existing goal with /goal-tweak.
---

Use `propose_goal_draft` within the user's guided draft. Translate requested limits to `max_autonomous_runs` and `token_budget`; `null` means unlimited. New goals use the configured run default, otherwise 30; tokens are unlimited unless requested. For tweaks, omitted fields retain the current limits.

State defaults in the confirmation; ask one focused question only for ambiguous limits. Preserve the objective, tasks, mode and auditor on a budget-only tweak. Report actual persisted limits from the tool response.

Runs count extension-scheduled continuations, not tool calls or every assistant message. Changing a limit retains spent runs and tokens; explicit resume renews the run allowance. Budgets never grant permission for external actions.
