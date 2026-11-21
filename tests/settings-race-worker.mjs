
import { workerData } from "node:worker_threads";
import { mutateSettingsLayer } from "../extensions/goal-settings.ts";

const { globalFile, key, iterations } = workerData;

for (let i = 0; i < iterations; i += 1) {
	mutateSettingsLayer({
		scope: "global",
		cwd: process.cwd(),
		env: { PI_GOAL_GLOBAL_SETTINGS_FILE: globalFile },
		mutation: { op: "set", path: [key], value: `${key}-${i}` },
	});
}
