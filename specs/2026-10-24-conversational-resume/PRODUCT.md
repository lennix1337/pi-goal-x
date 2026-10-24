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

## Amendment 2026-10-24: automatic resume (supersedes the explicit-user-only rule above)

User steering: goals must continue automatically, without the user authorizing each resume, as in Claude Code. The earlier "only an explicit user request may resume" rule and "quota recovery is not authorization" are reversed.

- The agent may resume its own pauses: status `paused` with `stopReason` agent (pause by `update_goal` or by the scheduler) and status `blocked`, via `update_goal({status: "active"})`, once the blocker is resolved (the user answered, the provider/quota is back, evidence settles it). A goal the user paused (`/goal-pause`, Esc; `stopReason` user) still resumes on the user's request. The tool cannot see who is asking, so this is prompt guidance, not a hard refusal.
- The agent pauses only when every remaining path needs a user-only action (permission, credentials, payment, a preference no evidence settles); otherwise it decides and keeps working.
- An agent resume never renews the run allowance: the spent runs and the user's cap persist, `goal_resumed` is logged with reason `agent`, and a spent allowance is refused with a pointer to `/goal-tweak` or `/goal-resume`. `/goal-resume` keeps renewing.
- A restart does not pause an interrupted goal (claimed/running/interrupted phase). The old dispatch is never replayed; one fresh `recovery` continuation is dispatched under the normal allowance and budget checks and tells the model the previous run was interrupted, to verify state and not repeat uncertain effects.
- Provider failures `Connection error.` and `terminated` are transient for goal-level backoff. Quota/billing stays non-transient (owned by the account tooling).
