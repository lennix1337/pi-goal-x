
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoViolations, state } from "./guard-state.mjs";
import { Baseline } from "./bench-common.mjs";
import { campaignConfig } from "./campaigns.mjs";
import { run as runB1 } from "./b1-io.mjs";
import { run as runB3 } from "./b3-ledger-scale.mjs";
import { run as runB2 } from "./b2-turn-accounting.mjs";
import { run as runB4 } from "./b4-prompt-size.mjs";
import { run as runB5 } from "./b5-startup-contention-auditor.mjs";
import { run as runB5b } from "./b5b-cold-start.mjs";
import { run as runB7 } from "./b7-feature-matrix.mjs";
import { run as runB10 } from "./b10-checkpoint-growth.mjs";

const benchDir = fileURLToPath(new URL(".", import.meta.url));
const phase = process.argv[2] ?? "before";
const campaign = process.argv[3] ?? "extension-review-plan";
const cfg = campaignConfig(campaign);
const specDir = path.join(benchDir, "..", "..", "specs", cfg.specDir);
if (!["before", "after"].includes(phase)) {
	console.error("usage: run-bench.mjs <before|after>");
	process.exit(2);
}

const baseline = new Baseline();
const started = Date.now();

console.log(`[bench] phase=${phase} campaign=${campaign} — agent-free run (B8) over real extension functions`);
await runB1(baseline);
console.log(`[bench] B1 io micro-bench done (${baseline.rows.length} rows)`);
await runB3(baseline);
console.log(`[bench] B3 ledger scale done (${baseline.rows.length} rows)`);
await runB2(baseline);
console.log(`[bench] B2 turn accounting done (${baseline.rows.length} rows)`);
await runB4(baseline);
console.log(`[bench] B4 prompt size done (${baseline.rows.length} rows)`);
await runB5(baseline);
console.log(`[bench] B5 startup/contention/auditor done (${baseline.rows.length} rows)`);
if (campaign === "naf") {
	await runB5b(baseline);
	console.log(`[bench] B5b cold-start done (${baseline.rows.length} rows)`);
}
await runB7(baseline);
console.log(`[bench] B7 feature matrix done (${baseline.rows.length} rows)`);
await runB10(baseline);
console.log(`[bench] B10 checkpoint growth done (${baseline.rows.length} rows)`);

assertNoViolations();
console.log(`[bench] B8 ok: 0 agent/network/spawn violations, ${state.fsOpCount} fs ops counted in total`);

const jsonPath = path.join(benchDir, `${cfg.jsonPrefix}${phase}.json`);
const mdPath = path.join(specDir, `BENCH-${phase.toUpperCase()}.md`);
mkdirSync(specDir, { recursive: true });
writeFileSync(jsonPath, baseline.json());
writeFileSync(mdPath, `# Benchmark baseline — ${phase}\n\nGenerated ${new Date().toISOString()} · agent-free (B8) · local machine numbers (p50/p95/max, ms unless noted).\n\nFixture sizes and storage classes are per row. The next run re-emits this file as \`BENCH-AFTER.md\` and the B6 gate diffs the two.\n\n${baseline.markdown()}`);
console.log(`[bench] wrote ${jsonPath}`);
console.log(`[bench] wrote ${mdPath}`);
console.log(`[bench] total ${baseline.rows.length} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
