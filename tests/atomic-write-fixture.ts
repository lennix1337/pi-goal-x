import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

/** Fail only the selected atomic replacement; reads, locks and ledger appends stay real. */
export function denyAtomicReplacement(t: TestContext, target: string): () => void {
	const rename = fs.renameSync;
	const fault = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
		if (String(args[1]) === target) throw Object.assign(new Error("Injected atomic replacement denied"), { code: "EACCES" });
		return rename(...args);
	});
	syncBuiltinESMExports();
	return () => {
		fault.mock.restore();
		syncBuiltinESMExports();
	};
}
