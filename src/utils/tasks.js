import { todayKey } from './date';

const DEFAULT_QUICK_ADD = [5, 10];

// Extra reminder slots per task need fixed, config-independent notification
// ids so cancelling always sweeps every slot that could ever have been
// scheduled, even after the user removes a time - see notifications.js.
export const MAX_EXTRA_REMINDERS = 5;

export function quickAddAmountsFor(task) {
  return task.quickAdd?.length ? task.quickAdd : DEFAULT_QUICK_ADD;
}

export function parseQuickAddText(text) {
  return text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n) && n > 0);
}

export function isTaskDoneToday(task, completions) {
  const value = completions[task.id]?.[todayKey()];
  if (task.completionType === 'quantity') {
    return Boolean(task.target) && (value || 0) >= task.target;
  }
  if (task.completionType === 'workout') {
    return (value || 0) >= 1;
  }
  return Boolean(value);
}
