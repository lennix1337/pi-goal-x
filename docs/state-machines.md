# Implicit state machines in pi-goal-x

Scope: everything the package ships (`extensions/**`, `scripts/recover-session-checkpoints.mjs`). `experiments/**` is not in the npm `files` list and is out of scope. Line numbers are against the `refactor/state-machines` branch after the changes described here.

An implicit state machine is a lifecycle held in several booleans, nullable fields, timers or persisted JSON instead of one explicit model. Each section gives the states, the transitions, where the state lives, the invariants, and findings (P1 = loses data or runs unattended work wrongly, P2 = wrong behaviour on a reachable path, P3 = representable but not observed to misbehave). Findings marked **fixed** have a regression test that fails without the fix.

## Summary

| # | Machine | States | Explicitness before | After | Findings |
|---|---|---|---|---|---|
| 1 | Goal lifecycle status | 5 | enum, ~9 writers, unvalidated read-back | enum, validated read-back | F-01 fixed, F-08 |
| 2 | Scheduler phase (persisted) | 6 | enum + validator, ad-hoc writers | unchanged | F-09 |
| 3 | Scheduler run flags | idle / running / declared / denied | 5 loose fields | unchanged | F-09 |
| 4 | Continuation dispatch (`GoalRuntime`) | none / scheduled / queued | 3 fields (`queuedFor`, `scheduledFor`, `timer`) | 2 fields, goal + timer together | F-07 fixed |
| 5 | Network-error backoff | idle / waiting(attempt n) | 3 fields | unchanged | F-10 |
| 6 | Turn-stop guard / checkpoint marker / reminders | small | 2 counters + 3 flags | unchanged | none |
| 7 | Turn transaction buffer (`GoalService`) | closed / open / dirty / failed-pending | 7 fields | unchanged | F-17 |
| 8 | Per-goal lock and settings path lock | free / held / stale-recovered | token-less lock file | owner token, checked release | F-02 fixed |
| 9 | Completion audit | idle / running / done card | 5 fields + 2 timers | cleanup on every exit, 2 dead fields removed | F-04 fixed, F-05 fixed |
| 10 | Token/time accounting | off / counting(goal) | explicit class | unchanged | none |
| 11 | Budget thresholds and `budget_limited` | warned set, limited | `Set` of strings + status | unchanged | none |
| 12 | Task status and `currentTaskId` | pending / complete / skipped | enum, rules in 3 places | unchanged | F-12 |
| 13 | Session focus | unfocused / focused(goal) + revision | 3 fields + persisted entry | unchanged | none |
| 14 | Drafting session | none / goal / sisyphus / tweak | WeakMap + session entries | unchanged | F-13 |
| 15 | Goal-tool profile | uninitialized / execution / drafting | 2 booleans | 1 union | F-06 fixed |
| 16 | Blocker Oracle advice | none / armed / consumed | process-global map + ledger | unchanged | F-14 |
| 17 | Stall detector | quiet / notified | 2 fields | unchanged | none |
| 18 | `agent_end` to `agent_settled` handshake | none / continue / network-recover | 2 closure variables + `runningGoalId` | unchanged | none |
| 19 | Widget, modal and overlay state | registered / modal depth / expanded / result card | 8 fields + 3 timers | unchanged | F-16 |
| 20 | Live-tail retention | per session tails | explicit reset rules | unchanged | none |
| 21 | Read caches (settings, ledger, pool, parse) | warm / invalidated | module `Map`s | unchanged | none |
| 22 | Ledger status projection | active / paused / complete / aborted / unknown | enum, lossy | unchanged | F-11 |
| 23 | Audit transcript queue | pending / flushed | array | unchanged | none |
| 24 | Session checkpoint recovery CLI | validate / backup / write / verify | linear function | unchanged | F-15 |

## 1. Goal lifecycle status

- `extensions/goal-record.ts:3` (`GoalStatus`), read-back at `goal-record.ts:339` (`normalizeGoalRecord`), `normalizeGoalStatus` at `goal-record.ts:346`.
- States: `active`, `paused`, `blocked`, `budget_limited`, `complete`. Side fields: `autoContinue`, `stopReason` (`user`|`agent`), `pauseReason`, `pauseSuggestedAction`.
- Lives in: the goal file `.pi/goals/active_goal_*.md` (JSON front matter), in memory in `goalsById`, archived file after completion.
- Transitions and their writers (every one goes through `GoalService.apply` or `flushTurn`):

| From | To | Writer |
|---|---|---|
| new | active | `replaceGoal` -> `GoalService.create` |
| active | paused | `pauseActiveGoal`/`stopActiveGoal` (user Esc, `/goal-pause`), `runGoalAgentPauseFlow` (agent), `GoalScheduler.pause` (allowance, budget, deadline) |
| active | blocked | `runGoalBlockedFlow` (`goal-core-tools.ts`) |
| active | budget_limited | `accountProgress` (`goal-state.ts`), tweak with a budget already reached |
| paused, blocked | active | `GoalScheduler.resumeResult` (`/goal-resume`, `update_goal(active)`), confirmed tweak |
| blocked | paused, budget_limited | confirmed tweak that cannot resume |
| budget_limited | active | confirmed tweak with a budget that is no longer reached |
| active, paused, budget_limited | complete | `commitGoalCompletion` (`goal-completion.ts`), archived at `turn_end` |
| any | paused (archive) | `archiveCurrentGoal` (`/goal-clear`, `/goal-abort`) |

- Readers: prompt builders (`goal-events.ts` `currentGoalContextParts`), widget, scheduler, policy gates (`goal-policy.ts`), pool filters (`complete` is excluded from the open pool).
- Invariants: `complete` is terminal; only `active` + `autoContinue` dispatches continuations; `paused`/`blocked`/`budget_limited`/`complete` clear continuation and accounting.
- Findings:
  - **F-01 (P2, fixed)** `normalizeGoalRecord` mapped every unrecognized status, including a typo, a hand edit or a value from a newer version, to `active`. A goal file with `"status": "failed"` therefore restarted autonomous runs on the next session start (`goal-record.ts` before: final `: "active"` branch). Now a missing status stays `active` (historical files), a recognized value is matched case-insensitively, and any other value becomes `paused`, the same fail-safe direction the scheduler validator already takes (`normalizeGoalScheduler` returns `interrupted` for corrupt data). Test: `tests/goal-record.test.ts` "normalizeGoalRecord does not turn an unrecognized persisted status into a running goal".
  - **F-08 (P3, catalogued)** About nine writers assign `status` inside `mutate` callbacks, so no single function owns the legal edges. No illegal edge is reachable today (pause requires `active`, completion gates on `isCompletableStatus`, resume throws on `complete`, tweak rejects `complete`), so a transition table would have no failing test to prove it.

## 2. Scheduler phase (persisted)

- `extensions/goal-scheduler-state.ts:19` (`GoalSchedulerState.phase`), driven by `extensions/goal-scheduler.ts`.
- States: `idle`, `ready`, `waiting`, `claimed`, `running`, `interrupted`; plus `decision` (`ready` with a purpose, or `wait`), `wait` (id, token, deadline, polling counters), `dispatch` (id, kind), `generation`, `used`, `repairUsed`, `owner`.
- Lives in: the goal file (`scheduler` field), mirrored in memory.
- Transitions:

```
idle --kickoff/recover/resume--> ready --claim()--> claimed --checkpoint message--> running
running --declare(ready|wait)--> ready | waiting        running --settled(non-strict)--> ready
waiting --wake signal / due check--> claimed             any --takeover/pause--> idle
restore on active goal: idle|claimed|running|interrupted --> ready (recovery)
normalize failure --> interrupted (used = MAX_SAFE_INTEGER)
```

- Invariants enforced by `normalizeGoalScheduler`: `claimed`/`running` need a `dispatch`; `ready` needs a `ready` decision; `waiting` needs a `wait` and a `wait` decision; counters are safe integers. Corrupt data cannot reset spent allowance.
- Finding F-09, see section 3.

## 3. Scheduler run flags (in memory)

- `extensions/goal-scheduler.ts:13-19`: `timer`, `inRun`, `armedGeneration`, `declared`, `runGoalId`, `denied`, plus `ctx`/`unsubscribe`.
- States actually used: idle; running; running with a saved decision (`declared`); settled with `declared` still readable by `settled()`; denied (a rejected checkpoint, sticky until the next `begin()`).
- Events: `begin` (agent_start), `turn`, `message`, `settled` (agent_settled), `restore`, `shutdown`, `takeover`, `resume`.
- Invariants: `armedGeneration` is consumed by exactly one `claim()`; `denied` blocks every tool call in `tool_call`; `settled()` never schedules when denied or when the focused goal changed during the run.
- **F-09 (P3, catalogued)** Phase edges are written in about fifteen places (`s.phase = ...`) and the run state is spread over five fields, so combinations such as `declared` outside a run are representable. The code is covered by `tests/goal-scheduler.test.ts` and `tests/e2e/goal-scheduler-sdk.test.ts` and no incorrect combination was found, so it was not refactored here; the safe follow-up is one `run: idle | running{goalId,declared} | denied` field read by `settled()`.

## 4. Continuation dispatch (`GoalRuntime`)

- `extensions/goal-runtime.ts:44-46`.
- States: none; scheduled (a timer will try to send a checkpoint for goal G); queued (checkpoint for G was handed to pi and not yet picked up by a turn).
- Transitions: `queueContinuation` (none -> scheduled), timer fires and the context is idle (scheduled -> queued via `sendFollowUp`), busy (scheduled -> scheduled, 50 ms or 1000 ms retry), goal no longer actionable or context gone (-> none), `clearContinuationState` / `cancelContinuationFor` (-> none), `before_agent_start` for a checkpoint turn (-> none, keeps network backoff).
- Readers: `continuationPendingFor`, scheduler `schedule()`.
- **F-07 (P3, fixed)** The goal id and the timer of the scheduled state were two nullable fields kept in step by hand (`continuationScheduledFor`, `continuationTimer`). They are now one `continuationScheduled: {goalId, timer} | null`, so "goal without timer" cannot be represented. Pure refactor, covered by the existing continuation tests.

## 5. Network-error backoff

- `extensions/goal-runtime.ts:47-49` (`networkErrorRetryGoalId`, `networkErrorRetryAttempt`, `networkErrorRetryTimer`) and `extensions/network-error-backoff.ts` (pure ladder 5 s ... 80 s, optional cap).
- States: idle; waiting for attempt n of goal G. Events: `agent_settled` with a network or aborted assistant error (schedule), timer fires (`recover`), successful turn / user turn / focus change / shutdown (clear). The attempt counter lives in memory only and survives checkpoint turns on purpose (`clearContinuationState(false)`).
- **F-10 (P3, catalogued)** `scheduleNetworkErrorRetry` returns `null` when a timer is already pending, and `agent_settled` (`goal-events.ts`, after `scheduleNetworkErrorRetry`) reports that as "network errors persisted after all recovery attempts". The pending-timer case is reachable when a scheduler checkpoint turn starts while the backoff timer is pending and also fails with a network error. Effect is a misleading notice, not lost work, because the pending timer still fires.

## 6. Turn-stop guard, checkpoint marker, one-time reminders

- `extensions/goal-runtime.ts:52-62`: `turnSeq`/`turnStoppedFor{goalId,turnSeq}`, `checkpointGoalId`, `checkpointSeq`, `postCompactReminderPending`, `postBudgetReminderPending`.
- A stop marker is valid only for the turn that set it (`advanceTurn` drops stale markers, `currentTurnStoppedGoalId` re-checks); reminders are consumed once. Explicit and correct; no findings.

## 7. Turn transaction buffer (`GoalService`)

- `extensions/goal-service.ts:158-172`: `turn{active,goalId,goal,archive,ledger}`, `turnBase`, `flushError`, `lastPersistedUsage`.
- States: closed; open and empty; open with buffered goal and ledger; open but flush failed (lock contention keeps the buffer for the next boundary); rejected (revision conflict discards the buffer and adopts disk).
- Events: `beginTurn` (turn_start), `apply`/`updateTask`/`persist`/`appendEvents` (buffer), `flushTurn` (audit, pause, focus change, reload, `turn_end`).
- Invariants: readers gate on `turn.active`; a flush writes under the per-goal lock with an optimistic revision check; a failed flush is surfaced through `flushForAudit`.
- **F-17 (P3, catalogued)** After a successful flush `turn.goal` and `turn.ledger` keep their values while `active` is false. Every reader checks `active` first, so it is invisible today; `beginTurn` resets them.

## 8. Per-goal lock and settings path lock

- `extensions/storage/goal-lock.ts:89` (`acquireGoalLock`), `extensions/goal-settings.ts:998` (`acquirePathLock`), stale detection duplicated in `extensions/goal-recovery.ts`.
- States: free; held by W; stale (older than 30 s or pid dead); recovered and re-held by W2.
- Transitions: `wx` create (free -> held), `EEXIST` then stat + pid check (held -> stale), unlink (stale -> free), `release` (held -> free).
- **F-02 (P2, fixed)** `release()` unlinked the lock path unconditionally. A writer that outlived the 30 s TTL (or whose pid check misfired) had its lock recovered by a second writer; when the first writer finished, its `release()` deleted the second writer's live lock, and a third writer entered the critical section while the second was still writing. The stale recovery had the same shape: it unlinked the path it had examined earlier, without checking that the file was still the one it judged stale. Both locks now write an owner token; `release()` removes the file only if it still holds that token, and recovery re-reads the file and skips the unlink if it changed. Residual: the read-compare-unlink window is narrowed, not closed, because Node has no compare-and-delete; the optimistic revision check in `GoalService` remains the real guard. Tests: `tests/goal-lock.test.ts`.

## 9. Completion audit

- Fields in `extensions/goal-state.ts` (`auditProgress`, `auditAnimationTimer`, `auditAbortController`, `auditResult`, `auditResultClearTimer`), driven by `extensions/goal-completion.ts` and the Escape handler in `extensions/goal-widget.ts` (`syncTerminalInputPause`).
- States: idle; running (progress + 80 ms spinner + abort controller); aborted by Escape (dialog: complete without audit / continue); done (result card for 6 s); rejected.
- `update_goal` is `executionMode: "sequential"`, so two audits cannot overlap through the tool.
- **F-03 (P2, fixed)** `commitGoalCompletion` mutated with `() => ({...opts.goal, status: "complete"})`, where `opts.goal` is the snapshot taken before the audit started. `accountProgress` had just charged the audit's elapsed seconds onto the live goal; the commit then replaced the live goal with the older snapshot, so a goal that took minutes to audit was archived without that time. The mutation now starts from the current goal and only takes the objective from the audited snapshot (it was merged from the goal file). Test: `tests/goal-completion.test.ts` "update_goal(complete) keeps the usage accrued while the auditor ran".
- **F-04 (P2, fixed)** If the auditor promise rejected, the 80 ms interval, the abort controller and `auditProgress` stayed set. A non-null `auditProgress` makes the Escape handler abort a phantom audit and consume the key, so Escape no longer paused the goal. The flow now clears all three before rethrowing. Test: `tests/goal-completion.test.ts` "update_goal(complete) leaves no audit running when the auditor rejects".
- **F-05 (P3, fixed)** `auditAborted` was written by `abortAudit` and reset by the completion flow but never read; removed. (The same cleanup removed `goalWorkToolCalledThisTurn`, written in two handlers and never read since the scheduler redesign.)
- **F-16 (P3, catalogued)** `session_shutdown` does not clear `auditResultClearTimer` (6 s, `unref`ed, invalidates a possibly gone widget through an optional chain) and the debug-only mock audit (`goal-widget.ts`, `debugMockAuditTimer` plus an untracked 3 s `setTimeout`) can outlive the debug toggle.

## 10. Token/time accounting

- `extensions/goal-accounting.ts:24` (`GoalAccounting`): `activeGoalId`, `lastAccountedAt`. States off / counting(goal); `begin`, `clear`, `charge` (idempotent: advances the baseline), `liveSeconds` (read only). Explicit and correct; `GoalService` keeps the matching persisted baseline for additive merges. No findings.

## 11. Budget thresholds and `budget_limited`

- `accountProgress` (`goal-state.ts`), `budgetWarningsFired: Set<"goalId:budget:threshold">` (warn once per 50/75/90 %), the `active -> budget_limited` transition through `goalService.apply`, and `postBudgetReminderPending`. Transition fires once because the status leaves `active`. No findings.

## 12. Task status and `currentTaskId`

- `extensions/goal-record.ts:10` (`TaskStatus`), rules in `goal-task-tools.ts` (`update_goal_task`, `progressSpec`), `goal-widget.ts` (`toggleTaskViaService`), `goal-service.ts:141` (`resolveUpdatedCurrentTaskId`).
- States: `pending`, `complete`, `skipped`; `currentTaskId` names the pending task in progress. Edges: pending -> complete (needs evidence if the task has a contract, and all subtasks resolved), pending -> skipped (reason required, skips subtasks), skipped -> pending, pending -> pending (start). Complete is immutable through the tools. Read-back accepts a `currentTaskId` only if it names a pending task.
- **F-12 (P3, catalogued)** The transition rules are written three times (single tool, batch spec, TUI toggle) with small differences. The TUI toggle may reopen a complete task (documented as a human correction) and does not check the parent, so reopening a child under a complete parent leaves a complete parent with a pending child. Only reachable through a deliberate user keypress.

## 13. Session focus

- `goal-state.ts:153-155` (`focusedGoalId`, `focusRevision`, `hasExplicitSessionFocus`), persisted as `pi-goal-focus` session entries, resolved by `resolveSessionFocus` (`goal-pool.ts`).
- Operation tokens `{goalId, revision}` make async work cancel if focus moved (`isFocusedOperationCurrent`); `loadState` bumps the revision. Explicit; the persisted entry is normalized (`normalizeGoalFocusEntry`). No findings.

## 14. Drafting session

- `goal-drafting.ts:51` (`activeDrafts` WeakMap), durable `pi-goal-draft` entries with a `clearedAt` tombstone, rehydrated by `rehydrateDraft`.
- States: none; draft of mode `goal`, `sisyphus` or `tweak(targetGoalId)`; confirmed/cancelled (tombstone). A stale tweak target is discarded on reload.
- **F-13 (P3, catalogued)** `propose_goal_draft` awaits the dialog and then acts on the draft captured before the await without checking `activeDraft(core)` is still that draft (a tweak does re-check revision and focus). The dialog is modal, so a cancel during it is unlikely from the UI; no failing sequence was reproduced. The persisted draft entry is cast without validating `mode`.

## 15. Goal-tool profile

- `goal-state.ts:309` `toolProfile`.
- **F-06 (P3, fixed)** `profileInitialized` and `draftingProfile` (two booleans, three meaningful states) are now `toolProfile: "uninitialized" | "execution" | "drafting"`. Focus changes re-install only the execution profile, exactly as before.

## 16. Blocker Oracle advice

- `goal-oracle.ts:302` `armedByGoalId` (process-global `Map`), plus ledger-derived state (`goalOracleState`: failed attempts, follow-up attempted, last result per blocker fingerprint).
- States per blocker: none; consulted (started); failed(n); advised (actionable / needs human / insufficient context); advice armed; follow-up attempted. The consult is blocked while an actionable advice has no follow-up.
- **F-14 (P3, catalogued)** The armed map is module-global and keyed by goal id; it is not cleared on session shutdown or when the goal is archived. Advice armed in one session can be consumed as the follow-up of another session in the same process. The ledger remains the source of truth for gating, so the effect is limited to the `oracle_followup_attempted` event and the reminder text.

## 17. Stall detector

- `goal-state.ts:616` `lastGoalActivityAt`, `stallNotified`: quiet -> notified once per idle period; `touchGoalActivity` resets both. No findings.

## 18. `agent_end` to `agent_settled` handshake

- `goal-events.ts:71-72` (`continuationAfterSettleFor`, `networkErrorRecoveryAfterSettleFor`), `core.runningGoalId`, scheduler `inRun`.
- `agent_end` decides (continue / network recover / nothing) and `agent_settled` acts after pi has finished retries and compaction; both variables are reset at each `agent_end`, `agent_settled` and shutdown. No findings.

## 19. Widget, modal and overlay state

- `goal-state.ts`: `widgetRegistered`, `lastUiCtx`, `uiFlushScheduled` (coalesced microtask render), `goalModalDepth`, `dashboardExpanded`, `terminalInputUnsubscribe`; `widgets/goal-widget.ts` scroll offsets; `widgets/task-list-overlay.ts:350` message-clear `setTimeout`.
- `goalModalDepth` is a counter guarded by `enter`/`exit` in `try/finally` at every call site, so a dialog that throws still releases it. The overlay message timer can call `requestRender` after the overlay closed (P3, covered by F-16). No other findings.

## 20. Live-tail retention

- `goal-live-retention.ts:120`. Per session: retained tails, last fresh blocks, base fingerprints. Explicit reset conditions (state change, history rewrite, unsafe anchor, overflow, tracked-session cap). No findings.

## 21. Read caches

- `goal-settings.ts:279`, `goal-ledger.ts:161,291`, `storage/goal-files.ts:35,54`. Warm until `invalidate*` at session start, tree navigation or `/goal-refresh`; the ledger checkpoint disk write is throttled and a stale checkpoint only costs a replay. No findings.

## 22. Ledger status projection

- `goal-ledger.ts:52` and `applyLedgerEvents` (`goal-ledger.ts:797`): `latestStatus` in `active | paused | complete | aborted | unknown`.
- **F-11 (P3, catalogued)** The projection ignores `goal_blocked` and `goal_budget_limited`, so a blocked or budget-limited goal projects as `active`. Its only consumer (`goal-compaction.ts:139`) reads the `complete`/`aborted` labels, so nothing wrong is shown today; the projection should not be reused for the status of open goals.

## 23. Audit transcript queue

- `goal-session-safety.ts:29` `GoalAuditMessages`: messages are queued during a run and flushed at `agent_settled` only when the context is idle; entries for another session are dropped. Explicit. No findings.

## 24. Session checkpoint recovery CLI

- `scripts/recover-session-checkpoints.mjs`: validate invariants, copy backup, write temp, fsync, rename, re-read and compare. Linear and fail-closed.
- **F-15 (P3, catalogued)** The file is read once, then backed up and replaced later; a concurrent writer between the two would be overwritten. The CLI refuses `--apply` without `--confirm-pi-closed`, which is the intended guard.

## Findings left catalogued only

F-08, F-09, F-10, F-11, F-12, F-13, F-14, F-15, F-16, F-17 are P3: each is a representable but unobserved bad state or a cosmetic effect, and each fix would touch behaviour that has no failing test today. F-09 (scheduler run flags) is the largest remaining candidate for a follow-up change.
