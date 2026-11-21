import type { GoalTask } from "./goal-record.ts";

export interface TaskIndex {
 tasks: readonly GoalTask[];
 byId: Map<string, GoalTask>;
 ordered: Array<{task: GoalTask; depth: number; parentId?: string}>;
 pending: GoalTask[];
 complete: number;
 skipped: number;
}

const emptyTasks: GoalTask[] = [];

/** Build an index referencing live tasks; do not retain it across task edits. */
export function taskIndex(tasks: readonly GoalTask[] = emptyTasks): TaskIndex {
 const result: TaskIndex = {tasks, byId: new Map(), ordered: [], pending: [], complete: 0, skipped: 0};
 const walk = (list: readonly GoalTask[], depth: number, parentId?: string): void => {
  for (const task of list) {
   result.byId.set(task.id, task); result.ordered.push({task, depth, parentId});
   if (task.status === "pending") result.pending.push(task);
   else if (task.status === "complete") result.complete++;
   else result.skipped++;
   if (task.subtasks) walk(task.subtasks, depth + 1, task.id);
  }
 };
 walk(tasks, 0);
 return result;
}
