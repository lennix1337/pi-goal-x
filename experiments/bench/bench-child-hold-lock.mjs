
import { acquireGoalLock } from "../../extensions/storage/goal-lock.ts";

const [cwd, goalId, holdMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw ?? 3000);
const lock = acquireGoalLock({ cwd }, goalId);
setTimeout(() => {
	lock.release();
	process.exit(0);
}, holdMs);
