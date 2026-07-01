const DEFAULT_QUICK_ADD = [5, 10];

export function quickAddAmountsFor(task) {
  return task.quickAdd?.length ? task.quickAdd : DEFAULT_QUICK_ADD;
}
