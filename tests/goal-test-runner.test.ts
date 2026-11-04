import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("runner isolates real goal budget fixtures from inherited delegated-session markers", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "goal-runner-"));
	try {
		cpSync(path.join(root, "extensions"), path.join(dir, "extensions"), { recursive: true });
		cpSync(path.join(root, "scripts"), path.join(dir, "scripts"), { recursive: true });
		cpSync(path.join(root, "tests", "stubs"), path.join(dir, "tests", "stubs"), { recursive: true });
		cpSync(path.join(root, "tests", "goal-budget.test.ts"), path.join(dir, "tests", "goal-budget.test.ts"));
		cpSync(path.join(root, "package.json"), path.join(dir, "package.json"));
		mkdirSync(path.join(dir, "tests", "integration"));
		mkdirSync(path.join(dir, "tests", "e2e"));
		symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
		const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "2" };
		delete env.NODE_TEST_CONTEXT;
		const result = spawnSync(process.execPath, ["scripts/run-unit-tests.mjs"], { cwd: dir, env, encoding: "utf8", timeout: 30000 });
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /pass 3/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runner rejects unknown suite arguments", () => {
	const result = spawnSync(process.execPath, [path.join(root, "scripts", "run-unit-tests.mjs"), "integraiton"], { cwd: root, encoding: "utf8", timeout: 30000 });
	assert.equal(result.error, undefined);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Invalid runner arguments/);
});
