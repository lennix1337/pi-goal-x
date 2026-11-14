import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

function runner(dir: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) {
	const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
	delete env.NODE_TEST_CONTEXT;
	return spawnSync(process.execPath, ["scripts/run-unit-tests.mjs", ...args], { cwd: dir, env, encoding: "utf8", timeout: 30000 });
}

/** A disposable project: the real runner, one real test file, and a manifest that lists exactly that file. */
function inDisposableProject(body: (dir: string) => void): void {
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
		const pinned = runner(dir, ["--write-manifest"]);
		assert.equal(pinned.status, 0, pinned.stdout + pinned.stderr);
		body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function addUnlistedTest(dir: string): void {
	writeFileSync(path.join(dir, "tests", "unlisted.test.ts"), 'import test from "node:test";\ntest("unlisted test executed", () => {});\n');
}

test("runner isolates real goal budget fixtures from inherited delegated-session markers", () => {
	inDisposableProject((dir) => {
		const result = runner(dir, [], { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "2" });
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /pass 3/);
	});
});

test("runner rejects unknown suite arguments", () => {
	const result = spawnSync(process.execPath, [path.join(root, "scripts", "run-unit-tests.mjs"), "integraiton"], { cwd: root, encoding: "utf8", timeout: 30000 });
	assert.equal(result.error, undefined);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Invalid runner arguments/);
});

test("runner stops before executing when a test file is not in the manifest", () => {
	inDisposableProject((dir) => {
		addUnlistedTest(dir);
		const result = runner(dir);
		assert.equal(result.error, undefined);
		assert.notEqual(result.status, 0, "the unlisted test file was accepted:\n" + result.stdout);
		assert.match(result.stderr, /unexpected unit entry: \.tests\/unlisted\.test\.ts/);
		assert.match(result.stderr, /node scripts\/run-unit-tests\.mjs --write-manifest/);
		assert.doesNotMatch(result.stdout, /unlisted test executed|\bpass \d/, "tests ran before the manifest matched");
	});
});

test("runner stops when a listed test file was renamed or the manifest is missing", () => {
	inDisposableProject((dir) => {
		renameSync(path.join(dir, "tests", "goal-budget.test.ts"), path.join(dir, "tests", "renamed.test.ts"));
		const renamed = runner(dir);
		assert.notEqual(renamed.status, 0, "the renamed test file was accepted:\n" + renamed.stdout);
		assert.match(renamed.stderr, /missing unit entry: \.tests\/goal-budget\.test\.ts/);
		assert.match(renamed.stderr, /unexpected unit entry: \.tests\/renamed\.test\.ts/);

		rmSync(path.join(dir, "tests", ".test-manifest.json"));
		const unpinned = runner(dir);
		assert.notEqual(unpinned.status, 0, "a project without a manifest was accepted:\n" + unpinned.stdout);
		assert.match(unpinned.stderr, /Missing .*\.test-manifest\.json.*--write-manifest/);
		assert.doesNotMatch(unpinned.stdout, /\bpass \d/, "tests ran without a manifest");
	});
});
