import { dateToKey } from './date';
import { mondayOf } from './workouts';

function addDays(dateKeyStr, delta) {
  const d = new Date(`${dateKeyStr}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return dateToKey(d);
}

/**
 * The inclusive [min, max] dateKey range a reschedule's new date is allowed to land in - the
 * same Monday-start week as originalDateKey (mondayOf, the same week boundary the session-mix
 * chart already uses), or up to one day outside that week on either end if allowCrossWeek is
 * set (a task's own allowCrossWeekReschedule field). This is deliberately a plain [min, max]
 * pair, not a list of individual eligible dates, so the UI can hand it straight to a native
 * <input type="date">'s own min/max attributes.
 */
export function getRescheduleRange(originalDateKey, allowCrossWeek) {
  const monday = mondayOf(originalDateKey);
  const sunday = addDays(monday, 6);
  return {
    min: allowCrossWeek ? addDays(monday, -1) : monday,
    max: allowCrossWeek ? addDays(sunday, 1) : sunday,
  };
}

/** Whether newDateKey is a legal reschedule target for a task originally due on
 * originalDateKey - within getRescheduleRange's bounds, and not the same day (rescheduling a
 * day to itself is a no-op, not a real move). */
export function isValidRescheduleTarget(originalDateKey, newDateKey, allowCrossWeek) {
  if (!newDateKey || newDateKey === originalDateKey) return false;
  const { min, max } = getRescheduleRange(originalDateKey, allowCrossWeek);
  return newDateKey >= min && newDateKey <= max;
}
