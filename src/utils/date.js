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
 * A task's completion fraction (0-1) for a given date, evaluated against
 * whichever version was effective that day. Returns null if the task wasn't
 * due at all that day (didn't exist yet, paused, or not scheduled).
 */
export function getTaskFraction(versions, completions, date) {
  const version = findEffectiveVersion(versions, date);
  if (!version || !version.active || !version.days.includes(date.getDay())) return null;

  const value = completions?.[dateToKey(date)];
  if (version.completionType === 'quantity') {
    const target = version.target || 0;
    if (!target) return value ? 1 : 0;
    return Math.min(1, Math.max(0, (value || 0) / target));
  }
  return value ? 1 : 0;
}

/**
 * A routine's completion fraction for a date = average of its tasks'
 * fractions that day, ignoring tasks not due that day. Returns null if none
 * of the routine's tasks were due (so callers can skip the day rather than
 * treating it as a 0%).
 */
export function getRoutineFraction(routine, taskVersionsMap, completions, date) {
  // Routine-level pause is a simple current-state gate (unlike task-level
  // pause, which is versioned for historical accuracy) - pausing/resuming a
  // routine takes effect for all dates immediately, including past ones.
  if (!routine.active) return null;

  const fractions = [];
  for (const task of routine.tasks) {
    const versions = taskVersionsMap[task.id];
    if (!versions) continue;
    const fraction = getTaskFraction(versions, completions[task.id] || {}, date);
    if (fraction !== null) fractions.push(fraction);
  }
  if (fractions.length === 0) return null;
  return fractions.reduce((sum, f) => sum + f, 0) / fractions.length;
}

export function isRoutineDueToday(routine, taskVersionsMap, completions) {
  return getRoutineFraction(routine, taskVersionsMap, completions, new Date()) !== null;
}

export function calcRoutineStreak(routine, taskVersionsMap, completions) {
  let streak = 0;
  const cursor = new Date();
  const today = todayKey();
  for (let i = 0; i < 365; i++) {
    const fraction = getRoutineFraction(routine, taskVersionsMap, completions, cursor);
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

export function calcRoutineCompletionRate(routine, taskVersionsMap, completions, windowDays = 30) {
  const dates = lastNDates(windowDays);
  const fractions = dates
    .map((d) => getRoutineFraction(routine, taskVersionsMap, completions, d))
    .filter((f) => f !== null);
  if (fractions.length === 0) return 0;
  return Math.round((fractions.reduce((sum, f) => sum + f, 0) / fractions.length) * 100);
}
