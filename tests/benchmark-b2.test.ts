import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("B2 mutation p50 uses independent samples and reports the first and range", () => {
	const env = { ...process.env };
	delete env.PI_SUBAGENT_CHILD;
	delete env.PI_SUBAGENT_DEPTH;
	const script = `import {run} from './experiments/bench/b2-turn-accounting.mjs'; import {Baseline} from './experiments/bench/bench-common.mjs'; const b = new Baseline(); await run(b); console.log(JSON.stringify(b.rows.find(r => r.id === 'B2.mutationturn.task')));`;
	const result = spawnSync(process.execPath, ["--import", "./experiments/bench/bench-adapter-hooks.mjs", "--experimental-strip-types", "--input-type=module", "-e", script], { cwd: root, env, encoding: "utf8", timeout: 30000 });
	assert.equal(result.status, 0, result.stderr);
	const row = JSON.parse(result.stdout);
	assert.equal(row.n, 20);
	assert.match(row.notes, /first .*ms; range .*–.*ms/);
	assert.ok(row.min <= row.p50 && row.p50 <= row.max);
});
