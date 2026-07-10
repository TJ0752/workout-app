import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calcRoutineCompletionRate,
  calcRoutineStreak,
  calcLongestRoutineStreak,
  dateToKey,
  findEffectiveVersion,
  getRoutineFraction,
  getTaskFraction,
  isRoutineDueToday,
  lastNDates,
  startOfDay,
  todayKey,
  todayWeekday,
} from './date.js';

// Fixed "now" = Tuesday, 2026-07-07, 10:00 local time - deterministic weekday
// and a known point-in-time for streak/version-cutover math.
const FIXED_NOW = new Date(2026, 6, 7, 10, 0, 0);
const TUESDAY = FIXED_NOW.getDay(); // 2

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dateToKey', () => {
  it('formats as zero-padded YYYY-MM-DD', () => {
    expect(dateToKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(dateToKey(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('todayKey / todayWeekday', () => {
  it('reflect the current system date', () => {
    expect(todayKey()).toBe('2026-07-07');
    expect(todayWeekday()).toBe(TUESDAY);
  });
});

describe('startOfDay', () => {
  it('zeroes out the time-of-day', () => {
    const d = startOfDay(new Date(2026, 5, 15, 23, 59, 59));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(15);
  });
});

describe('lastNDates', () => {
  it('returns n dates ending today, oldest first', () => {
    const dates = lastNDates(5);
    expect(dates).toHaveLength(5);
    expect(dateToKey(dates[dates.length - 1])).toBe(todayKey());
    expect(dateToKey(dates[0])).toBe('2026-07-03');
  });
});

describe('findEffectiveVersion', () => {
  it('returns null when every version starts after the given date', () => {
    const versions = [{ effectiveFrom: '2026-07-10', id: 'v1' }];
    expect(findEffectiveVersion(versions, new Date(2026, 6, 5))).toBeNull();
  });

  it('picks the latest version whose effectiveFrom is <= the date (day-granular cutover)', () => {
    const versions = [
      { effectiveFrom: '2026-06-01', id: 'v1' },
      { effectiveFrom: '2026-07-01', id: 'v2' },
      { effectiveFrom: '2026-07-10', id: 'v3' },
    ];
    // Exactly on the cutover day -> the new version applies that same day.
    expect(findEffectiveVersion(versions, new Date(2026, 6, 1)).id).toBe('v2');
    // Day before cutover -> old version still applies.
    expect(findEffectiveVersion(versions, new Date(2026, 5, 30)).id).toBe('v1');
    // Between v2 and v3 -> v2 still applies.
    expect(findEffectiveVersion(versions, new Date(2026, 6, 9)).id).toBe('v2');
    // On/after v3's day -> v3 applies.
    expect(findEffectiveVersion(versions, new Date(2026, 6, 10)).id).toBe('v3');
    expect(findEffectiveVersion(versions, new Date(2026, 6, 15)).id).toBe('v3');
  });

  it('ignores time-of-day, only the calendar day matters', () => {
    const versions = [{ effectiveFrom: '2026-07-07T23:59:00', id: 'v1' }];
    // Same calendar day, even though effectiveFrom's clock time is later than
    // the queried date's clock time.
    expect(findEffectiveVersion(versions, new Date(2026, 6, 7, 0, 0)).id).toBe('v1');
  });
});

function boolVersion(overrides = {}) {
  return {
    effectiveFrom: '2026-01-01',
    active: true,
    days: [0, 1, 2, 3, 4, 5, 6],
    completionType: 'boolean',
    ...overrides,
  };
}

describe('getTaskFraction', () => {
  it('returns null if no version is effective yet', () => {
    const versions = [{ effectiveFrom: '2099-01-01', active: true, days: [TUESDAY], completionType: 'boolean' }];
    expect(getTaskFraction(versions, {}, FIXED_NOW)).toBeNull();
  });

  it('returns null if the effective version is inactive (paused)', () => {
    const versions = [boolVersion({ active: false })];
    expect(getTaskFraction(versions, {}, FIXED_NOW)).toBeNull();
  });

  it('returns null if the day of week is not scheduled', () => {
    const versions = [boolVersion({ days: [(TUESDAY + 1) % 7] })];
    expect(getTaskFraction(versions, {}, FIXED_NOW)).toBeNull();
  });

  describe('boolean completionType', () => {
    it('is 1 when a truthy value is recorded, 0 otherwise', () => {
      const versions = [boolVersion()];
      expect(getTaskFraction(versions, { [todayKey()]: 1 }, FIXED_NOW)).toBe(1);
      expect(getTaskFraction(versions, {}, FIXED_NOW)).toBe(0);
      expect(getTaskFraction(versions, { [todayKey()]: 0 }, FIXED_NOW)).toBe(0);
    });
  });

  describe('quantity completionType', () => {
    it('divides actual by target, clamped to [0, 1]', () => {
      const versions = [boolVersion({ completionType: 'quantity', target: 10 })];
      expect(getTaskFraction(versions, { [todayKey()]: 5 }, FIXED_NOW)).toBe(0.5);
      expect(getTaskFraction(versions, { [todayKey()]: 10 }, FIXED_NOW)).toBe(1);
      // Over-target clamps to 1 rather than exceeding 100%.
      expect(getTaskFraction(versions, { [todayKey()]: 15 }, FIXED_NOW)).toBe(1);
      // No value recorded yet -> 0.
      expect(getTaskFraction(versions, {}, FIXED_NOW)).toBe(0);
    });

    it('falls back to a plain truthy/falsy check when target is 0/missing', () => {
      const versions = [boolVersion({ completionType: 'quantity', target: 0 })];
      expect(getTaskFraction(versions, { [todayKey()]: 3 }, FIXED_NOW)).toBe(1);
      expect(getTaskFraction(versions, {}, FIXED_NOW)).toBe(0);
    });
  });

  describe('workout completionType', () => {
    it('clamps the stored fraction to [0, 1]', () => {
      const versions = [boolVersion({ completionType: 'workout' })];
      expect(getTaskFraction(versions, { [todayKey()]: 0.5 }, FIXED_NOW)).toBe(0.5);
      // Clamping fix: a value >1 (e.g. extra sets logged beyond target) must
      // not blow past 100% here, same guarantee as the quantity branch.
      expect(getTaskFraction(versions, { [todayKey()]: 1.4 }, FIXED_NOW)).toBe(1);
      // A negative/garbage value clamps up to 0, not left negative.
      expect(getTaskFraction(versions, { [todayKey()]: -0.2 }, FIXED_NOW)).toBe(0);
      expect(getTaskFraction(versions, {}, FIXED_NOW)).toBe(0);
    });
  });

  describe('reschedules', () => {
    it('treats a day rescheduled away as not due, even though it is a normal scheduled day', () => {
      const versions = [boolVersion({ days: [TUESDAY] })];
      const reschedules = [{ originalDate: todayKey(), newDate: '2026-07-09' }];
      expect(getTaskFraction(versions, { [todayKey()]: 1 }, FIXED_NOW, reschedules)).toBeNull();
    });

    it('treats a day rescheduled in as due, even though it is not a normal scheduled day', () => {
      const offDay = (TUESDAY + 1) % 7;
      const versions = [boolVersion({ days: [offDay] })];
      const reschedules = [{ originalDate: '2026-07-06', newDate: todayKey() }];
      expect(getTaskFraction(versions, {}, FIXED_NOW, reschedules)).toBe(0);
      expect(getTaskFraction(versions, { [todayKey()]: 1 }, FIXED_NOW, reschedules)).toBe(1);
    });

    it('a paused task stays not-due even on a rescheduled-in day', () => {
      const versions = [boolVersion({ active: false, days: [(TUESDAY + 1) % 7] })];
      const reschedules = [{ originalDate: '2026-07-06', newDate: todayKey() }];
      expect(getTaskFraction(versions, {}, FIXED_NOW, reschedules)).toBeNull();
    });

    it('defaults to normal day-of-week behavior when no reschedules are passed', () => {
      const versions = [boolVersion()];
      expect(getTaskFraction(versions, { [todayKey()]: 1 }, FIXED_NOW)).toBe(1);
    });
  });
});

function routineWith(tasks, overrides = {}) {
  return { id: 'r1', title: 'Routine', active: true, tasks, ...overrides };
}

describe('getRoutineFraction', () => {
  it('returns null when the routine itself is paused, regardless of task state', () => {
    const routine = routineWith([{ id: 't1' }], { active: false });
    const taskVersionsMap = { t1: [boolVersion()] };
    expect(getRoutineFraction(routine, taskVersionsMap, { t1: { [todayKey()]: 1 } }, FIXED_NOW)).toBeNull();
  });

  it('returns null when none of its tasks are due that day', () => {
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [boolVersion({ days: [] })] };
    expect(getRoutineFraction(routine, taskVersionsMap, {}, FIXED_NOW)).toBeNull();
  });

  it('skips tasks with no version history entirely (not counted as 0)', () => {
    const routine = routineWith([{ id: 't1' }, { id: 't2' }]);
    const taskVersionsMap = { t1: [boolVersion()] }; // t2 has no versions at all
    const completions = { t1: { [todayKey()]: 1 } };
    expect(getRoutineFraction(routine, taskVersionsMap, completions, FIXED_NOW)).toBe(1);
  });

  it('averages the fractions of its due tasks', () => {
    const routine = routineWith([{ id: 't1' }, { id: 't2' }]);
    const taskVersionsMap = {
      t1: [boolVersion()],
      t2: [boolVersion({ completionType: 'quantity', target: 10 })],
    };
    const completions = { t1: { [todayKey()]: 1 }, t2: { [todayKey()]: 5 } };
    // (1 + 0.5) / 2
    expect(getRoutineFraction(routine, taskVersionsMap, completions, FIXED_NOW)).toBe(0.75);
  });

  it('returns null before startDate, mirroring the archivedAt cutover on the other end', () => {
    const routine = routineWith([{ id: 't1' }], { startDate: '2026-07-10' }); // 3 days from now
    const taskVersionsMap = { t1: [boolVersion()] };
    expect(getRoutineFraction(routine, taskVersionsMap, { t1: { [todayKey()]: 1 } }, FIXED_NOW)).toBeNull();
  });

  it('computes normally on and after startDate', () => {
    const routine = routineWith([{ id: 't1' }], { startDate: todayKey() });
    const taskVersionsMap = { t1: [boolVersion()] };
    expect(getRoutineFraction(routine, taskVersionsMap, { t1: { [todayKey()]: 1 } }, FIXED_NOW)).toBe(1);
  });

  it('threads a per-task reschedulesMap through to getTaskFraction', () => {
    const offDay = (TUESDAY + 1) % 7;
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [boolVersion({ days: [offDay] })] };
    const reschedulesMap = { t1: [{ originalDate: '2026-07-06', newDate: todayKey() }] };
    expect(
      getRoutineFraction(routine, taskVersionsMap, { t1: { [todayKey()]: 1 } }, FIXED_NOW, reschedulesMap)
    ).toBe(1);
  });
});

describe('isRoutineDueToday', () => {
  it('is true iff getRoutineFraction(today) is non-null', () => {
    const routine = routineWith([{ id: 't1' }]);
    const dueMap = { t1: [boolVersion()] };
    const notDueMap = { t1: [boolVersion({ days: [] })] };
    expect(isRoutineDueToday(routine, dueMap, { t1: {} })).toBe(true);
    expect(isRoutineDueToday(routine, notDueMap, { t1: {} })).toBe(false);
  });
});

describe('calcRoutineStreak', () => {
  function everyDayVersion(overrides = {}) {
    return boolVersion({ effectiveFrom: '2020-01-01', days: [0, 1, 2, 3, 4, 5, 6], ...overrides });
  }

  it('counts consecutive fully-complete days going backward from today', () => {
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [everyDayVersion()] };
    const completions = { t1: {} };
    // Complete for the last 3 days including today.
    for (let i = 0; i < 3; i++) {
      const d = new Date(FIXED_NOW);
      d.setDate(d.getDate() - i);
      completions.t1[dateToKey(d)] = 1;
    }
    expect(calcRoutineStreak(routine, taskVersionsMap, completions)).toBe(3);
  });

  it('gives today a grace exception: an incomplete today does not break the streak', () => {
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [everyDayVersion()] };
    const completions = { t1: {} };
    // Yesterday and the day before are complete; today has nothing yet.
    for (let i = 1; i <= 2; i++) {
      const d = new Date(FIXED_NOW);
      d.setDate(d.getDate() - i);
      completions.t1[dateToKey(d)] = 1;
    }
    // Today is not complete, but since it isn't over yet, streak should still
    // reflect the 2 prior complete days rather than resetting to 0.
    expect(calcRoutineStreak(routine, taskVersionsMap, completions)).toBe(2);
  });

  it('breaks the streak on a past incomplete day (grace only applies to today)', () => {
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [everyDayVersion()] };
    const completions = { t1: {} };
    completions.t1[dateToKey(FIXED_NOW)] = 1; // today complete
    // 2 days ago left incomplete -> breaks the streak before it can count
    // yesterday, since the walk goes backward day by day.
    const twoDaysAgo = new Date(FIXED_NOW);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 1);
    completions.t1[dateToKey(twoDaysAgo)] = 1; // yesterday complete
    const threeDaysAgo = new Date(FIXED_NOW);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 2);
    completions.t1[dateToKey(threeDaysAgo)] = 0; // 2 days ago incomplete -> break
    expect(calcRoutineStreak(routine, taskVersionsMap, completions)).toBe(2);
  });

  it('skips days the routine was not due at all, without breaking the streak', () => {
    // Task only scheduled on Tuesdays (today) and not on the day before.
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [everyDayVersion({ days: [TUESDAY] })] };
    const completions = { t1: { [todayKey()]: 1 } };
    const lastTuesday = new Date(FIXED_NOW);
    lastTuesday.setDate(lastTuesday.getDate() - 7);
    completions.t1[dateToKey(lastTuesday)] = 1;
    // Every day in between wasn't due, so should be skipped rather than
    // breaking the run between last Tuesday and today.
    expect(calcRoutineStreak(routine, taskVersionsMap, completions)).toBe(2);
  });
});

describe('calcLongestRoutineStreak', () => {
  function everyDayVersion(overrides = {}) {
    return boolVersion({ effectiveFrom: '2020-01-01', days: [0, 1, 2, 3, 4, 5, 6], ...overrides });
  }

  it('finds a run that has since ended, unlike calcRoutineStreak which only sees the live one', () => {
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [everyDayVersion()] };
    const completions = { t1: {} };
    // A 5-day complete run 10 days ago, then a gap, then nothing recent - the live streak is 0.
    for (let i = 10; i < 15; i++) {
      const d = new Date(FIXED_NOW);
      d.setDate(d.getDate() - i);
      completions.t1[dateToKey(d)] = 1;
    }
    expect(calcRoutineStreak(routine, taskVersionsMap, completions)).toBe(0);
    expect(calcLongestRoutineStreak(routine, taskVersionsMap, completions)).toBe(5);
  });

  it('returns the live streak itself when it is also the longest one seen', () => {
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [everyDayVersion()] };
    const completions = { t1: {} };
    for (let i = 0; i < 3; i++) {
      const d = new Date(FIXED_NOW);
      d.setDate(d.getDate() - i);
      completions.t1[dateToKey(d)] = 1;
    }
    expect(calcLongestRoutineStreak(routine, taskVersionsMap, completions)).toBe(3);
  });

  it('returns 0 when nothing was ever completed', () => {
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [everyDayVersion()] };
    expect(calcLongestRoutineStreak(routine, taskVersionsMap, { t1: {} })).toBe(0);
  });

  it('does not give today a grace exception the way the live streak does - an incomplete day just does not extend the run', () => {
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [everyDayVersion()] };
    const completions = { t1: {} };
    for (let i = 1; i <= 4; i++) {
      const d = new Date(FIXED_NOW);
      d.setDate(d.getDate() - i);
      completions.t1[dateToKey(d)] = 1;
    }
    // Today is incomplete, but the 4-day run ending yesterday is still the longest seen.
    expect(calcLongestRoutineStreak(routine, taskVersionsMap, completions)).toBe(4);
  });
});

describe('calcRoutineCompletionRate', () => {
  it('returns 0 when nothing was ever due in the window', () => {
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [boolVersion({ days: [] })] };
    expect(calcRoutineCompletionRate(routine, taskVersionsMap, { t1: {} }, 7)).toBe(0);
  });

  it('returns the rounded average percentage across due days', () => {
    const routine = routineWith([{ id: 't1' }]);
    const taskVersionsMap = { t1: [boolVersion({ effectiveFrom: '2020-01-01' })] };
    const completions = { t1: {} };
    // 1 out of 2 days complete over a 2-day window -> 50%.
    completions.t1[todayKey()] = 1;
    const yesterday = new Date(FIXED_NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    completions.t1[dateToKey(yesterday)] = 0;
    expect(calcRoutineCompletionRate(routine, taskVersionsMap, completions, 2)).toBe(50);
  });
});
