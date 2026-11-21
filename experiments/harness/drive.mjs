#!/usr/bin/env node
// external: pi -p exits before queued continuation turns finish.

import { readFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

const [, , caseDirArg, runDirArg] = process.argv;
if (!caseDirArg || !runDirArg) {
	console.error("usage: drive.mjs <case-dir> <run-dir>");
	process.exit(2);
}

const caseDir = resolve(caseDirArg);
const runDir = resolve(runDirArg);
const sandboxDir = join(runDir, "sandbox");
const sessionDir = join(runDir, "sessions");
mkdirSync(sandboxDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

try {
	const envPath = join(caseDir, "env.json");
	const raw = readFileSync(envPath, "utf8");
	const parsed = JSON.parse(raw);
	if (parsed && typeof parsed === "object") {
		for (const [k, v] of Object.entries(parsed)) {
			process.env[k] = String(v);
		}
		console.error(`[drive] case env applied: ${JSON.stringify(parsed)}`);
	}
} catch {
}

const extPath = process.env.PI_GOAL_TEST_EXTENSION;
const provider = process.env.PI_GOAL_TEST_PROVIDER || "openrouter";
const modelId = process.env.PI_GOAL_TEST_MODEL || "moonshotai/kimi-k2.6";
const thinking = process.env.PI_GOAL_TEST_THINKING || "high";
const turnTimeoutMs = Number(process.env.PI_GOAL_TEST_TURN_TIMEOUT || "180") * 1000;
if (!extPath) {
	console.error("PI_GOAL_TEST_EXTENSION env is required");
	process.exit(2);
}

const inputPath = join(caseDir, "INPUT.md");
const inputText = readFileSync(inputPath, "utf8");
const turns = [];
for (const line of inputText.split(/\r?\n/)) {
	if (line.startsWith("TURN: ")) {
		turns.push({ kind: "turn", text: line.slice("TURN: ".length) });
	} else if (/^SLEEP:\s*(\d+)/.test(line)) {
		turns.push({ kind: "sleep", ms: Number(RegExp.$1) });
	} else if (/^ABORT_AFTER_MS:\s*(\d+)/.test(line)) {
		turns.push({ kind: "abort_after_ms", ms: Number(RegExp.$1) });
	}
}
if (turns.length === 0) {
	console.error("INPUT.md has no 'TURN: <prompt>' lines");
	process.exit(2);
}

process.chdir(sandboxDir);

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

let model = modelRegistry.find(provider, modelId);
if (!model) {
	// external: Pi uses a same-provider fallback for unknown model IDs.
	const sameProvider = modelRegistry.getAll().filter((m) => m.provider === provider);
	if (sameProvider.length === 0) {
		console.error(`No models available for provider "${provider}". Cannot build fallback.`);
		process.exit(2);
	}
	const base = sameProvider[0];
	model = { ...base, id: modelId, name: modelId };
	console.error(`[drive] Model "${provider}/${modelId}" not in registry; using custom model id (base=${base.id}).`);
}

let compactionConfig = { enabled: false };
try {
	const compactionPath = join(caseDir, "compaction.json");
	const raw = readFileSync(compactionPath, "utf8");
	const parsed = JSON.parse(raw);
	if (parsed && typeof parsed === "object" && parsed.enabled === true) {
		compactionConfig = parsed;
		console.error(`[drive] case-level compaction enabled: ${JSON.stringify(parsed)}`);
	}
} catch {
}
const settingsManager = SettingsManager.inMemory({
	compaction: compactionConfig,
	retry: { enabled: true, maxRetries: 2 },
});

// external: the harness must isolate the host Pi configuration.
const agentDir = join(runDir, "agent-dir");
mkdirSync(agentDir, { recursive: true });

const resourceLoader = new DefaultResourceLoader({
	cwd: sandboxDir,
	agentDir,
	settingsManager,
	additionalExtensionPaths: [extPath],
	noExtensions: false,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await resourceLoader.reload();

const extInfo = resourceLoader.getExtensions();
for (const e of extInfo.errors) {
	console.error(`[drive] extension load error: ${e.path}: ${e.error}`);
}
if (extInfo.extensions.length === 0) {
	console.error("[drive] no extensions loaded — extension load probably failed silently");
	process.exit(2);
}

const sessionManager = SessionManager.create(sandboxDir, sessionDir);

const { session, modelFallbackMessage } = await createAgentSession({
	cwd: sandboxDir,
	agentDir,
	model,
	thinkingLevel: thinking,
	authStorage,
	modelRegistry,
	resourceLoader,
	sessionManager,
	settingsManager,
});

if (modelFallbackMessage) {
	console.error(`[drive] modelFallback: ${modelFallbackMessage}`);
}

const emit = (obj) => {
	process.stdout.write(JSON.stringify(obj) + "\n");
};

emit({
	type: "session",
	version: 3,
	id: session.sessionId,
	timestamp: new Date().toISOString(),
	cwd: sandboxDir,
});

const unsubscribe = session.subscribe((event) => {
	try {
		emit(event);
	} catch (err) {
		console.error(`[drive] failed to emit event: ${err?.message || err}`);
	}
});

let aborted = false;

let lastTurnActivityAt = Date.now();
let inFlightTurns = 0;
session.subscribe((e) => {
	if (e.type === "turn_start") {
		inFlightTurns += 1;
		lastTurnActivityAt = Date.now();
	} else if (e.type === "turn_end") {
		inFlightTurns = Math.max(0, inFlightTurns - 1);
		lastTurnActivityAt = Date.now();
	} else if (e.type === "agent_start" || e.type === "agent_end") {
		lastTurnActivityAt = Date.now();
	}
});

// external: Pi can dispatch queued turns after prompt() resolves.
const QUIET_MS = Number(process.env.PI_GOAL_QUIET_MS || "5000");
const POLL_MS = 50;

function readActiveGoal() {
	try {
		const dir = ".pi/goals";
		const list = readdirSync(dir);
		for (const name of list) {
			if (!name.startsWith("active_goal_") || !name.endsWith(".md")) continue;
			const content = readFileSync(join(dir, name), "utf8");
			const end = content.indexOf("\n}");
			if (end < 0) continue;
			const json = content.slice(0, end + 2);
			try {
				const obj = JSON.parse(json);
				return obj;
			} catch { }
		}
	} catch { }
	return null;
}

async function waitForQuiescence(deadline) {
	while (Date.now() < deadline) {
		const idle = !session.isStreaming && inFlightTurns === 0;
		const sinceActivity = Date.now() - lastTurnActivityAt;
		if (idle && sinceActivity >= QUIET_MS) {
			const g = readActiveGoal();
			if (!g || g.status !== "active" || g.autoContinue === false) return true;
		}
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
	return false;
}

const promptWithTimeout = async (text, idx, opts = {}) => {
	const start = Date.now();
	emit({ type: "_turn_marker", index: idx, prompt: text });
	const deadline = Date.now() + turnTimeoutMs;
	lastTurnActivityAt = Date.now();
	let abortTimer = null;
	if (opts.abortAfterMs && opts.abortAfterMs > 0) {
		emit({ type: "_drive_abort_armed", index: idx, after_ms: opts.abortAfterMs });
		abortTimer = setTimeout(() => {
			emit({ type: "_drive_abort_scheduled", index: idx, after_ms: opts.abortAfterMs });
			try {
				session.abort();
			} catch (e) {
				emit({ type: "_drive_abort_error", index: idx, error: String(e?.message || e) });
			}
		}, opts.abortAfterMs);
	}
	try {
		const promptResult = session.prompt(text);
		await Promise.race([
			promptResult,
			new Promise((_, rej) => setTimeout(() => rej(new Error("prompt timeout")), turnTimeoutMs)),
		]);
		await waitForQuiescence(deadline);
	} catch (err) {
		emit({ type: "_drive_error", index: idx, message: String(err?.message || err) });
		if (String(err?.message || "").includes("timeout")) {
			aborted = true;
			session.abort().catch(() => {});
		}
	} finally {
		if (abortTimer) clearTimeout(abortTimer);
	}
	const elapsed = Date.now() - start;
	emit({ type: "_turn_done", index: idx, elapsed_ms: elapsed });
};

try {
	let idx = 0;
	let pendingAbortMs = 0;
	for (const t of turns) {
		if (aborted) break;
		if (t.kind === "turn") {
			idx += 1;
			await promptWithTimeout(t.text, idx, { abortAfterMs: pendingAbortMs });
			pendingAbortMs = 0;
		} else if (t.kind === "sleep") {
			await new Promise((r) => setTimeout(r, t.ms));
		} else if (t.kind === "abort_after_ms") {
			pendingAbortMs = t.ms;
		}
	}
} finally {
	unsubscribe();
	try {
		session.dispose();
	} catch {}
}

process.exit(aborted ? 124 : 0);
