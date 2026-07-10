export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dateToKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayKey() {
  return dateToKey(new Date());
}

export function todayWeekday() {
  return new Date().getDay();
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function lastNDates(n) {
  const dates = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d);
  }
  return dates;
}

/**
 * Finds whichever task version was in effect on `date`. Versions must be
 * sorted ascending by effectiveFrom. Edits take effect starting the calendar
 * day they're made, so a day already in the past always uses the version
 * that existed on/before it, never a later edit.
 */
export function findEffectiveVersion(versions, date) {
  const day = startOfDay(date);
  let effective = null;
  for (const version of versions) {
    if (startOfDay(new Date(version.effectiveFrom)) <= day) {
      effective = version;
    } else {
      break;
    }
  }
  return effective;
}

/**
 * A task's completion fraction (0-1) for a given date, evaluated against whichever version was
 * effective that day. Returns null if the task wasn't due at all that day (didn't exist yet,
 * paused, or not scheduled). `reschedules` (default []) is this one task's own
 * task_reschedules rows ({originalDate, newDate} pairs, see storage.js) - a one-time,
 * per-occurrence move that doesn't touch the recurring `days` schedule at all: `date` matching
 * some reschedule's `originalDate` is treated as nothing-scheduled (not a miss, exactly like a
 * day that was never due), while `date` matching a `newDate` is due even if it falls outside
 * `version.days` for that week.
 */
export function getTaskFraction(versions, completions, date, reschedules = []) {
  const dateKey = dateToKey(date);
  if (reschedules.some((r) => r.originalDate === dateKey)) return null;

  const version = findEffectiveVersion(versions, date);
  if (!version || !version.active) return null;
  const dueByDay = version.days.includes(date.getDay());
  const dueByReschedule = reschedules.some((r) => r.newDate === dateKey);
  if (!dueByDay && !dueByReschedule) return null;

  const value = completions?.[dateKey];
  if (version.completionType === 'quantity') {
    const target = version.target || 0;
    if (!target) return value ? 1 : 0;
    return Math.min(1, Math.max(0, (value || 0) / target));
  }
  if (version.completionType === 'workout') {
    return Math.min(1, Math.max(0, value || 0));
  }
  return value ? 1 : 0;
}

/**
 * A routine's completion fraction for a date = average of its tasks'
 * fractions that day, ignoring tasks not due that day. Returns null if none
 * of the routine's tasks were due (so callers can skip the day rather than
 * treating it as a 0%). `reschedulesMap` (default {}) is task id -> its own reschedules,
 * the same "load once, pass down" shape as taskVersionsMap - see getTaskFraction above.
 */
export function getRoutineFraction(routine, taskVersionsMap, completions, date, reschedulesMap = {}) {
  // Routine-level pause is a simple current-state gate (unlike task-level
  // pause, which is versioned for historical accuracy) - pausing/resuming a
  // routine takes effect for all dates immediately, including past ones.
  if (!routine.active) return null;
  // Archiving, unlike pausing, IS date-aware: a day before archivedAt computes exactly as if
  // the routine were never archived (its full history stays intact), while archivedAt itself
  // and every day after are treated as "nothing due" - see db.js's migration comment.
  if (routine.archivedAt && startOfDay(date) >= startOfDay(new Date(routine.archivedAt))) return null;
  // startDate plays the same role as archivedAt, mirrored on the other end: a day before it
  // hasn't started yet, so it's "nothing due" rather than a miss. No end-of-window check is
  // needed here for endDate - once it passes, App.jsx's auto-archive check sets archivedAt,
  // whose own cutover above already covers it.
  if (routine.startDate && startOfDay(date) < startOfDay(new Date(routine.startDate))) return null;

  const fractions = [];
  for (const task of routine.tasks) {
    const versions = taskVersionsMap[task.id];
    if (!versions) continue;
    const fraction = getTaskFraction(versions, completions[task.id] || {}, date, reschedulesMap[task.id] || []);
    if (fraction !== null) fractions.push(fraction);
  }
  if (fractions.length === 0) return null;
  return fractions.reduce((sum, f) => sum + f, 0) / fractions.length;
}

export function isRoutineDueToday(routine, taskVersionsMap, completions, reschedulesMap = {}) {
  return getRoutineFraction(routine, taskVersionsMap, completions, new Date(), reschedulesMap) !== null;
}

export function calcRoutineStreak(routine, taskVersionsMap, completions, reschedulesMap = {}) {
  let streak = 0;
  const cursor = new Date();
  const today = todayKey();
  for (let i = 0; i < 365; i++) {
    const fraction = getRoutineFraction(routine, taskVersionsMap, completions, cursor, reschedulesMap);
    if (fraction === null) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    if (fraction === 1) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else if (dateToKey(cursor) === today) {
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

/**
 * The longest streak ever achieved, not just the live one - the habit equivalent of a fitness
 * PR. Unlike calcRoutineStreak (which stops the moment a gap is hit and returns just that live
 * count), this walks the whole lookback window and keeps the longest run seen, including runs
 * that have since ended.
 */
export function calcLongestRoutineStreak(
  routine,
  taskVersionsMap,
  completions,
  lookbackDays = 365,
  reschedulesMap = {}
) {
  const dates = lastNDates(lookbackDays);
  let longest = 0;
  let current = 0;
  for (const date of dates) {
    const fraction = getRoutineFraction(routine, taskVersionsMap, completions, date, reschedulesMap);
    if (fraction === null) continue; // not due that day - doesn't break or extend a run
    if (fraction === 1) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

export function calcRoutineCompletionRate(routine, taskVersionsMap, completions, windowDays = 30, reschedulesMap = {}) {
  const dates = lastNDates(windowDays);
  const fractions = dates
    .map((d) => getRoutineFraction(routine, taskVersionsMap, completions, d, reschedulesMap))
    .filter((f) => f !== null);
  if (fractions.length === 0) return 0;
  return Math.round((fractions.reduce((sum, f) => sum + f, 0) / fractions.length) * 100);
}
