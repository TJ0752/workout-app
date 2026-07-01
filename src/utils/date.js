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

export function isDueOn(routine, date) {
  return routine.active && routine.days.includes(date.getDay());
}

export function isDueToday(routine) {
  return isDueOn(routine, new Date());
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

export function calcStreak(routine, completions) {
  const done = completions[routine.id] || {};
  let streak = 0;
  const cursor = new Date();
  for (let i = 0; i < 365; i++) {
    if (!isDueOn(routine, cursor)) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    const key = dateToKey(cursor);
    if (done[key]) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else if (key === todayKey()) {
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

export function calcCompletionRate(routine, completions, windowDays = 30) {
  const done = completions[routine.id] || {};
  const dates = lastNDates(windowDays);
  const dueDates = dates.filter((d) => isDueOn(routine, d));
  if (dueDates.length === 0) return 0;
  const completed = dueDates.filter((d) => done[dateToKey(d)]).length;
  return Math.round((completed / dueDates.length) * 100);
}
