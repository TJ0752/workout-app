import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bestAndWeakestDay,
  buildExerciseCategoryMap,
  datesForRange,
  getCompletionRateDelta,
  getFocusAreaBreakdown,
  getPeriodTotals,
  getRoutineDayOfWeekBreakdown,
  getRoutineOnTimeRate,
  getRoutineTrendSeries,
  getTaskAverageValue,
  getTaskDominantCategory,
  getTaskHeatmapSeries,
  getTaskOnTimeRate,
  makeCustomRange,
} from './analyticsV2.js';
import { dateToKey } from './date.js';

// Matches analytics.test.js's own fixed "now" (a Tuesday) so streak/version math composes the
// same way across both test files.
const FIXED_NOW = new Date(2026, 6, 7, 10, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function boolVersion(overrides = {}) {
  return {
    effectiveFrom: '2020-01-01',
    active: true,
    days: [0, 1, 2, 3, 4, 5, 6],
    completionType: 'boolean',
    time: '08:00',
    ...overrides,
  };
}

function quantityVersion(overrides = {}) {
  return {
    effectiveFrom: '2020-01-01',
    active: true,
    days: [0, 1, 2, 3, 4, 5, 6],
    completionType: 'quantity',
    target: 10,
    time: '08:00',
    ...overrides,
  };
}

function daysAgoKey(n) {
  const d = new Date(FIXED_NOW);
  d.setDate(d.getDate() - n);
  return dateToKey(d);
}

function daysAgoIso(n, hour, minute) {
  const d = new Date(FIXED_NOW);
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

describe('datesForRange / makeCustomRange', () => {
  it('a custom range starts at the given date and always runs through today', () => {
    const dates = datesForRange(makeCustomRange(daysAgoKey(3)), []);
    expect(dates).toHaveLength(4);
    expect(dateToKey(dates[0])).toBe(daysAgoKey(3));
    expect(dateToKey(dates[dates.length - 1])).toBe(daysAgoKey(0));
  });
});

describe('getPeriodTotals', () => {
  it('counts due/completed routine-days and task-days over a date range', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    const taskVersionsMap = { t1: [boolVersion()] };
    const completions = { t1: { [daysAgoKey(0)]: 1, [daysAgoKey(1)]: 1 } };
    const dates = [0, 1, 2].map((n) => new Date(FIXED_NOW.getFullYear(), FIXED_NOW.getMonth(), FIXED_NOW.getDate() - n));

    const totals = getPeriodTotals([routine], taskVersionsMap, completions, dates);
    expect(totals).toEqual({ routinesDue: 3, routinesCompleted: 2, tasksDue: 3, tasksCompleted: 2 });
  });
});

describe('getRoutineDayOfWeekBreakdown / bestAndWeakestDay', () => {
  it('scopes the breakdown to one routine and identifies best/weakest days', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    const taskVersionsMap = { t1: [boolVersion()] };
    const completions = { t1: {} };
    // Complete every day except 2 days ago.
    for (let i = 0; i < 7; i++) {
      if (i !== 2) completions.t1[daysAgoKey(i)] = 1;
    }
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(FIXED_NOW);
      d.setDate(d.getDate() - i);
      return d;
    });

    const breakdown = getRoutineDayOfWeekBreakdown(routine, taskVersionsMap, completions, dates);
    const { best, weakest } = bestAndWeakestDay(breakdown);
    expect(best.pct).toBe(100);
    expect(weakest.pct).toBe(0);
  });
});

describe('getCompletionRateDelta', () => {
  it('is null for the all-time range', () => {
    expect(getCompletionRateDelta([], {}, {}, 'all')).toBeNull();
  });

  it('compares the current period against the immediately preceding period of the same length', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    const taskVersionsMap = { t1: [boolVersion()] };
    const completions = { t1: {} };
    // This week (days 0-6 ago): complete every day. Last week (days 7-13 ago): never complete.
    for (let i = 0; i <= 6; i++) completions.t1[daysAgoKey(i)] = 1;

    const delta = getCompletionRateDelta([routine], taskVersionsMap, completions, 'week');
    expect(delta).toBe(100);
  });
});

describe('getTaskOnTimeRate / getRoutineOnTimeRate', () => {
  it('counts a completion on-time only when logged at or before the due time', () => {
    const versions = [boolVersion({ time: '08:00' })];
    const completions = { [daysAgoKey(0)]: 1, [daysAgoKey(1)]: 1 };
    const timestamps = {
      [daysAgoKey(0)]: daysAgoIso(0, 7, 30), // on time
      [daysAgoKey(1)]: daysAgoIso(1, 9, 0), // late
    };
    const dates = [0, 1].map((n) => new Date(FIXED_NOW.getFullYear(), FIXED_NOW.getMonth(), FIXED_NOW.getDate() - n));

    const result = getTaskOnTimeRate(versions, completions, timestamps, dates);
    expect(result).toEqual({ due: 2, onTime: 1, pct: 50 });
  });

  it('excludes days with no captured completion timestamp from both due and onTime', () => {
    const versions = [boolVersion({ time: '08:00' })];
    const completions = { [daysAgoKey(0)]: 1 };
    const dates = [new Date(FIXED_NOW)];
    const result = getTaskOnTimeRate(versions, completions, {}, dates);
    expect(result).toEqual({ due: 0, onTime: 0, pct: null });
  });

  it('aggregates on-time rate across every task in a routine', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }, { id: 't2' }] };
    const taskVersionsMap = { t1: [boolVersion({ time: '08:00' })], t2: [boolVersion({ time: '08:00' })] };
    const completions = { t1: { [daysAgoKey(0)]: 1 }, t2: { [daysAgoKey(0)]: 1 } };
    const completionTimestamps = {
      t1: { [daysAgoKey(0)]: daysAgoIso(0, 7, 0) },
      t2: { [daysAgoKey(0)]: daysAgoIso(0, 9, 0) },
    };
    const dates = [new Date(FIXED_NOW)];
    const result = getRoutineOnTimeRate(routine, taskVersionsMap, completions, completionTimestamps, dates);
    expect(result).toEqual({ due: 2, onTime: 1, pct: 50 });
  });
});

describe('getRoutineTrendSeries', () => {
  it('produces one daily entry per date, null where nothing was due', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    const taskVersionsMap = { t1: [boolVersion()] };
    const completions = { t1: { [daysAgoKey(0)]: 1 } };
    const dates = [1, 0].map((n) => {
      const d = new Date(FIXED_NOW);
      d.setDate(d.getDate() - n);
      return d;
    });
    const series = getRoutineTrendSeries(routine, taskVersionsMap, completions, dates);
    expect(series).toEqual([
      { date: daysAgoKey(1), pct: 0 },
      { date: daysAgoKey(0), pct: 100 },
    ]);
  });
});

describe('getTaskAverageValue', () => {
  it('averages logged values only over due days', () => {
    const versions = [quantityVersion({ target: 10 })];
    const completions = { [daysAgoKey(0)]: 4, [daysAgoKey(1)]: 6 };
    const dates = [0, 1].map((n) => new Date(FIXED_NOW.getFullYear(), FIXED_NOW.getMonth(), FIXED_NOW.getDate() - n));
    expect(getTaskAverageValue(versions, completions, dates)).toBe(5);
  });

  it('is null when nothing was due', () => {
    const versions = [quantityVersion({ active: false })];
    const dates = [new Date(FIXED_NOW)];
    expect(getTaskAverageValue(versions, {}, dates)).toBeNull();
  });
});

describe('getTaskHeatmapSeries', () => {
  it('marks days as met/not-met/nothing-due across the window', () => {
    const task = { id: 't1' };
    const taskVersionsMap = { t1: [boolVersion()] };
    const completions = { t1: { [daysAgoKey(0)]: 1 } };
    const series = getTaskHeatmapSeries(task, taskVersionsMap, completions, 2);
    expect(series).toHaveLength(2);
    expect(series[series.length - 1]).toEqual({ date: daysAgoKey(0), pct: 100, met: true });
  });
});

describe('buildExerciseCategoryMap', () => {
  it('maps exercise repository rows by id, skipping rows with no category', () => {
    const rows = [
      { id: 'e1', name: 'Bench', category: 'strength' },
      { id: 'e2', name: 'Mystery', category: null },
    ];
    expect(buildExerciseCategoryMap(rows)).toEqual({ e1: 'strength' });
  });
});

describe('getTaskDominantCategory', () => {
  it('picks the most common category among a task\'s exercises, falling back to inference', () => {
    const task = {
      exercises: [
        { exerciseId: 'e1', type: 'weights', unit: 'reps' },
        { exerciseId: 'e2', type: 'weights', unit: 'reps' },
        { exerciseId: 'e3', type: 'calisthenics', unit: 'reps' },
      ],
    };
    const categoryMap = { e1: 'strength', e2: 'strength' }; // e3 has no repo category - infers 'bodyweight'
    expect(getTaskDominantCategory(task, categoryMap)).toBe('strength');
  });

  it('is null for a task with no exercises', () => {
    expect(getTaskDominantCategory({ exercises: [] }, {})).toBeNull();
  });
});

describe('getFocusAreaBreakdown', () => {
  // logsForTask is workoutLogsByTask[task.id] - date-first ({ [date]: { [exerciseId]: [sets] } },
  // storage.js's getAllWorkoutLogs), not a flat { [exerciseId]: [sets] } map.
  it('sums logged duration per focusArea tag, sorted descending', () => {
    const task = {
      exercises: [
        { id: 'ex1', focusArea: 'Hamstrings' },
        { id: 'ex2', focusArea: 'Shoulders' },
        { id: 'ex3', focusArea: null },
      ],
    };
    const logsForTask = {
      '2026-07-01': { ex1: [{ completed: true, durationSeconds: 40 }], ex2: [{ completed: true, durationSeconds: 30 }] },
      '2026-07-02': { ex1: [{ completed: true, durationSeconds: 20 }], ex3: [{ completed: true, durationSeconds: 45 }] },
    };
    expect(getFocusAreaBreakdown(task, logsForTask)).toEqual([
      { label: 'Hamstrings', seconds: 60 },
      { label: 'Untagged', seconds: 45 },
      { label: 'Shoulders', seconds: 30 },
    ]);
  });

  it('excludes exercises with nothing logged', () => {
    const task = { exercises: [{ id: 'ex1', focusArea: 'Balance' }] };
    expect(getFocusAreaBreakdown(task, {})).toEqual([]);
  });
});
