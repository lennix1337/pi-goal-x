# AGENTS.md

Spec directories live under `specs` unless a nested AGENTS.md documents a more specific convention.
Spec directory names use `YYYY-MM-DD-kebab-feature`, for example `2026-05-13-drafting-runtime-simplification`.
Spec directories include `PRODUCT.md`, when implementation planning is useful `TECH.md`, and a free-form `MILESTONES.md` implementation log.
`MILESTONES.md` records meaningful implementation milestones, failed attempts, setbacks, fixes, validation notes, and decisions without a strict schema.
When a user steers behavior mid-workflow, update `PRODUCT.md` first when behavior changes, then `TECH.md`, then implementation, tests, and `MILESTONES.md` as needed.

## README scope

Keep `README.md` as the existing user overview through Settings, followed by License. Do not append feature explanations, release notes, compatibility/version notices, troubleshooting, implementation details, validation results, or links advertising additional documentation unless the user explicitly requests that README change. A code change does not by itself authorize expanding the README.

Make only necessary factual corrections within existing sections; keep them brief and preserve the layout and examples. Put detailed usage and troubleshooting in `docs/`, release changes in `CHANGELOG.md`, and implementation/validation notes in the relevant spec. Preserve automated ranking badge updates.

## Checks

`npm run verify` (TypeScript 7 `check` + `test:unit` + `context:gate`) is the single validation command; `npm run mutations` (CI runs it too) removes each guard in a disposable copy and requires a test to fail. Tests stay independent of the agent session and the wall clock.

Every test run first compares the discovered test files with `tests/.test-manifest.json` and executes nothing when they differ: after adding, moving or deleting a test file, run `node scripts/run-unit-tests.mjs --write-manifest` and commit the manifest. `context:gate` compares the request the model receives with `experiments/context/baseline-main.json`; it works in its own temporary directory and ignores delegated-session markers and saved global goal settings, so parallel worktrees and any session get the same verdict.

## Fork budget flow

For conversational goal-budget changes and their tests, see `skills/goal-budgets/SKILL.md`.
