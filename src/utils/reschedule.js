import { dateToKey } from './date';

function addDays(dateKeyStr, delta) {
  const d = new Date(`${dateKeyStr}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return dateToKey(d);
}

/**
 * The inclusive [min, max] dateKey range a reschedule's new date is allowed to land in -
 * future-only, from the originally scheduled day itself out to 8 days after it. Deliberately
 * anchored to originalDateKey rather than a Monday-Sunday calendar week (the app has no other
 * concept of a calendar-aligned week anywhere - every analytics window, e.g. the Dashboard's
 * "Week" range and every streak/consistency lookback, is a rolling N-days-back-from-today
 * window, never calendar-aligned - see rangeStartDate/lastNDates in analytics.js/date.js), and
 * anchored to the original day specifically (not "today") so the available range is the same
 * size regardless of which weekday the task happens to be due on. A plain [min, max] pair, not a
 * list of individual eligible dates, so the UI can hand it straight to a native
 * <input type="date">'s own min/max attributes.
 */
export function getRescheduleRange(originalDateKey) {
  return {
    min: originalDateKey,
    max: addDays(originalDateKey, 8),
  };
}

/** Whether newDateKey is a legal reschedule target for a task originally due on
 * originalDateKey - within getRescheduleRange's bounds, and not the same day (rescheduling a
 * day to itself is a no-op, not a real move). */
export function isValidRescheduleTarget(originalDateKey, newDateKey) {
  if (!newDateKey || newDateKey === originalDateKey) return false;
  const { min, max } = getRescheduleRange(originalDateKey);
  return newDateKey >= min && newDateKey <= max;
}
