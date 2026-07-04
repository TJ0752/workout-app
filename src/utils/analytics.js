import {
  DAY_LABELS,
  calcRoutineStreak,
  calcLongestRoutineStreak,
  getRoutineFraction,
  getTaskFraction,
  startOfDay,
  lastNDates,
  dateToKey,
} from './date.js';

function datesBetween(start, end) {
  const dates = [];
  const cursor = startOfDay(start);
  const last = startOfDay(end);
  while (cursor <= last) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function rangeStartDate(range, routines, today) {
  if (range === 'week') {
    const d = new Date(today);
    d.setDate(d.getDate() - 6);
    return d;
  }
  if (range === 'month') {
    const d = new Date(today);
    d.setDate(d.getDate() - 29);
    return d;
  }
  if (routines.length === 0) return today;
  return routines.reduce((min, r) => {
    const created = new Date(r.createdAt);
    return created < min ? created : min;
  }, new Date(routines[0].createdAt));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function average(fractions) {
  if (fractions.length === 0) return null;
  return fractions.reduce((sum, f) => sum + f, 0) / fractions.length;
}

function routineFractionsOverDates(routine, taskVersionsMap, completions, dates) {
  return dates
    .map((d) => getRoutineFraction(routine, taskVersionsMap, completions, d))
    .filter((f) => f !== null);
}

function bucketPct(routines, taskVersionsMap, completions, dates) {
  const all = [];
  for (const routine of routines) {
    all.push(...routineFractionsOverDates(routine, taskVersionsMap, completions, dates));
  }
  const avg = average(all);
  return avg === null ? null : Math.round(avg * 100);
}

function buildTrend(routines, taskVersionsMap, completions, dates, range) {
  if (range === 'week') {
    return dates.map((date) => ({
      label: date.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2),
      pct: bucketPct(routines, taskVersionsMap, completions, [date]),
    }));
  }

  if (range === 'month') {
    return chunkArray(dates, 7).map((chunk, index) => ({
      label: `Wk${index + 1}`,
      pct: bucketPct(routines, taskVersionsMap, completions, chunk),
    }));
  }

  const byMonth = new Map();
  for (const date of dates) {
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(date);
  }
  return Array.from(byMonth.values()).map((monthDates) => ({
    label: monthDates[0].toLocaleDateString(undefined, { month: 'short' }),
    pct: bucketPct(routines, taskVersionsMap, completions, monthDates),
  }));
}

function buildDayOfWeekBreakdown(routines, taskVersionsMap, completions, dates) {
  const buckets = Array.from({ length: 7 }, () => []);
  for (const date of dates) {
    for (const routine of routines) {
      const fraction = getRoutineFraction(routine, taskVersionsMap, completions, date);
      if (fraction !== null) buckets[date.getDay()].push(fraction);
    }
  }
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.map((dow) => {
    const avg = average(buckets[dow]);
    return { label: DAY_LABELS[dow], pct: avg === null ? null : Math.round(avg * 100) };
  });
}

function taskStatsOverDates(task, taskVersionsMap, completions, dates) {
  const versions = taskVersionsMap[task.id];
  if (!versions) return { task, pct: null, due: 0, completed: 0 };

  const taskCompletions = completions[task.id] || {};
  const fractions = dates.map((d) => getTaskFraction(versions, taskCompletions, d));
  const dueFractions = fractions.filter((f) => f !== null);
  const due = dueFractions.length;
  const avg = average(dueFractions);
  const completed = dueFractions.filter((f) => f === 1).length;

  return { task, pct: avg === null ? null : Math.round(avg * 100), due, completed };
}

function routineStatsOverDates(routine, taskVersionsMap, completions, dates) {
  const routineFractions = routineFractionsOverDates(routine, taskVersionsMap, completions, dates);
  const due = routineFractions.length;
  const avg = average(routineFractions);
  const completed = routineFractions.filter((f) => f === 1).length;

  return {
    routine,
    due,
    completed,
    pct: avg === null ? null : Math.round(avg * 100),
    streak: calcRoutineStreak(routine, taskVersionsMap, completions),
    tasks: routine.tasks.map((task) => taskStatsOverDates(task, taskVersionsMap, completions, dates)),
  };
}

/**
 * How many of the last `windowDays` due-days had an overall completion at or above
 * `thresholdFraction` - a softer, more forgiving read on reliability than a streak's
 * all-or-nothing 100% requirement. A routine set sitting at a steady 80% every day scores well
 * here even though it never posts a single "complete" day for the streak counter. Also returns
 * the day-by-day series itself so a threshold chart can render each day's bar.
 */
export function getOverallConsistency(routines, taskVersionsMap, completions, thresholdFraction = 0.5, windowDays = 21) {
  const dates = lastNDates(windowDays);
  const series = [];
  let daysMet = 0;
  let totalDueDays = 0;
  for (const date of dates) {
    const pct = bucketPct(routines, taskVersionsMap, completions, [date]);
    if (pct === null) continue;
    totalDueDays += 1;
    const met = pct / 100 >= thresholdFraction;
    if (met) daysMet += 1;
    series.push({ date: dateToKey(date), pct, met });
  }
  return {
    daysMet,
    totalDueDays,
    pct: totalDueDays === 0 ? 0 : Math.round((daysMet / totalDueDays) * 100),
    series,
  };
}

/** Best all-time streak across every routine, not just each one's live streak - the dashboard
 * pairs this with getDashboardStats's existing bestStreak (current) the same way a fitness PR
 * badge sits next to a live progress number. */
export function getLongestOverallStreak(routines, taskVersionsMap, completions) {
  return routines.reduce((max, r) => Math.max(max, calcLongestRoutineStreak(r, taskVersionsMap, completions)), 0);
}

export function getDashboardStats(routines, taskVersionsMap, completions, range) {
  const today = new Date();
  const start = rangeStartDate(range, routines, today);
  const dates = datesBetween(start, today);

  const perRoutine = routines.map((routine) => routineStatsOverDates(routine, taskVersionsMap, completions, dates));

  let totalCompletedTaskDays = 0;
  for (const routine of routines) {
    for (const task of routine.tasks) {
      const versions = taskVersionsMap[task.id];
      if (!versions) continue;
      const taskCompletions = completions[task.id] || {};
      totalCompletedTaskDays += dates.filter(
        (d) => getTaskFraction(versions, taskCompletions, d) === 1
      ).length;
    }
  }

  const overallPct = bucketPct(routines, taskVersionsMap, completions, dates);
  const bestStreak = perRoutine.reduce((max, r) => Math.max(max, r.streak), 0);
  const longestStreak = getLongestOverallStreak(routines, taskVersionsMap, completions);
  const consistency = getOverallConsistency(routines, taskVersionsMap, completions);

  const ranked = perRoutine.filter((r) => r.due > 0).sort((a, b) => b.pct - a.pct);

  return {
    completionRate: overallPct === null ? 0 : overallPct,
    bestStreak,
    longestStreak,
    consistency,
    totalCompleted: totalCompletedTaskDays,
    perRoutine: ranked,
    topRoutine: ranked[0] || null,
    needsAttention: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    trend: buildTrend(routines, taskVersionsMap, completions, dates, range),
    dayOfWeek: range === 'week' ? null : buildDayOfWeekBreakdown(routines, taskVersionsMap, completions, dates),
  };
}
