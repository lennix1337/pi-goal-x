import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { acquirePathLock } from "../extensions/goal-settings.ts";
import { GOAL_LOCK_DIR, acquireGoalLock } from "../extensions/storage/goal-lock.ts";

function withCwd(run: (cwd: string) => void): void {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-lock-"));
	try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// Machine: per-goal lock free -> held -> (released | stolen as stale). docs/state-machines.md, "Per-goal file lock".
test("a holder whose lock was recovered as stale cannot release the new holder's lock", () => {
	withCwd((cwd) => {
		const ctx = { cwd };
		const first = acquireGoalLock(ctx, "g1");
		// A second writer judges the first lock stale (TTL exceeded) and takes over.
		const second = acquireGoalLock(ctx, "g1", { staleTtlMs: -1, attempts: 2, retryMs: 1 });
		// The first holder finally finishes: its release must not delete the lock it no longer owns.
		first.release();
		assert.throws(() => acquireGoalLock(ctx, "g1", { attempts: 2, retryMs: 1 }), /Timed out acquiring the goal lock/);
		second.release();
		const third = acquireGoalLock(ctx, "g1", { attempts: 2, retryMs: 1 });
		third.release();
	});
});

test("release is idempotent and removes the lock it owns", () => {
	withCwd((cwd) => {
		const lock = acquireGoalLock({ cwd }, "g2");
		lock.release();
		lock.release();
		assert.deepEqual(readdirSync(path.join(cwd, GOAL_LOCK_DIR)).filter((name) => name.endsWith(".lock")), []);
	});
});

test("a dead-pid lock without an owner token is still recovered", () => {
	withCwd((cwd) => {
		const lockDir = path.join(cwd, GOAL_LOCK_DIR);
		mkdirSync(lockDir, { recursive: true });
		const lockPath = path.join(lockDir, "g3.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: 99999999, startedAt: "2020-01-01T00:00:00.000Z" }), "utf8");
		const lock = acquireGoalLock({ cwd }, "g3", { attempts: 3, retryMs: 1 });
		lock.release();
		assert.equal(existsSync(lockPath), false);
	});
});

// Machine: settings-file lock, same free -> held -> (released | stolen as stale) lifecycle.
test("a settings-lock holder whose lock was recovered as stale cannot release the new holder's lock", () => {
	withCwd((cwd) => {
		const lockPath = path.join(cwd, "settings.json.lock");
		const first = acquirePathLock(lockPath);
		const second = acquirePathLock(lockPath, { staleTtlMs: -1, attempts: 2, retryMs: 1 });
		first.release();
		assert.throws(() => acquirePathLock(lockPath, { attempts: 2, retryMs: 1 }), /Timed out acquiring the settings lock/);
		second.release();
		acquirePathLock(lockPath, { attempts: 2, retryMs: 1 }).release();
	});
});
