import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two Capacitor packages notifications.js talks to. `isNativePlatform`
// must return true, or every exported function in notifications.js short-
// circuits into a no-op (see the `Capacitor.isNativePlatform()` gate at the
// top of nearly every function in src/notifications.js).
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

const calls = { scheduled: [], cancelled: [], removed: [], registered: [] };

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: vi.fn(async ({ notifications }) => {
      calls.scheduled.push(...notifications);
    }),
    cancel: vi.fn(async ({ notifications }) => {
      calls.cancelled.push(...notifications);
    }),
    removeDeliveredNotifications: vi.fn(async ({ notifications }) => {
      calls.removed.push(...notifications);
    }),
    registerActionTypes: vi.fn(async ({ types }) => {
      calls.registered.push(...types);
    }),
    checkPermissions: vi.fn(async () => ({ display: 'granted' })),
    requestPermissions: vi.fn(async () => ({ display: 'granted' })),
    createChannel: vi.fn(async () => {}),
    addListener: vi.fn(),
  },
}));

import { scheduleTaskNotifications, updateRoutineGroupSummary, updateSummaryNotification } from '../notifications.js';

// Fixed "now" = Tuesday, 2026-07-07, 10:00 - same fixture used in
// utils/date.test.js, so due-time-passed / weekday logic is deterministic.
const FIXED_NOW = new Date(2026, 6, 7, 10, 0, 0);
const TUESDAY = FIXED_NOW.getDay();
const TODAY_KEY = '2026-07-07';

function resetCalls() {
  calls.scheduled.length = 0;
  calls.cancelled.length = 0;
  calls.removed.length = 0;
  calls.registered.length = 0;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  resetCalls();
});

afterEach(() => {
  vi.useRealTimers();
});

function task(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Task',
    time: '08:00',
    windowStart: '00:00',
    reminderTimes: [],
    days: [TUESDAY],
    completionType: 'boolean',
    active: true,
    ...overrides,
  };
}

describe('routine group summary', () => {
  it('creates a real groupSummary:true notification once a routine has 2+ active tasks', async () => {
    const taskA = task({ id: 'a', title: 'Stretch' });
    const taskB = task({ id: 'b', title: 'Water' });
    const routine = { id: 'routine-1', title: 'Morning', tasks: [taskA, taskB], active: true, notes: '' };

    await scheduleTaskNotifications(taskA, routine, {});
    await scheduleTaskNotifications(taskB, routine, {});

    const summary = calls.scheduled.find((n) => n.groupSummary === true);
    expect(summary).toBeDefined();
    expect(summary.group).toBe('routine-routine-1');
    expect(summary.body).toBe('2 tasks');
    expect(summary.title).toBe('Morning');
    // Only the per-task due reminders it groups are pinned - the summary
    // itself must stay swipeable (see CLAUDE.md).
    expect(summary.ongoing).toBeUndefined();
  });

  it('cancels the group summary once the routine drops back to <=1 active task', async () => {
    const taskA = task({ id: 'a', title: 'Stretch', active: false }); // now paused
    const taskB = task({ id: 'b', title: 'Water' });
    const routine = { id: 'routine-1', title: 'Morning', tasks: [taskA, taskB], active: true, notes: '' };

    await updateRoutineGroupSummary(routine);

    const groupSummaryCancel = calls.cancelled.find((n) => n.id >= 700000000);
    expect(groupSummaryCancel).toBeDefined();
    expect(calls.scheduled.find((n) => n.groupSummary === true)).toBeUndefined();
  });

  it('does not create a group summary for a single-task routine at all', async () => {
    const soloTask = task({ id: 'solo' });
    const routine = { id: 'routine-solo', title: 'Solo', tasks: [soloTask], active: true, notes: '' };

    await scheduleTaskNotifications(soloTask, routine, {});

    expect(calls.scheduled.find((n) => n.groupSummary === true)).toBeUndefined();
  });
});

describe('catch-up due reminder (catchUpDueReminderIfNeeded)', () => {
  it('re-fires an overdue, not-yet-done task immediately (no schedule field) whenever synced', async () => {
    const overdueTask = task({ id: 'brand-new', title: 'Evening walk', time: '08:00' }); // 08:00 < now (10:00)
    const routine = { id: 'routine-2', title: 'Evening walk', tasks: [overdueTask], active: true, notes: '' };

    await scheduleTaskNotifications(overdueTask, routine, {});

    // The normal recurring due entry (with a `schedule` field) should also
    // have been (re)scheduled by the same call...
    const recurring = calls.scheduled.find((n) => n.extra?.taskId === 'brand-new' && n.schedule);
    expect(recurring).toBeDefined();
    // ...plus a separate immediate catch-up fire, since cancelTaskNotifications
    // unconditionally wipes the already-showing pinned reminder first and
    // Android's recurring trigger won't retroactively fire for a passed time.
    const catchUp = calls.scheduled.find((n) => n.extra?.taskId === 'brand-new' && n.ongoing && !n.schedule);
    expect(catchUp).toBeDefined();
  });

  it('does not catch-up-fire a task scheduled for a different day, but still sweeps its stale ids', async () => {
    const yesterday = (TUESDAY + 6) % 7; // Monday
    const mondayOnly = task({ id: 'monday-task', days: [yesterday] });
    const routine = { id: 'routine-3', title: 'Monday routine', tasks: [mondayOnly], active: true, notes: '' };

    await scheduleTaskNotifications(mondayOnly, routine, {});

    // cancelTaskNotifications unconditionally sweeps every weekday id
    // (including Monday's) - this is what clears a stale pinned reminder
    // once the day has moved past it.
    expect(calls.cancelled.length).toBeGreaterThan(0);
    const immediateFire = calls.scheduled.find((n) => n.extra?.taskId === 'monday-task' && !n.schedule);
    expect(immediateFire).toBeUndefined();
  });

  it('does not catch-up-fire a task that is already done today', async () => {
    const doneTask = task({ id: 'done-task', time: '08:00' });
    const routine = { id: 'routine-4', title: 'Done routine', tasks: [doneTask], active: true, notes: '' };
    const completions = { 'done-task': { [TODAY_KEY]: 1 } };

    await scheduleTaskNotifications(doneTask, routine, completions);

    const immediateFire = calls.scheduled.find((n) => n.extra?.taskId === 'done-task' && !n.schedule);
    expect(immediateFire).toBeUndefined();
  });

  it('does not catch-up-fire a task whose due time has not passed yet today', async () => {
    const notYetDueTask = task({ id: 'later-task', time: '23:00' }); // now is 10:00
    const routine = { id: 'routine-5', title: 'Late routine', tasks: [notYetDueTask], active: true, notes: '' };

    await scheduleTaskNotifications(notYetDueTask, routine, {});

    const immediateFire = calls.scheduled.find((n) => n.extra?.taskId === 'later-task' && !n.schedule);
    expect(immediateFire).toBeUndefined();
  });
});

describe('updateSummaryNotification', () => {
  function version(completionType, target = null) {
    return {
      effectiveFrom: '2020-01-01',
      active: true,
      days: [TUESDAY],
      completionType,
      target,
    };
  }

  it('shows a real overall percentage title and lists each still-due routine with its own percentage', async () => {
    const routineA = { id: 'a', title: 'Meditate', active: true, tasks: [{ id: 'ta' }] };
    const routineB = { id: 'b', title: 'Push-ups', active: true, tasks: [{ id: 'tb' }] };
    const routineC = { id: 'c', title: 'Water', active: true, tasks: [{ id: 'tc' }] };
    const routines = [routineA, routineB, routineC];

    const taskVersionsMap = {
      ta: [version('boolean')],
      tb: [version('quantity', 10)],
      tc: [version('boolean')],
    };
    const completions = {
      ta: { [TODAY_KEY]: 1 }, // done -> fraction 1
      tb: { [TODAY_KEY]: 3 }, // 3/10 -> fraction 0.3
      tc: {}, // fraction 0
    };

    await updateSummaryNotification(routines, taskVersionsMap, completions);

    const summary = calls.scheduled.find((n) => n.id === 900000001);
    expect(summary).toBeDefined();
    // overall = (1 + 0.3 + 0) / 3 = 0.4333... -> 43%
    expect(summary.title).toBe('Today: 43% complete');
    expect(summary.body).toBe('Push-ups 30% · Water 0%');
    expect(summary.ongoing).toBe(true);
  });

  it('drops `ongoing` and shows a celebratory body once every due routine hits 100%', async () => {
    const routine = { id: 'a', title: 'Meditate', active: true, tasks: [{ id: 'ta' }] };
    const taskVersionsMap = { ta: [version('boolean')] };
    const completions = { ta: { [TODAY_KEY]: 1 } };

    await updateSummaryNotification([routine], taskVersionsMap, completions);

    const summary = calls.scheduled.find((n) => n.id === 900000001);
    expect(summary.body).toBe('All done for today 🎉');
    expect(summary.ongoing).toBe(false);
  });

  it('cancels the summary notification entirely when nothing is due today', async () => {
    const routine = { id: 'a', title: 'Meditate', active: true, tasks: [{ id: 'ta' }] };
    const taskVersionsMap = { ta: [{ ...version('boolean'), days: [] }] };

    await updateSummaryNotification([routine], taskVersionsMap, { ta: {} });

    const cancelledSummary = calls.cancelled.find((n) => n.id === 900000001);
    expect(cancelledSummary).toBeDefined();
    expect(calls.scheduled.find((n) => n.id === 900000001)).toBeUndefined();
  });
});
