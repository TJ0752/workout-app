import { DAY_LABELS, calcStreak, dateToKey, isDueOn } from './date';

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

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

function bucketPct(routines, completions, dates) {
  let due = 0;
  let done = 0;
  for (const routine of routines) {
    const doneMap = completions[routine.id] || {};
    for (const date of dates) {
      if (isDueOn(routine, date)) {
        due += 1;
        if (doneMap[dateToKey(date)]) done += 1;
      }
    }
  }
  return due ? Math.round((done / due) * 100) : null;
}

function buildTrend(routines, completions, dates, range) {
  if (range === 'week') {
    return dates.map((date) => ({
      label: date.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2),
      pct: bucketPct(routines, completions, [date]),
    }));
  }

  if (range === 'month') {
    return chunkArray(dates, 7).map((chunk, index) => ({
      label: `Wk${index + 1}`,
      pct: bucketPct(routines, completions, chunk),
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
    pct: bucketPct(routines, completions, monthDates),
  }));
}

function buildDayOfWeekBreakdown(routines, completions, dates) {
  const buckets = Array.from({ length: 7 }, () => ({ due: 0, done: 0 }));
  for (const routine of routines) {
    const doneMap = completions[routine.id] || {};
    for (const date of dates) {
      if (isDueOn(routine, date)) {
        const dow = date.getDay();
        buckets[dow].due += 1;
        if (doneMap[dateToKey(date)]) buckets[dow].done += 1;
      }
    }
  }
  // Reorder to start on Monday for readability, matching how weeks read left-to-right.
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.map((dow) => ({
    label: DAY_LABELS[dow],
    pct: buckets[dow].due ? Math.round((buckets[dow].done / buckets[dow].due) * 100) : null,
  }));
}

export function getDashboardStats(routines, completions, range) {
  const today = new Date();
  const start = rangeStartDate(range, routines, today);
  const dates = datesBetween(start, today);

  let totalDue = 0;
  let totalCompleted = 0;
  const perRoutine = routines.map((routine) => {
    const doneMap = completions[routine.id] || {};
    const dueDates = dates.filter((date) => isDueOn(routine, date));
    const completedDates = dueDates.filter((date) => doneMap[dateToKey(date)]);
    totalDue += dueDates.length;
    totalCompleted += completedDates.length;
    return {
      routine,
      due: dueDates.length,
      completed: completedDates.length,
      pct: dueDates.length ? Math.round((completedDates.length / dueDates.length) * 100) : null,
      streak: calcStreak(routine, completions),
    };
  });

  const ranked = perRoutine.filter((r) => r.due > 0).sort((a, b) => b.pct - a.pct);
  const completionRate = totalDue ? Math.round((totalCompleted / totalDue) * 100) : 0;
  const bestStreak = perRoutine.reduce((max, r) => Math.max(max, r.streak), 0);

  return {
    completionRate,
    bestStreak,
    totalCompleted,
    perRoutine: ranked,
    topRoutine: ranked[0] || null,
    needsAttention: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    trend: buildTrend(routines, completions, dates, range),
    dayOfWeek: range === 'week' ? null : buildDayOfWeekBreakdown(routines, completions, dates),
  };
}
