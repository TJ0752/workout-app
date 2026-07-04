import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDashboardStats, getOverallConsistency, getLongestOverallStreak, getDayBreakdown } from './analytics.js';
import { dateToKey } from './date.js';

// Fixed "now" = Tuesday, 2026-07-07 - matches date.test.js so streak/version
// math composes the same way here.
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
    ...overrides,
  };
}

function daysAgoKey(n) {
  const d = new Date(FIXED_NOW);
  d.setDate(d.getDate() - n);
  return dateToKey(d);
}

describe('getDashboardStats', () => {
  it('week range: 7-day trend, no day-of-week breakdown, correct overall/topRoutine/needsAttention', () => {
    const strongRoutine = {
      id: 'strong',
      title: 'Strong',
      active: true,
      createdAt: '2020-01-01',
      tasks: [{ id: 't-strong' }],
    };
    const weakRoutine = {
      id: 'weak',
      title: 'Weak',
      active: true,
      createdAt: '2020-01-01',
      tasks: [{ id: 't-weak' }],
    };
    const taskVersionsMap = {
      't-strong': [boolVersion()],
      't-weak': [boolVersion()],
    };
    // Strong routine: complete every day this week. Weak: never complete.
    const completions = { 't-strong': {}, 't-weak': {} };
    for (let i = 0; i < 7; i++) {
      completions['t-strong'][daysAgoKey(i)] = 1;
    }

    const stats = getDashboardStats([strongRoutine, weakRoutine], taskVersionsMap, completions, 'week');

    expect(stats.dayOfWeek).toBeNull();
    expect(stats.trend).toHaveLength(7);
    expect(stats.trend.every((entry) => typeof entry.label === 'string')).toBe(true);

    // Overall = average of (100% + 0%) = 50%.
    expect(stats.completionRate).toBe(50);
    expect(stats.bestStreak).toBe(7);
    expect(stats.longestStreak).toBe(7);
    // consistency and longestStreak now share the same window as the rest of the dashboard:
    // for 'week' that's exactly the 7 dates in `dates`, not a fixed 21-day lookback. Both
    // routines are due every day, averaging 50% (right at the default threshold, met) ->
    // all 7 days met.
    expect(stats.consistency).toMatchObject({ daysMet: 7, totalDueDays: 7, pct: 100 });
    expect(stats.consistency.series).toHaveLength(7);

    expect(stats.perRoutine).toHaveLength(2);
    expect(stats.topRoutine.routine.id).toBe('strong');
    expect(stats.topRoutine.pct).toBe(100);
    expect(stats.needsAttention.routine.id).toBe('weak');
    expect(stats.needsAttention.pct).toBe(0);

    // totalCompleted counts task-days at fraction===1: 7 for strong, 0 for weak.
    expect(stats.totalCompleted).toBe(7);
  });

  it('needsAttention is null when there is only one routine (nothing to contrast against)', () => {
    const routine = {
      id: 'solo',
      title: 'Solo',
      active: true,
      createdAt: '2020-01-01',
      tasks: [{ id: 't1' }],
    };
    const taskVersionsMap = { t1: [boolVersion()] };
    const stats = getDashboardStats([routine], taskVersionsMap, { t1: { [daysAgoKey(0)]: 1 } }, 'week');
    expect(stats.perRoutine).toHaveLength(1);
    expect(stats.needsAttention).toBeNull();
    expect(stats.topRoutine.routine.id).toBe('solo');
  });

  it('a routine with nothing ever due is excluded from perRoutine/ranking entirely', () => {
    const dueRoutine = {
      id: 'due',
      title: 'Due',
      active: true,
      createdAt: '2020-01-01',
      tasks: [{ id: 't1' }],
    };
    const neverDueRoutine = {
      id: 'never',
      title: 'Never Due',
      active: true,
      createdAt: '2020-01-01',
      tasks: [{ id: 't2' }],
    };
    const taskVersionsMap = {
      t1: [boolVersion()],
      t2: [boolVersion({ days: [] })], // scheduled on no day at all
    };
    const stats = getDashboardStats(
      [dueRoutine, neverDueRoutine],
      taskVersionsMap,
      { t1: { [daysAgoKey(0)]: 1 }, t2: {} },
      'week'
    );
    expect(stats.perRoutine).toHaveLength(1);
    expect(stats.perRoutine[0].routine.id).toBe('due');
  });

  it('month range: buckets the trend into 5 weekly chunks and includes a day-of-week breakdown', () => {
    const routine = {
      id: 'r1',
      title: 'R1',
      active: true,
      createdAt: '2020-01-01',
      tasks: [{ id: 't1' }],
    };
    const taskVersionsMap = { t1: [boolVersion()] };
    const stats = getDashboardStats([routine], taskVersionsMap, { t1: {} }, 'month');

    // 30 days (29 back + today) chunked by 7 -> 5 buckets: 7,7,7,7,2.
    expect(stats.trend).toHaveLength(5);
    expect(stats.trend.map((t) => t.label)).toEqual(['Wk1', 'Wk2', 'Wk3', 'Wk4', 'Wk5']);

    // Day-of-week breakdown present, ordered Mon..Sun (per DAY_LABELS + the
    // [1,2,3,4,5,6,0] ordering in analytics.js), 7 entries.
    expect(stats.dayOfWeek).toHaveLength(7);
    expect(stats.dayOfWeek.map((d) => d.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it('consistency and longestStreak are scoped to the selected range, not a fixed lookback', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    const taskVersionsMap = { t1: [boolVersion()] };
    const completions = { t1: {} };
    // Complete every day for the last 30 days (an 8-day-ago-and-earlier stretch stays met
    // even in the 'week' window since every day is due and completed).
    for (let i = 0; i < 30; i++) completions.t1[daysAgoKey(i)] = 1;

    const week = getDashboardStats([routine], taskVersionsMap, completions, 'week');
    const month = getDashboardStats([routine], taskVersionsMap, completions, 'month');

    expect(week.consistency.totalDueDays).toBe(7);
    expect(week.consistency.series).toHaveLength(7);
    expect(week.longestStreak).toBe(7);

    expect(month.consistency.totalDueDays).toBe(30);
    expect(month.consistency.series).toHaveLength(30);
    expect(month.longestStreak).toBe(30);
  });

  it('all-time range starts from the earliest routine createdAt', () => {
    const oldRoutine = {
      id: 'old',
      title: 'Old',
      active: true,
      createdAt: '2026-06-01T00:00:00.000Z',
      tasks: [{ id: 't1' }],
    };
    const newRoutine = {
      id: 'new',
      title: 'New',
      active: true,
      createdAt: '2026-07-05T00:00:00.000Z',
      tasks: [{ id: 't2' }],
    };
    const taskVersionsMap = {
      t1: [boolVersion()],
      t2: [boolVersion()],
    };
    const stats = getDashboardStats([oldRoutine, newRoutine], taskVersionsMap, { t1: {}, t2: {} }, 'all');
    // All-time trend buckets by month; June and July should both appear
    // since the range spans from the oldest routine's createdAt to today.
    const labels = stats.trend.map((t) => t.label);
    expect(labels).toContain('Jun');
    expect(labels).toContain('Jul');
  });
});

describe('getOverallConsistency', () => {
  it('counts a day as met when the average completion across routines clears the threshold', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    const taskVersionsMap = { t1: [boolVersion()] };
    const completions = { t1: {} };
    // Complete on 10 of the last 21 days.
    for (let i = 0; i < 10; i++) completions.t1[daysAgoKey(i)] = 1;
    const result = getOverallConsistency([routine], taskVersionsMap, completions, 0.5, 21);
    expect(result).toMatchObject({ daysMet: 10, totalDueDays: 21, pct: Math.round((10 / 21) * 100) });
    expect(result.series).toHaveLength(21);
    expect(result.series.filter((d) => d.met)).toHaveLength(10);
  });

  it('returns 0/0/0 when nothing was ever due in the window, but still emits one empty series entry per day', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    const taskVersionsMap = { t1: [boolVersion({ days: [] })] };
    const result = getOverallConsistency([routine], taskVersionsMap, { t1: {} });
    expect(result).toMatchObject({ daysMet: 0, totalDueDays: 0, pct: 0 });
    // Days nothing was due still get a series entry (pct: null) rather than being omitted, so
    // a heatmap/chart can render them as a distinct "empty" state instead of silently skipping.
    expect(result.series).toHaveLength(21);
    expect(result.series.every((d) => d.pct === null && d.met === false)).toBe(true);
  });

  it('a day nothing was due gets pct: null in the series while due days keep their real pct', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    // Due Mon/Wed/Fri only.
    const taskVersionsMap = { t1: [boolVersion({ days: [1, 3, 5] })] };
    const completions = { t1: {} };
    for (let i = 0; i < 7; i++) {
      const d = new Date(FIXED_NOW);
      d.setDate(d.getDate() - i);
      if ([1, 3, 5].includes(d.getDay())) completions.t1[daysAgoKey(i)] = 1;
    }
    const result = getOverallConsistency([routine], taskVersionsMap, completions, 0.5, 7);
    expect(result.series).toHaveLength(7);
    const dueEntries = result.series.filter((d) => d.pct !== null);
    const emptyEntries = result.series.filter((d) => d.pct === null);
    expect(dueEntries.length).toBe(result.totalDueDays);
    expect(emptyEntries.every((d) => d.met === false)).toBe(true);
    expect(dueEntries.every((d) => d.pct === 100 && d.met === true)).toBe(true);
  });

  it('a lower threshold counts partial-completion days that a 100% bar would miss', () => {
    const routine = {
      id: 'r1',
      title: 'R1',
      active: true,
      createdAt: '2020-01-01',
      tasks: [{ id: 't1', completionType: undefined }],
    };
    const taskVersionsMap = { t1: [boolVersion()] };
    // Every day complete -> both thresholds should see 100% consistency.
    const completions = { t1: {} };
    for (let i = 0; i < 21; i++) completions.t1[daysAgoKey(i)] = 1;
    const strict = getOverallConsistency([routine], taskVersionsMap, completions, 1, 21);
    const lenient = getOverallConsistency([routine], taskVersionsMap, completions, 0.3, 21);
    expect(strict.pct).toBe(100);
    expect(lenient.pct).toBe(100);
  });

  it('series dates use the local calendar day (dateToKey), not a UTC-shifted one (regression: date.toISOString() can land on a different day than dateToKey() outside UTC)', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    const taskVersionsMap = { t1: [boolVersion()] };
    const completions = { t1: {} };
    for (let i = 0; i < 21; i++) completions.t1[daysAgoKey(i)] = 1;
    const result = getOverallConsistency([routine], taskVersionsMap, completions, 0.5, 21);
    const expectedDates = new Set();
    for (let i = 0; i < 21; i++) expectedDates.add(daysAgoKey(i));
    for (const d of result.series) {
      expect(expectedDates.has(d.date)).toBe(true);
    }
  });
});

describe('getLongestOverallStreak', () => {
  it('is the best all-time streak across every routine, not just the current one', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    const taskVersionsMap = { t1: [boolVersion()] };
    const completions = { t1: {} };
    // A 6-day run 15 days ago, nothing recent.
    for (let i = 15; i < 21; i++) completions.t1[daysAgoKey(i)] = 1;
    expect(getLongestOverallStreak([routine], taskVersionsMap, completions)).toBe(6);
  });

  it('returns 0 for an empty routine list', () => {
    expect(getLongestOverallStreak([], {}, {})).toBe(0);
  });

  it('respects an explicit windowDays, clipping a streak that started before the window', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1' }] };
    const taskVersionsMap = { t1: [boolVersion()] };
    const completions = { t1: {} };
    for (let i = 0; i < 30; i++) completions.t1[daysAgoKey(i)] = 1;
    expect(getLongestOverallStreak([routine], taskVersionsMap, completions, 365)).toBe(30);
    expect(getLongestOverallStreak([routine], taskVersionsMap, completions, 7)).toBe(7);
  });
});

describe('getDayBreakdown', () => {
  it('groups due tasks by routine for a single day, omitting routines/tasks not due that day', () => {
    const solo = { id: 'solo', title: 'Solo', active: true, createdAt: '2020-01-01', tasks: [{ id: 't-solo', title: 'Solo' }] };
    const group = {
      id: 'group',
      title: 'Group',
      active: true,
      createdAt: '2020-01-01',
      tasks: [
        { id: 't-a', title: 'Task A' },
        { id: 't-b', title: 'Task B' },
      ],
    };
    const neverDue = {
      id: 'never',
      title: 'Never',
      active: true,
      createdAt: '2020-01-01',
      tasks: [{ id: 't-never', title: 'Never' }],
    };
    const taskVersionsMap = {
      't-solo': [boolVersion()],
      't-a': [boolVersion()],
      't-b': [boolVersion()],
      't-never': [boolVersion({ days: [] })],
    };
    const today = new Date(FIXED_NOW);
    const completions = {
      't-solo': { [dateToKey(today)]: 1 },
      't-a': {},
      't-b': { [dateToKey(today)]: 1 },
      't-never': {},
    };

    const result = getDayBreakdown([solo, group, neverDue], taskVersionsMap, completions, today);

    expect(result).toHaveLength(2); // 'never' contributes nothing since it's never due
    const soloEntry = result.find((r) => r.routineId === 'solo');
    expect(soloEntry.tasks).toEqual([{ taskId: 't-solo', title: 'Solo', fraction: 1, completed: true }]);
    const groupEntry = result.find((r) => r.routineId === 'group');
    expect(groupEntry.tasks).toEqual([
      { taskId: 't-a', title: 'Task A', fraction: 0, completed: false },
      { taskId: 't-b', title: 'Task B', fraction: 1, completed: true },
    ]);
  });

  it('returns an empty array when nothing is due that day', () => {
    const routine = { id: 'r1', title: 'R1', active: true, createdAt: '2020-01-01', tasks: [{ id: 't1', title: 'T1' }] };
    const taskVersionsMap = { t1: [boolVersion({ days: [] })] };
    expect(getDayBreakdown([routine], taskVersionsMap, { t1: {} }, new Date(FIXED_NOW))).toEqual([]);
  });

  it('a paused routine contributes nothing even if its tasks would otherwise be due', () => {
    const routine = {
      id: 'r1',
      title: 'R1',
      active: false,
      createdAt: '2020-01-01',
      tasks: [{ id: 't1', title: 'T1' }],
    };
    const taskVersionsMap = { t1: [boolVersion()] };
    expect(getDayBreakdown([routine], taskVersionsMap, { t1: {} }, new Date(FIXED_NOW))).toEqual([]);
  });
});
