# Implementation and evidence

## 2026-11-02 cope-cache audit

Rule applied: a cache is cope when it re-validates or re-derives local data that a better data flow would not derive at all. A memo is kept when its validation costs less than the derivation it avoids. Owner write-through, append-only incremental reads, and compute-at-write are the better flows.

### Inventory (`extensions/`)

| Cache | Verdict | Why |
|---|---|---|
| `goal-task-index.ts` content-compared `TaskIndex` cache (32 entries, 2 MB) + snapshot copy | cope, removed | Validation (deep field compare) cost more than the walk it avoided; the copy doubled the miss path. |
| `widgets/goal-dashboard-model.ts` presentation memo (WeakMap keyed by index identity) | cope, removed | Its key existed only because the index was cached. |
| `prompts/goal-prompts.ts` fragment memo (32 entries, 2 MB retained text; key included index identity) | cope, removed | Build is deterministic and now cheaper than the key. |
| `goal-detail.ts` tasks-section memo (key: index identity) | cope, removed | Identity key could not match once the index is uncached. Objective and history memos kept. |
| `goal-detail.ts` objective memo (content key) and history memo (ledger generation) | legit, kept | Key is cheaper than the render; history generation changes on every append. |
| `goal-ledger.ts` `ledgerCache` (zero-op full events; extended on in-process append) | legit, kept | Owner write-through; cold read once per session/command. Staleness for other-process appends is documented (`/goal-refresh`). |
| `goal-ledger.ts` checkpoint (in-memory mirror + `.goal-ledger-checkpoint.json`, throttled) | legit, kept | Persisted fold with `coveredBytes` offset: incremental tail read, compute at write. |
| `goal-ledger-index.ts` runtime index, `goal-activity.ts` `indexedActivity` marker | legit, kept | Owner maintained per event; marker lets reader skip re-sort. |
| `goal-settings.ts` `settingsFileCache`, `resolvedSettingsCache` | legit, kept | Single owner invalidated on write, session start and `/goal-refresh`. |
| `storage/goal-files.ts` parse cache (path, mtime, size), dir listing cache (dir mtime) | legit, kept | Cross-process data; stat revalidation is the only cheap truth. |
| `storage/goal-files.ts` zero-op pool cache (invalidated per write) | mild cope, deferred | Re-read after a write costs 25–49 µs of a ~1 ms write+read; write-through would risk divergence from the normalized disk record. |
| `storage/goal-files.ts` persisted pool snapshot | compute-at-write, kept | Cold read 25–71 µs versus 0.5–2.1 ms full scan. Admitted staleness on in-place edits is pre-existing. |
| `widgets/text-cache.ts`, `goal-questionnaire.ts` `cachedLines` | legit, kept | TUI render memos for pure transforms; invalidated by state change. |
| `goal-events.ts` per-turn `promptLedger ??=` | legit, kept | Per-turn local memo. |
| `goal-prompt-cache.ts`, `goal-live-retention.ts` | out of scope | Provider prompt caching. |

### Measurement

Harness: `C:/projetos/local-validation/performance/no-cope-cache/bench.mjs` (outside the repo). Synthetic data only. Baseline is `origin/main` 103d9b4 extracted to a separate directory. Two paired runs were taken in opposite order (pair A: base then after; pair B: after then base). The host is noisy: untouched ledger, pool and settings paths swung 0.3–2.1× between pairs, so only effects that agree in both pairs are claimed.

| Path | Before | After | Ratio A / B |
|---|---|---|---|
| taskIndex hit, 150 tasks | 30.4 µs | 3.9 µs | 7.9× / 2.7× |
| taskIndex hit, 1500 tasks | 301 µs | 52 µs | 5.8× / 2.9× |
| goalPromptParts, repeated (50 tasks) | 8.9 µs | 3.5 µs | 2.6× / 1.6× |
| goalPromptParts, objective changes each call | 21.8 µs | 4.1 µs | 5.3× / 3.5× |
| dashboard, task title changes each call | 23.6 µs | 4.8 µs | 4.9× / 2.6× |
| dashboard, same goal repeated | 8.8 µs | 5.0 µs | 1.8× / 0.9× (inconclusive) |
| tasks page, single task, 150 tasks | 24.6 µs | 5.9 µs | 4.2× / 1.7× |
| tasks page, single task, 1500 tasks | 251 µs | 41 µs | 6.1× / 2.4× |
| tasks page, full section repeated, 150 tasks | 25.2 µs | 47.8 µs | **0.5× / 0.2× (slower)** |
| tasks page, full section repeated, 1500 tasks | 245 µs | 481 µs | **0.5× / 0.2× (slower)** |

Trade-off: repeated full task-section reads are 2–5× slower because the rendered section is no longer memoized. They are on-demand tool reads (`get_goal section=tasks`), not on the prompt or render path. A content-compared memo would reintroduce the cope pattern. The real fix is an owner of the rendered section updated on each task write; not done here.

### Tests

- `npm test`: 1143 pass / 0 fail (baseline 1142 / 0). New: task-section paging regression (in-place edit shows on the next page, stale cursor rejected, prompt rebuild repeats exactly).
- Updated for the new contract: `goal-comprehensive-optimization` test that asserted index identity (now deep equality); `goal-optimization` presentation test (now per-read rows; old index no longer retains an alias).
- `npm run check`: pass. ESLint on touched files: clean.
- Pre-existing, not introduced here: `npm run test:selfcheck` fails on `origin/main` 103d9b4 (e2e manifest drift: `goal-scheduler-sdk`, `goal-session-safety`, `network-recovery-rpc`).

### Not done (leftovers)

- Zero-op pool cache write-through and removal of the persisted pool snapshot: deferred, see the inventory.
- Rendered task-section owner (see trade-off).
- Other-process ledger appends remain invisible until `/goal-refresh` (pre-existing, documented).
