
import * as nodeModule from "node:module";

if (typeof nodeModule.registerHooks !== "function") {
	throw new Error("Benchmarks require Node 22.15+ (registerHooks).");
}

const base = new URL("../../tests/stubs/", import.meta.url);
const benchBase = new URL("./", import.meta.url);

const adapters = new Map([
	["@earendil-works/pi-ai", new URL("pi-ai.ts", base).href],
	["@earendil-works/pi-coding-agent", new URL("pi-coding-agent.ts", base).href],
	["@earendil-works/pi-tui", new URL("pi-tui.ts", base).href],
	["node:fs", new URL("node-fs.mjs", benchBase).href],
	["node:child_process", new URL("node-child-process.mjs", benchBase).href],
	["node:net", new URL("node-net.mjs", benchBase).href],
	["node:http", new URL("node-http.mjs", benchBase).href],
	["node:https", new URL("node-https.mjs", benchBase).href],
]);

nodeModule.registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = adapters.get(specifier);
		return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
	},
});
