import { goalStoragePath, ensureGoalStorageDirectory } from "./goal-root.ts";

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GoalFileContext } from "./goal-files.ts";

export const GOAL_LOCK_DIR = ".pi/goals/.locks";

export interface GoalLock {
	release(): void;
}

const DEFAULT_ACQUIRE_ATTEMPTS = 8;
const DEFAULT_RETRY_MS = 1;
const DEFAULT_STALE_TTL_MS = 30_000;

function safeLockName(goalId: string): string {
	return goalId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readLockPayload(lockPath: string): { pid?: number; startedAt?: string; token?: string } {
	try {
		const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
		return {
			pid: typeof raw.pid === "number" ? raw.pid : undefined,
			startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
			token: typeof raw.token === "string" ? raw.token : undefined,
		};
	} catch {
		// external: an interrupted lock-file creation can leave an incomplete payload.
		return {};
	}
}

function readLockText(lockPath: string): string | undefined {
	try {
		return fs.readFileSync(lockPath, "utf8");
	} catch {
		return undefined;
	}
}

function sleepMs(ms: number): void {
	const buffer = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buffer, 0, 0, ms);
}

/**
 * Acquire the exclusive per-goal lock. Throws after the bounded attempt window
 * if a live writer never releases it. The caller MUST release() the returned
 * lock (use a finally block).
 */
export function acquireGoalLock(
	ctx: GoalFileContext,
	goalId: string,
	opts: { attempts?: number; retryMs?: number; staleTtlMs?: number } = {},
): GoalLock {
	const attempts = opts.attempts ?? DEFAULT_ACQUIRE_ATTEMPTS;
	const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
	const ttlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
	const lockDir = goalStoragePath(ctx, GOAL_LOCK_DIR);
	const lockPath = path.join(lockDir, `${safeLockName(goalId)}.lock`);
	ensureGoalStorageDirectory(ctx, GOAL_LOCK_DIR, false);
	// external: another process may reacquire a recovered lock path.
	const token = randomUUID();
	const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token });

	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			fs.writeFileSync(lockPath, payload, { flag: "wx" });
			let released = false;
			return {
				release(): void {
					if (released) return;
					released = true;
					if (readLockPayload(lockPath).token !== token) return;
					try {
						fs.unlinkSync(lockPath);
					} catch {
					}
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				const stat = fs.statSync(lockPath);
				const observedText = readLockText(lockPath);
				const payloadInfo = readLockPayload(lockPath);
				const pid = payloadInfo.pid;
				const stale = Date.now() - stat.mtimeMs > ttlMs || (pid !== undefined && !pidAlive(pid));
				if (stale) {
					// external: another process may recover and reacquire the lock after it was inspected.
					if (readLockText(lockPath) !== observedText) continue;
					try {
						fs.unlinkSync(lockPath);
					} catch {
					}
					continue;
				}
			} catch {
				continue;
			}
			sleepMs(retryMs);
		}
	}
	throw new Error(`Timed out acquiring the goal lock for ${goalId} (${attempts} attempts). Another writer may hold it.`);
}
