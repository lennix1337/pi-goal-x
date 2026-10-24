# Conversational resume

The user can explicitly authorize resuming the focused paused or blocked goal in conversation, without entering `/goal-resume`. Expose this through `update_goal({status: "active"})`, not a new tool.

- The agent must have an explicit user request. A checkpoint, quota recovery, hidden extension event or tool hint is not authorization.
- Reuse the slash command's scheduler, durable state mutation and resumption event.
- Preserve identity, objective, task progress, limits and token usage. As with explicit `/goal-resume`, renew the spent autonomous-run allowance when resuming a stopped goal.
- A duplicate tool resume of an already-running goal is a no-op, not an allowance reset. Do not take over another session's active scheduler through this tool.
- Refuse absent/completed goals, exhausted token budgets and disabled autonomous continuation. Report storage failures as native tool errors. Never replay stale dispatches.
- `/goal-resume` keeps its explicit allowance-renewal behavior, including for an already-active goal.

Acceptance: real registered-tool tests observe disk state, ledger event, retained task/budget data and exactly one fresh continuation after settlement; duplicate and refusal tests verify no extra mutation/dispatch. Discovery must describe explicit-user-only use. Live-session activation is separate from source tests and requires a reload.

Automatic provider-quota recovery remains a separate task; this feature does not probe a provider or launch paid requests.
