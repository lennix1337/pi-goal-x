#!/usr/bin/env node
// external: macOS does not provide GNU timeout by default.

import { spawn } from "node:child_process";

const seconds = Number(process.argv[2]);
const command = process.argv[3];
const args = process.argv.slice(4);
if (!Number.isFinite(seconds) || seconds <= 0 || !command) {
	console.error("usage: node watchdog.mjs <seconds> <command> [args...]");
	process.exit(2);
}

const child = spawn(command, args, { stdio: "inherit" });
const timer = setTimeout(() => {
	console.error(`[watchdog] timed out after ${seconds}s; killing ${command}`);
	child.kill("SIGKILL");
	process.exitCode = 124;
}, seconds * 1000);
timer.unref?.();

child.on("error", (err) => {
	console.error(`[watchdog] failed to spawn ${command}: ${err.message}`);
	process.exitCode = 2;
});
child.on("exit", (code) => {
	clearTimeout(timer);
	if (process.exitCode === undefined) process.exitCode = code ?? 0;
});
