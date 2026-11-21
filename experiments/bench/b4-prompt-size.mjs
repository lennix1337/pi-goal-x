
import { makeGoalRecord } from "./bench-common.mjs";
import { Baseline, estimateTokens } from "./bench-common.mjs";
import { taskListBlock, continuationPrompt, goalPrompt } from "../../extensions/prompts/goal-prompts.ts";


const PREFILL_TOK_PER_SEC = 1000;

function taskTree(count) {
	const tasks = [];
	for (let i = 0; i < count; i++) {
		const task = {
			id: `t${i}`,
			title: `Task ${i}: implement the sub-feature with a reasonably descriptive title that exercises wrapping`,
			status: i < count / 2 ? "complete" : "pending",
			...(i < count / 2 ? { evidence: `verified by test run ${i} with assertions passing` } : {}),
			...(i >= count / 2 ? { verificationContract: "run the suite and confirm green with a grep check" } : {}),
		};
		if (i % 10 === 9 && i > 0) {
			task.subtasks = [
				{ id: `${task.id}-a`, title: `Subtask A of ${task.id}`, status: "complete", evidence: "done" },
				{ id: `${task.id}-b`, title: `Subtask B of ${task.id}`, status: "pending", verificationContract: "verify sub-output" },
			];
		}
		tasks.push(task);
	}
	return tasks;
}

function goalWithTasks(count) {
	const goal = makeGoalRecord({ objective: "Implement the full feature set with success criteria and a verification contract." });
	goal.taskList = { tasks: taskTree(count), blockCompletion: true, proposedAt: new Date().toISOString() };
	goal.verificationContract = "Run the test suite (0 failures), grep for leftover references, and re-read the requirements.";
	return goal;
}

export function run(baseline) {
	for (const count of [10, 50]) {
		const goal = goalWithTasks(count);
		const blocks = [
			["taskListBlock", taskListBlock(goal, {}), "prompts/goal-prompts"],
			["continuationPrompt", continuationPrompt(goal, {}), "prompts/goal-prompts"],
			["goalPrompt", goalPrompt(goal, {}), "prompts/goal-prompts"],
		];
		for (const [name, text, modules] of blocks) {
			const tokens = estimateTokens(text);
			baseline.add({
				id: `B4.${name}.${count}t`, label: `${name} (${count}-task tree)`,
				modules, fixture: `${count} tasks (half complete, contracts+evidence)`,
				p50: "-", p95: "-", max: "-",
				ops: tokens, n: 1,
				notes: `${text.length} chars, ~${tokens} tokens; est prefill ~${Math.round(tokens / PREFILL_TOK_PER_SEC * 100) / 100}s @ ${PREFILL_TOK_PER_SEC}t/s (estimate, not live)`,
			});
		}
	}
	return baseline;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const baseline = new Baseline();
	run(baseline);
	process.stdout.write(baseline.markdown());
}
