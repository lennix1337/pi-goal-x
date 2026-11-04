import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cases = [
	["token-cap", "extensions/goal-accounting.ts", "remaining !== null && remaining === 0", "false", "computes remaining and reached", "goal-accounting-runtime"],
	["invalid-token-cap", "extensions/goal-accounting.ts", "goal.tokenBudget <= 0", "goal.tokenBudget < 0", "ignores non-positive budgets", "goal-accounting-runtime"],
	["stale-completion", "extensions/goal-policy.ts", "runningGoalId && goal.id !== runningGoalId", "false", "goal lifecycle completion gates", "goal-policy"],
	["completion-status", "extensions/goal-policy.ts", "if (!isCompletableStatus(goal.status))", "if (false)", "goal lifecycle completion gates", "goal-policy"],
	["blocked-status", "extensions/goal-policy.ts", "if (goal.status !== \"active\") {\n\t\treturn { ok: false, message: `Goal is ${statusLabel(goal)}; update_goal(blocked)", "if (false) {\n\t\treturn { ok: false, message: `Goal is ${statusLabel(goal)}; update_goal(blocked)", "update_goal\\(blocked\\) policy", "goal-policy"],
	["resume-complete", "extensions/goal-policy.ts", "if (goal.status === \"complete\") return { ok: false, message: \"Goal is complete.", "if (false) return { ok: false, message: \"Goal is complete.", "resume and clear policy", "goal-policy"],
];

for (const [name, file, before, after, pattern, testFile] of cases) {
	const dir = mkdtempSync(join(tmpdir(), "pi-goal-mutant-"));
	try {
		cpSync(join(root, "extensions"), join(dir, "extensions"), { recursive: true });
		cpSync(join(root, "tests"), join(dir, "tests"), { recursive: true });
		cpSync(join(root, "package.json"), join(dir, "package.json"));
		symlinkSync(resolve(root, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
		const path = join(dir, file);
		const source = readFileSync(path, "utf8");
		assert.equal(source.split(before).length, 2, `${name}: mutation must match exactly once`);
		writeFileSync(path, source.replace(before, after));
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", `--test-name-pattern=${pattern}`, `tests/${testFile}.test.ts`], { cwd: dir, encoding: "utf8", timeout: 30000 });
		assert.equal(result.error, undefined, `${name}: process must run without timing out`);
		assert.notEqual(result.status, 0, `${name}: survived`);
		assert.match(result.stdout + result.stderr, /AssertionError/, `${name}: must fail an assertion`);
		console.log(`${name}: killed by assertion`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
console.log(`${cases.length}/${cases.length} boundary mutants killed; disposable copies only`);
