import type { GoalTask } from "./goal-record.ts";

export interface TaskIndex {
 /** The task list this index was derived from (read-time view, not a copy). */
 tasks: readonly GoalTask[];
 byId: Map<string, GoalTask>;
 ordered: Array<{task: GoalTask; depth: number; parentId?: string}>;
 pending: GoalTask[];
 complete: number;
 skipped: number;
}

const emptyTasks: GoalTask[] = [];

/**
 * Derive the task index for one read. Pure and uncached: the task list is
 * edited in place by the task tools, so a content-compared cache paid a deep
 * field comparison on every lookup, which cost more than the single walk it
 * avoided. The index references the live task objects, so callers use it
 * synchronously and do not keep it across a task edit; every consumer builds
 * its own output rows.
 */
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
