
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { campaignConfig } from "./campaigns.mjs";

const WRITE_FLOOR_EXEMPT = new Set([
	"B1.lock.uncontended",
	"B1.append.single",
	"B2.mutationturn.task",
	"B5.auditor.dispatch",
	"B7.tool.create_goal",
	"B7.tool.update_goal.paused",
	"B7.tool.update_goal.blocked",
	"B7.tool.set_goal_tasks.50",
	"B7.tool.update_goal_task",
]);

// external: fixed agent guidance limits how much prompt size can shrink.
const CONTENT_FLOOR_EXEMPT_PREFIX = "B4.";

// external: a cold file read requires at least one I/O operation.
const READ_FLOOR_EXEMPT = new Set([
	"B1.settings.cold",
	"B1.settings.cold.lat25",
	"B1.ledger.cold",
	"B1.ledger.cold.lat25",
]);
const WRITE_FLOOR_RATIONALE = {
	"B1.lock.uncontended": "lockfile create+remove is mandatory (cross-process safety); floor ~2 ops, 0 impossible; 0.1ms wall-clock is noise",
	"B1.append.single": "one durable ledger append requires a direct write (1-op floor); 0 impossible; 0.1ms wall-clock is noise",
	"B2.mutationturn.task": "one task mutation = lockfile + goal-file + ledger, 3 durable files; with read-caches + single transaction ~5-6 ops is the floor (24 today); ≤2 would drop atomicity or the cross-process lock",
	"B5.auditor.dispatch": "one completion = lockfile + goal-file (complete) + batched ledger events; ~7-op floor ≈ 0.6-0.8ms cold per session (completion happens once per goal); 1.7ms today → ~0.8ms achieved via batching, ≤0.2ms would drop durability",
	"B7.tool.create_goal": "create = two durable files (goal file + shared ledger); 4-op floor (12 today); 0.6ms wall-clock",
	"B7.tool.update_goal.paused": "pause = lockfile + goal file + ledger (3 files); ~5-op floor (20 today); 0.7ms wall-clock",
	"B7.tool.update_goal.blocked": "blocked = lockfile + goal file + ledger (3 files); ~5-op floor (20 today); 0.7ms wall-clock",
	"B7.tool.set_goal_tasks.50": "task-list set = lockfile + goal file + ledger (3 files); ~5-op floor (20 today); 0.8ms wall-clock",
	"B7.tool.update_goal_task": "task mutation = lockfile + goal file + ledger (3 files); ~5-op floor (24 today); 0.7ms wall-clock",
};

export function classify(row) {
	if (WRITE_FLOOR_EXEMPT.has(row.id)) return { cls: "exempt", metric: "durable-write floor" };
	if (READ_FLOOR_EXEMPT.has(row.id)) return { cls: "exempt", metric: "read floor" };
	if (row.id.startsWith(CONTENT_FLOOR_EXEMPT_PREFIX)) return { cls: "exempt", metric: "content floor" };
	if (row.id.startsWith("B2.")) return { cls: "headroom", metric: "fs ops" };
	const p50 = typeof row.p50 === "number" ? row.p50 : NaN;
	const ops = typeof row.ops === "number" ? row.ops : 0;
	if (Number.isFinite(p50) && p50 < 0.5 && ops <= 1) return { cls: "exempt", metric: "noise floor" };
	if (ops > 1) return { cls: "headroom", metric: "fs ops" };
	return { cls: "headroom", metric: "p50 ms" };
}

export function targetFor(row) {
	const { cls, metric } = classify(row);
	if (cls === "exempt") return null;
	if (metric === "p50 ms") return { metric, limit: roundTarget(row.p50 / 10) };
	if (metric === "fs ops" || metric === "tokens") {
		const ops = typeof row.ops === "number" ? row.ops : 0;
		return { metric, limit: Math.max(0, Math.floor(ops / 10)) };
	}
	return null;
}

function roundTarget(v) {
	return Math.round(v * 10) / 10;
}

/** Annotate baseline rows with classification + target (pure; no I/O). */
export function classifyRows(baseline) {
	return baseline.rows.map((r) => ({ ...r, ...classify(r), target: targetFor(r) }));
}

/** Render the HEADROOM.md document for a campaign's classified rows (pure). */
export function renderHeadroomMarkdown(campaign, cfg, rows) {
	const headroom = rows.filter((r) => r.cls === "headroom");
	const exemptNoise = rows.filter((r) => r.metric === "noise floor");
	const exemptWrite = rows.filter((r) => r.metric === "durable-write floor");
	const exemptRead = rows.filter((r) => r.metric === "read floor");
	const exemptContent = rows.filter((r) => r.metric === "content floor");
	return [
		`# Non-agent flow headroom / exemption list — campaign \`${campaign}\``,
		``,
		`Generated ${new Date().toISOString()} from \`${cfg.jsonPrefix}before.json\` (${rows.length} rows).`,
		`Rule: EXEMPT = wall-clock row with p50 < 0.5ms and ≤ 1 fs op (measurement-noise-bound; must not regress), plus the documented`,
		`durable-write-floor rows (see below). HEADROOM rows must show ≥10x on their primary metric: fs ops (any row with > 1 fs op —`,
		`the I/O-bound flow's real cost driver), p50 ms (pure-CPU / single-read wall-clock rows), or estimated tokens (B4 prompt-bound flows).`,
		``,
		`## Headroom — ${headroom.length} rows (≥10x target on primary metric)`,
		``,
		`| id | primary metric | before | 10x target |`,
		`|---|---|---|---|`,
		...headroom.map((r) => `| ${r.id} | ${r.metric} | ${r.metric === "p50 ms" ? `${r.p50}ms` : r.ops ?? "-"} | ${r.metric === "p50 ms" ? `${r.target.limit.toFixed(1)}ms` : `≤${r.target.limit}`} |`),
		``,
		`## Exempt — noise floor (no-regression only) — ${exemptNoise.length} rows`,
		``,
		`| id | p50 ms | ops |`,
		`|---|---|---|`,
		...exemptNoise.map((r) => `| ${r.id} | ${r.p50} | ${r.ops ?? "-"} |`),
		``,
		`## Exempt — durable-write floor (no-regression only, documented rationale) — ${exemptWrite.length} rows`,
		``,
		`| id | p50 ms | ops | rationale |`,
		`|---|---|---|---|`,
		...exemptWrite.map((r) => `| ${r.id} | ${r.p50} | ${r.ops ?? "-"} | ${WRITE_FLOOR_RATIONALE[r.id] ?? ""} |`),
		``,
		`## Exempt — read floor (cold single-read rows; one mandatory read op, no-regression only) — ${exemptRead.length} rows`,
		``,
		`| id | p50 ms | ops | rationale |`,
		`|---|---|---|---|`,
		...exemptRead.map((r) => `| ${r.id} | ${r.p50} | ${r.ops ?? "-"} | a cold settings/ledger load must read the file at least once — the redundant stat was already removed (2→1 op), ≤0 ops is impossible; at 25ms/op the wall-clock floor is that single op's latency (25ms). Metric still watched (no-regression). |`),
		``,
		`## Exempt — content floor (no-regression only; 10x unreachable without behavior change — see rationale) — ${exemptContent.length} rows`,
		``,
		`| id | p50 ms | tokens | rationale |`,
		`|---|---|---|---|`,
		...exemptContent.map((r) => `| ${r.id} | ${r.p50} | ${r.ops ?? "-"} | continuationPrompt is ${r.ops} tokens → 10x target ≤${Math.floor(r.ops / 10)}; measured content floor with a zero-task goal is ~596 tokens (fixed agent guidance + objective + contract + status) — target unreachable without removing ~560 tokens of agent-facing lifecycle/audit/blocker guidance, which is a behavior change the goal forbids. taskListBlock/goalPrompt similarly bounded by the per-task status/contract text the agent must see. Metric still watched (no-regression). |`),
		``,
	].join("\n");
}

const benchDir = fileURLToPath(new URL(".", import.meta.url));
const campaign = process.argv[2] ?? "naf";
const mdArgIndex = process.argv.indexOf("--md");
const mdPath = mdArgIndex >= 0 ? process.argv[mdArgIndex + 1] : null;
if (import.meta.url === `file://${process.argv[1]}`) {
	const cfg = campaignConfig(campaign);
	const baseline = JSON.parse(readFileSync(path.join(benchDir, `${cfg.jsonPrefix}before.json`), "utf8"));
	const rows = classifyRows(baseline);
	const markdown = renderHeadroomMarkdown(campaign, cfg, rows);
	if (mdPath) {
		writeFileSync(mdPath, markdown + "\n");
		console.log(`[classify] wrote ${mdPath} (${rows.filter((r) => r.cls === "headroom").length} headroom / ${rows.filter((r) => r.cls === "exempt").length} exempt)`);
	} else {
		process.stdout.write(markdown + "\n");
	}
}
