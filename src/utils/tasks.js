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

/** Formats whole seconds as M:SS, or H:MM:SS once an hour is involved - e.g. 45 -> "0:45",
 * 125 -> "2:05", 3665 -> "1:01:05". Used for every timer display (the live ring, target labels,
 * review-step buttons) now that targets can run well past a minute. */
export function formatHms(totalSeconds) {
  const sign = totalSeconds < 0 ? '-' : '';
  const s = Math.abs(Math.round(totalSeconds || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${sign}${hours}:${mm}:${ss}` : `${sign}${mm}:${ss}`;
}

/** Combines the separate hours/minutes/seconds parts typed into an HH:MM:SS setup input into the
 * single total-seconds value that's actually persisted (task.target / exercise's
 * targetDurationSeconds stay plain seconds either way, so this input style needed no
 * schema/versioning change) - the inverse of secondsToHms below. */
export function hmsToSeconds(hours, minutes, seconds) {
  return (Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60 + (Number(seconds) || 0);
}

/** The inverse split, for prefilling an HH:MM:SS input from a stored total-seconds value. */
export function secondsToHms(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  return {
    hours: Math.floor(s / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
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
