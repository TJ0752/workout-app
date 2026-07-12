import { DAY_LABELS, dateToKey, findEffectiveVersion, getRoutineFraction, getTaskFraction, lastNDates } from './date.js';
import { buildDayOfWeekBreakdown, getDashboardStats, rangeStartDate } from './analytics.js';
import { inferExerciseCategory } from './exerciseCategory.js';

/**
 * Analytics 2 (see CLAUDE.md) - a second, additive analytics surface alongside the original
 * Dashboard tab, not a replacement. This module holds everything the original analytics.js
 * doesn't already cover: custom/rolling range presets, per-routine (not just all-routines)
 * day-of-week breakdowns, on-time-rate tracking, per-task average logged values, workout-category
 * aggregation, and period-over-period deltas. Nothing here changes analytics.js's existing
 * exported behavior for the original Dashboard - the few things added there (rangeStartDate/
 * buildDayOfWeekBreakdown exports, the 'calendarMonth' range id, custom-range support) are purely
 * additive.
 */

export const ANALYTICS_V2_RANGES = [
  { id: 'week', label: 'This Week' },
  { id: 'calendarMonth', label: 'This Month' },
  { id: 'month', label: 'Last 30 Days' },
  { id: 'all', label: 'All Time' },
];

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function datesBetween(start, end) {
  const dates = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setHours(0, 0, 0, 0);
  while (cursor <= last) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

/**
 * A custom range only ever has a custom *start*, always running through today - see
 * getDashboardStats's own doc comment in analytics.js for why (getOverallConsistency/
 * getLongestOverallStreak always anchor their lookback at the real "now", so an arbitrary
 * [start, end] window in the past would silently compute those against the wrong days).
 */
export function makeCustomRange(startDateKey) {
  return { id: 'custom', start: startDateKey };
}

export function datesForRange(range, routines, today = new Date()) {
  const start = rangeStartDate(range, routines, today);
  return datesBetween(start, today);
}

function overallCompletionPctForDates(routines, taskVersionsMap, completions, dates, reschedulesMap) {
  const fractions = [];
  for (const routine of routines) {
    for (const date of dates) {
      const f = getRoutineFraction(routine, taskVersionsMap, completions, date, reschedulesMap);
      if (f !== null) fractions.push(f);
    }
  }
  const avg = average(fractions);
  return avg === null ? null : Math.round(avg * 100);
}

/**
 * completionRate delta vs. the immediately preceding period of the same length (e.g. "+9% vs
 * last week") - null for 'all' (there's no meaningful "previous period" for all-time) or when
 * either period has nothing due to compare. Computed independently of getDashboardStats/
 * getOverallConsistency (rather than reusing them for the "previous" side) specifically so the
 * previous period's window can end in the past without hitting the same lastNDates-anchors-to-now
 * mismatch documented on getDashboardStats.
 */
export function getCompletionRateDelta(routines, taskVersionsMap, completions, range, reschedulesMap = {}) {
  if (range === 'all') return null;
  const today = new Date();
  const dates = datesForRange(range, routines, today);
  if (dates.length === 0) return null;
  const currentPct = overallCompletionPctForDates(routines, taskVersionsMap, completions, dates, reschedulesMap);

  const prevEnd = new Date(dates[0]);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (dates.length - 1));
  const prevDates = datesBetween(prevStart, prevEnd);
  const prevPct = overallCompletionPctForDates(routines, taskVersionsMap, completions, prevDates, reschedulesMap);

  if (currentPct === null || prevPct === null) return null;
  return currentPct - prevPct;
}

/** Routine-day / task-day due-and-completed counts across a date range - "Routines completed
 * 19/25" and "Tasks completed 84/110" on the Overview screen. Each due instance is one
 * (routine-or-task, day) pair, the same unit getDashboardStats.totalCompleted already counts for
 * tasks - this just also counts routines, and returns the "due" denominator alongside it. */
export function getPeriodTotals(routines, taskVersionsMap, completions, dates, reschedulesMap = {}) {
  let routinesDue = 0;
  let routinesCompleted = 0;
  let tasksDue = 0;
  let tasksCompleted = 0;
  for (const routine of routines) {
    for (const date of dates) {
      const fraction = getRoutineFraction(routine, taskVersionsMap, completions, date, reschedulesMap);
      if (fraction === null) continue;
      routinesDue += 1;
      if (fraction === 1) routinesCompleted += 1;
    }
    for (const task of routine.tasks) {
      const versions = taskVersionsMap[task.id];
      if (!versions) continue;
      const taskCompletions = completions[task.id] || {};
      const reschedules = reschedulesMap[task.id] || [];
      for (const date of dates) {
        const fraction = getTaskFraction(versions, taskCompletions, date, reschedules);
        if (fraction === null) continue;
        tasksDue += 1;
        if (fraction === 1) tasksCompleted += 1;
      }
    }
  }
  return { routinesDue, routinesCompleted, tasksDue, tasksCompleted };
}

/** Day-of-week completion % scoped to a *single* routine (buildDayOfWeekBreakdown in analytics.js
 * is already all-routines-at-once, for the original Dashboard) - powers a routine detail screen's
 * own heatmap and best/weakest-day stat. */
export function getRoutineDayOfWeekBreakdown(routine, taskVersionsMap, completions, dates, reschedulesMap = {}) {
  const buckets = Array.from({ length: 7 }, () => []);
  for (const date of dates) {
    const fraction = getRoutineFraction(routine, taskVersionsMap, completions, date, reschedulesMap);
    if (fraction !== null) buckets[date.getDay()].push(fraction);
  }
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.map((dow) => {
    const avg = average(buckets[dow]);
    return { label: DAY_LABELS[dow], pct: avg === null ? null : Math.round(avg * 100) };
  });
}

/** Daily completion % series for a single routine over a date range - the Routine Detail
 * screen's own "Completion Trend" line chart. Always daily granularity (unlike the original
 * Dashboard's trend, which buckets weekly/monthly for longer ranges) since a routine detail
 * view's date range is typically short enough for daily bars to stay readable, and a single
 * routine's own trend line is exactly the kind of place a little extra density is useful. */
export function getRoutineTrendSeries(routine, taskVersionsMap, completions, dates, reschedulesMap = {}) {
  return dates.map((date) => {
    const fraction = getRoutineFraction(routine, taskVersionsMap, completions, date, reschedulesMap);
    return { date: dateToKey(date), pct: fraction === null ? null : Math.round(fraction * 100) };
  });
}

/** The best/worst-performing entries of a day-of-week breakdown (as produced by either
 * buildDayOfWeekBreakdown or getRoutineDayOfWeekBreakdown above) - null if nothing in the
 * breakdown has any data at all. */
export function bestAndWeakestDay(dayOfWeekBreakdown) {
  let best = null;
  let weakest = null;
  for (const day of dayOfWeekBreakdown) {
    if (day.pct === null) continue;
    if (!best || day.pct > best.pct) best = day;
    if (!weakest || day.pct < weakest.pct) weakest = day;
  }
  return { best, weakest };
}

function parseTimeToMinutes(hhmm) {
  const [h, m] = (hhmm || '00:00').split(':').map(Number);
  return h * 60 + m;
}

function localMinutesOfDay(isoTimestamp) {
  const d = new Date(isoTimestamp);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * On-time rate for one task: of the days it was actually completed, how many were completed at
 * or before that day's effective due-by `time`. `completionTimestamps` is the per-task
 * `{ [date]: isoString }` map from storage.js's getCompletionTimestamps - see that function's own
 * doc comment for the quantity-task "last write, not first-crossed-target" caveat. Days with no
 * captured timestamp (data logged before this feature existed) are excluded from both the
 * numerator and denominator rather than counted as late, since there's genuinely no signal either
 * way for them.
 */
export function getTaskOnTimeRate(versions, completions, completionTimestamps, dates, reschedules = []) {
  let due = 0;
  let onTime = 0;
  for (const date of dates) {
    const fraction = getTaskFraction(versions, completions, date, reschedules);
    if (fraction !== 1) continue;
    const dateKey = dateToKey(date);
    const timestamp = completionTimestamps?.[dateKey];
    if (!timestamp) continue;
    const version = findEffectiveVersion(versions, date);
    if (!version) continue;
    due += 1;
    if (localMinutesOfDay(timestamp) <= parseTimeToMinutes(version.time)) onTime += 1;
  }
  return { due, onTime, pct: due === 0 ? null : Math.round((onTime / due) * 100) };
}

/** Same as getTaskOnTimeRate, aggregated across every task in one routine. */
export function getRoutineOnTimeRate(routine, taskVersionsMap, completions, completionTimestamps, dates, reschedulesMap = {}) {
  let due = 0;
  let onTime = 0;
  for (const task of routine.tasks) {
    const versions = taskVersionsMap[task.id];
    if (!versions) continue;
    const result = getTaskOnTimeRate(
      versions,
      completions[task.id] || {},
      completionTimestamps[task.id] || {},
      dates,
      reschedulesMap[task.id] || []
    );
    due += result.due;
    onTime += result.onTime;
  }
  return { due, onTime, pct: due === 0 ? null : Math.round((onTime / due) * 100) };
}

/** Same again, aggregated across every routine - the Overview screen's single on-time-rate stat. */
export function getOverallOnTimeRate(routines, taskVersionsMap, completions, completionTimestamps, dates, reschedulesMap = {}) {
  let due = 0;
  let onTime = 0;
  for (const routine of routines) {
    const result = getRoutineOnTimeRate(routine, taskVersionsMap, completions, completionTimestamps, dates, reschedulesMap);
    due += result.due;
    onTime += result.onTime;
  }
  return { due, onTime, pct: due === 0 ? null : Math.round((onTime / due) * 100) };
}

/** Average logged value for a quantity task over its due days in a range (e.g. "2.5 L avg" for a
 * 3L daily water target) - boolean/workout tasks have no single "value" to average, so callers
 * should only call this for completionType === 'quantity' tasks. */
export function getTaskAverageValue(versions, taskCompletions, dates, reschedules = []) {
  const values = [];
  for (const date of dates) {
    const fraction = getTaskFraction(versions, taskCompletions, date, reschedules);
    if (fraction === null) continue;
    const raw = taskCompletions?.[dateToKey(date)];
    if (typeof raw === 'number') values.push(raw);
  }
  return values.length === 0 ? null : average(values);
}

/** Per-task daily completion series over the last `windowDays` - the task-level equivalent of
 * getOverallConsistency's series (analytics.js), which is routine-level. Powers the Overview
 * screen's Habit Heatmap once toggled from "Routines" to "Tasks". */
export function getTaskHeatmapSeries(task, taskVersionsMap, completions, windowDays, reschedulesMap = {}) {
  const versions = taskVersionsMap[task.id];
  const taskCompletions = completions[task.id] || {};
  const reschedules = reschedulesMap[task.id] || [];
  return lastNDates(windowDays).map((date) => {
    if (!versions) return { date: dateToKey(date), pct: null, met: false };
    const fraction = getTaskFraction(versions, taskCompletions, date, reschedules);
    if (fraction === null) return { date: dateToKey(date), pct: null, met: false };
    return { date: dateToKey(date), pct: Math.round(fraction * 100), met: fraction === 1 };
  });
}

/** { exerciseId: category } from the exercise repository rows storage.js's getExerciseNames()
 * now returns (id/name/category) - built once per relevant screen, same "load once, pass down"
 * pattern as taskVersionsMap. */
export function buildExerciseCategoryMap(exerciseRepoRows) {
  const map = {};
  for (const row of exerciseRepoRows || []) {
    if (row.category) map[row.id] = row.category;
  }
  return map;
}

/** The most common category among a workout task's own exercises (falling back to
 * inferExerciseCategory for any exercise whose repository row has no category set yet) - used to
 * decide which metric set a Workout Detail card shows. Ties break toward whichever category was
 * seen first, which in practice just means "the first exercise's category" for a 2-exercise tie -
 * an edge case not worth a more elaborate rule. */
export function getTaskDominantCategory(task, exerciseCategoryById) {
  const exercises = task.exercises || [];
  if (exercises.length === 0) return null;
  const counts = new Map();
  for (const exercise of exercises) {
    const category = exerciseCategoryById[exercise.exerciseId] || inferExerciseCategory(exercise);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [category, count] of counts) {
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return best;
}

/** Total logged duration grouped by each exercise's own `focusArea` tag (a task-instance field,
 * distinct from the repository-level `category` above) - powers "Top Areas"/"Top Focus Areas" for
 * Stretch & Mobility / Yoga workout tasks. An exercise with no focusArea set (or that's never
 * actually been logged) is grouped under "Untagged" rather than silently dropped, sorted
 * descending by total time. `logsForTask` is `workoutLogsByTask[task.id]` - date-first
 * (`{ [date]: { [exerciseId]: [sets] } }`, storage.js's getAllWorkoutLogs), the same shape
 * utils/workouts.js's getWorkoutStats flattens per exercise. */
export function getFocusAreaBreakdown(task, logsForTask) {
  const totals = new Map();
  const logsByDate = logsForTask || {};
  for (const exercise of task.exercises || []) {
    const label = exercise.focusArea?.trim() || 'Untagged';
    const sets = Object.values(logsByDate).flatMap((byExerciseId) => byExerciseId[exercise.id] || []);
    const seconds = sets.reduce((sum, s) => (s.completed && s.durationSeconds ? sum + s.durationSeconds : sum), 0);
    if (seconds === 0) continue;
    totals.set(label, (totals.get(label) || 0) + seconds);
  }
  return Array.from(totals.entries())
    .map(([label, seconds]) => ({ label, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

/**
 * Bundles everything the Analytics 2 Overview screen needs into one call, the same "one entry
 * point per screen" shape getDashboardStats already established for the original Dashboard.
 * `completionTimestamps` is storage.js's getCompletionTimestamps() result.
 */
export function getAnalyticsV2Overview(routines, taskVersionsMap, completions, completionTimestamps, reschedulesMap, range) {
  const base = getDashboardStats(routines, taskVersionsMap, completions, range, reschedulesMap);
  const dates = datesForRange(range, routines);
  const totals = getPeriodTotals(routines, taskVersionsMap, completions, dates, reschedulesMap);
  const dayOfWeek = buildDayOfWeekBreakdown(routines, taskVersionsMap, completions, dates, reschedulesMap);
  const { best: bestDay, weakest: weakestDay } = bestAndWeakestDay(dayOfWeek);
  const onTime = getOverallOnTimeRate(routines, taskVersionsMap, completions, completionTimestamps, dates, reschedulesMap);
  const completionRateDelta = getCompletionRateDelta(routines, taskVersionsMap, completions, range, reschedulesMap);

  return {
    ...base,
    ...totals,
    dayOfWeek,
    bestDay,
    weakestDay,
    onTimeRate: onTime.pct,
    completionRateDelta,
  };
}
