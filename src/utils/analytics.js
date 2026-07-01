import {
  DAY_LABELS,
  calcRoutineStreak,
  getRoutineFraction,
  getTaskFraction,
  startOfDay,
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

  const ranked = perRoutine.filter((r) => r.due > 0).sort((a, b) => b.pct - a.pct);

  return {
    completionRate: overallPct === null ? 0 : overallPct,
    bestStreak,
    totalCompleted: totalCompletedTaskDays,
    perRoutine: ranked,
    topRoutine: ranked[0] || null,
    needsAttention: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    trend: buildTrend(routines, taskVersionsMap, completions, dates, range),
    dayOfWeek: range === 'week' ? null : buildDayOfWeekBreakdown(routines, taskVersionsMap, completions, dates),
  };
}
