/** Named benchmark campaigns and their baseline locations. */

export const CAMPAIGNS = {
	"extension-review-plan": {
		specDir: "2026-08-04-extension-review-plan",
		jsonPrefix: "baseline-",
	},
	naf: {
		specDir: "2026-08-06-non-agent-flow-optimization",
		jsonPrefix: "baseline-naf-",
	},
};

export function campaignConfig(name) {
	return CAMPAIGNS[name] ?? { specDir: name, jsonPrefix: `baseline-${name}-` };
}
