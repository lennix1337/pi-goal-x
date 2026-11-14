/**
 * `npm run verify` runs the context gate, so its verdict must depend only on
 * the checked-out code: not on another gate running at the same time, nor on
 * the session or machine that starts it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

interface NodeRun { status: number | null; stdout: string; stderr: string }

/** Runs `node <args>` in the project without throwing, so several can run at once and the caller asserts on each outcome. */
function runNode(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<NodeRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", ...args], { cwd: root, env, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

/** Captures one fixture and prints where it worked and the size breakdown the gate compares with the baseline. */
const CAPTURE_ONE = [
	'const { captureOne, CAPTURE_CWD } = await import("./experiments/context/capture-context.mjs");',
	'const { measureContext } = await import("./experiments/context/measure-context.mjs");',
	'console.log(JSON.stringify({ captureDir: CAPTURE_CWD, breakdown: measureContext(await captureOne("active-regular-no-tasks")) }));',
].join("\n");

test("two simultaneous gates pass, each in its own capture directory", async () => {
	const gate = path.join("experiments", "context", "run-gate.mjs");
	const runs = await Promise.all([runNode([gate]), runNode([gate])]);
	const captureDirs = runs.map((run) => {
		assert.equal(run.status, 0, run.stdout + run.stderr);
		assert.match(run.stdout, /\[context:gate\] PASS/);
		const captureDir = /capture directory \(removed on exit\): (.+)/.exec(run.stdout)?.[1]?.trim();
		assert.ok(captureDir, "the gate did not report its capture directory:\n" + run.stdout);
		assert.equal(existsSync(captureDir), false, `${captureDir} outlived its gate`);
		return captureDir;
	});
	assert.notEqual(captureDirs[0], captureDirs[1]);
});

test("a capture does not depend on the session, the machine or another capture running at the same time", async () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "goal-gate-agent-"));
	try {
		// Saved global goal defaults change the request the model sees.
		writeFileSync(path.join(agentDir, "pi-goal-x-settings.json"), JSON.stringify({ maxAutonomousRuns: 7 }));
		const plain: NodeJS.ProcessEnv = { ...process.env };
		for (const name of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_DEPTH", "PI_GOAL_GLOBAL_SETTINGS_FILE", "PI_CODING_AGENT_DIR"]) delete plain[name];
		const script = ["--input-type=module", "--eval", CAPTURE_ONE];
		const [reference, delegated, configured] = await Promise.all([
			runNode(script, { ...plain, PI_CODING_AGENT_DIR: path.join(agentDir, "absent") }),
			runNode(script, { ...plain, PI_CODING_AGENT_DIR: path.join(agentDir, "absent"), PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "2" }),
			runNode(script, { ...plain, PI_CODING_AGENT_DIR: agentDir }),
		]);
		const captured = (run: NodeRun, session: string) => {
			assert.equal(run.status, 0, `capture failed ${session}:\n${run.stdout}${run.stderr}`);
			return JSON.parse(run.stdout) as { captureDir?: string; breakdown: Record<string, number> };
		};
		const captures = [captured(reference, "in a plain session"), captured(delegated, "inside a delegated session"), captured(configured, "with saved global goal defaults")] as const;
		assert.deepEqual(captures[1].breakdown, captures[0].breakdown, "a delegated session changed the capture");
		assert.deepEqual(captures[2].breakdown, captures[0].breakdown, "saved global goal defaults changed the capture");
		assert.equal(new Set(captures.map((capture) => capture.captureDir)).size, captures.length, "simultaneous captures shared a directory");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
