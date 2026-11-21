
import { performance } from "node:perf_hooks";

import { beginFsCount, endFsCount, state } from "./guard-state.mjs";
import { readActiveGoalPool } from "../../extensions/storage/goal-files.ts";
import { loadGoalSettings } from "../../extensions/goal-settings.ts";
import { readGoalLedger, loadLedgerState } from "../../extensions/goal-ledger.ts";
import { createGoalCore } from "../../extensions/goal-state.ts";

function makePi() {
	const handlers = new Map();
	return {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		events: { emit: () => {}, on: () => () => {} },
		sendMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
	};
}

function makeCtx(cwd) {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getBranch: () => [], getCwd: () => cwd, getSessionId: () => "b5b", getRoot: () => cwd },
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, onTerminalInput: () => () => {}, select: async () => undefined, confirm: async () => true, custom: async () => undefined },
		getSystemPrompt: () => "", isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
	};
}

const [, , cwd, flow] = process.argv;
if (process.argv[4] === "lat25") state.latencyMs = 25;

async function runFlow() {
	beginFsCount();
	const t0 = performance.now();
	switch (flow) {
		case "pool":
			readActiveGoalPool({ cwd });
			break;
		case "settings":
			loadGoalSettings(cwd);
			break;
		case "ledger":
			readGoalLedger({ cwd });
			break;
		case "ledgerstate":
			loadLedgerState({ cwd });
			break;
		case "startup": {
			const core = createGoalCore(makePi(), {});
			await core.loadState(makeCtx(cwd));
			break;
		}
		default:
			throw new Error(`unknown flow: ${flow}`);
	}
	const wall = performance.now() - t0;
	const ops = endFsCount();
	process.stdout.write(JSON.stringify({ ops, wall: Math.round(wall * 10) / 10 }));
}

await runFlow();
