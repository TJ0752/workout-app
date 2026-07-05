import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = {
  summaryShown: [],
  summaryCancelled: 0,
  dueReminderScheduled: [],
  dueReminderCancelled: [],
  dueReminderDismissed: [],
  extraReminderScheduled: [],
  extraReminderSlotCancelled: [],
  extraRemindersCancelled: [],
  extraRemindersDismissed: [],
  groupSummaryUpdated: [],
  groupSummaryCancelled: [],
  dailyDigestScheduled: [],
  dailyDigestCancelled: [],
};

// Mock the two Capacitor packages notifications.js talks to. `isNativePlatform`
// must return true, or every exported function in notifications.js short-
// circuits into a no-op (see the `Capacitor.isNativePlatform()` gate at the
// top of nearly every function in src/notifications.js). `registerPlugin` backs
// nativeNotifications.js's NativeNotifications plugin handle, created at module
// load time under this same isNativePlatform() gate.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: vi.fn(() => ({
    showSummary: vi.fn(async (opts) => {
      calls.summaryShown.push(opts);
    }),
    cancelSummary: vi.fn(async () => {
      calls.summaryCancelled += 1;
    }),
    scheduleDueReminder: vi.fn(async (entry) => {
      calls.dueReminderScheduled.push(entry);
    }),
    cancelDueReminder: vi.fn(async ({ taskId }) => {
      calls.dueReminderCancelled.push(taskId);
    }),
    dismissDueReminderToday: vi.fn(async ({ taskId }) => {
      calls.dueReminderDismissed.push(taskId);
    }),
    scheduleExtraReminder: vi.fn(async (entry) => {
      calls.extraReminderScheduled.push(entry);
    }),
    cancelExtraReminderSlot: vi.fn(async ({ taskId, slot }) => {
      calls.extraReminderSlotCancelled.push({ taskId, slot });
    }),
    cancelExtraReminders: vi.fn(async ({ taskId }) => {
      calls.extraRemindersCancelled.push(taskId);
    }),
    dismissExtraRemindersToday: vi.fn(async ({ taskId }) => {
      calls.extraRemindersDismissed.push(taskId);
    }),
    updateGroupSummary: vi.fn(async (opts) => {
      calls.groupSummaryUpdated.push(opts);
    }),
    cancelGroupSummary: vi.fn(async ({ routineId }) => {
      calls.groupSummaryCancelled.push(routineId);
    }),
    scheduleDailyDigest: vi.fn(async (entry) => {
      calls.dailyDigestScheduled.push(entry);
    }),
    cancelDailyDigest: vi.fn(async ({ kind }) => {
      calls.dailyDigestCancelled.push(kind);
    }),
  })),
}));

// Every notification now posts through native Kotlin (see notifications.js's
// initNotifications() doc comment) - the stock plugin is kept installed solely for its runtime
// POST_NOTIFICATIONS permission check/request, so that's the only surface still mocked here.
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn(async () => ({ display: 'granted' })),
    requestPermissions: vi.fn(async () => ({ display: 'granted' })),
  },
}));

import {
  scheduleTaskNotifications,
  cancelTaskNotifications,
  dismissTaskReminders,
  updateRoutineGroupSummary,
  updateSummaryNotification,
  syncDynamicNotifications,
} from '../notifications.js';

// Fixed "now" = Tuesday, 2026-07-07, 10:00 - same fixture used in
// utils/date.test.js, so due-time-passed / weekday logic is deterministic.
const FIXED_NOW = new Date(2026, 6, 7, 10, 0, 0);
const TUESDAY = FIXED_NOW.getDay();
const TODAY_KEY = '2026-07-07';

function resetCalls() {
  calls.summaryShown.length = 0;
  calls.summaryCancelled = 0;
  calls.dueReminderScheduled.length = 0;
  calls.dueReminderCancelled.length = 0;
  calls.dueReminderDismissed.length = 0;
  calls.extraReminderScheduled.length = 0;
  calls.extraReminderSlotCancelled.length = 0;
  calls.extraRemindersCancelled.length = 0;
  calls.extraRemindersDismissed.length = 0;
  calls.groupSummaryUpdated.length = 0;
  calls.groupSummaryCancelled.length = 0;
  calls.dailyDigestScheduled.length = 0;
  calls.dailyDigestCancelled.length = 0;
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
  it('posts a native group summary once a routine has 2+ active tasks', async () => {
    const taskA = task({ id: 'a', title: 'Stretch' });
    const taskB = task({ id: 'b', title: 'Water' });
    const routine = { id: 'routine-1', title: 'Morning', tasks: [taskA, taskB], active: true, notes: '' };

    await scheduleTaskNotifications(taskA, routine);
    await scheduleTaskNotifications(taskB, routine);

    expect(calls.groupSummaryUpdated).toContainEqual({
      routineId: 'routine-1',
      title: 'Morning',
      pendingTaskTitles: ['Stretch', 'Water'],
    });
  });

  it('cancels the group summary once the routine drops back to <=1 active task', async () => {
    const taskA = task({ id: 'a', title: 'Stretch', active: false }); // now paused
    const taskB = task({ id: 'b', title: 'Water' });
    const routine = { id: 'routine-1', title: 'Morning', tasks: [taskA, taskB], active: true, notes: '' };

    await updateRoutineGroupSummary(routine);

    expect(calls.groupSummaryCancelled).toEqual(['routine-1']);
    expect(calls.groupSummaryUpdated).toHaveLength(0);
  });

  it('does not create a group summary for a single-task routine at all', async () => {
    const soloTask = task({ id: 'solo' });
    const routine = { id: 'routine-solo', title: 'Solo', tasks: [soloTask], active: true, notes: '' };

    await scheduleTaskNotifications(soloTask, routine);

    expect(calls.groupSummaryUpdated).toHaveLength(0);
  });
});

describe('native due-by reminder', () => {
  it('schedules the due-by reminder natively with the right payload shape for a boolean task', async () => {
    const boolTask = task({ id: 'brand-new', title: 'Evening walk', time: '08:00' });
    const routine = { id: 'routine-2', title: 'Evening walk', tasks: [boolTask], active: true, notes: '' };

    await scheduleTaskNotifications(boolTask, routine);

    expect(calls.dueReminderScheduled).toHaveLength(1);
    const entry = calls.dueReminderScheduled[0];
    expect(entry).toMatchObject({
      taskId: 'brand-new',
      routineId: 'routine-2',
      title: 'Evening walk',
      days: [TUESDAY],
      hour: 8,
      minute: 0,
      completionType: 'boolean',
      quickAddAmounts: [],
    });
    // Single-task routine - no group tag needed.
    expect(entry.group).toBeUndefined();
  });

  it('schedules the due-by reminder natively with quickAddAmounts for a quantity task', async () => {
    const qtyTask = task({
      id: 'qty-task',
      completionType: 'quantity',
      target: 8,
      quickAdd: [1, 2],
    });
    const routine = { id: 'routine-6', title: 'Hydrate', tasks: [qtyTask], active: true, notes: '' };

    await scheduleTaskNotifications(qtyTask, routine);

    expect(calls.dueReminderScheduled).toHaveLength(1);
    expect(calls.dueReminderScheduled[0]).toMatchObject({
      taskId: 'qty-task',
      completionType: 'quantity',
      quickAddAmounts: [1, 2],
    });
  });

  it('tags the due reminder with the routine group when the routine has multiple tasks', async () => {
    const taskA = task({ id: 'a', title: 'Stretch' });
    const taskB = task({ id: 'b', title: 'Water' });
    const routine = { id: 'routine-1', title: 'Morning', tasks: [taskA, taskB], active: true, notes: '' };

    await scheduleTaskNotifications(taskA, routine);

    const entry = calls.dueReminderScheduled.find((e) => e.taskId === 'a');
    expect(entry.group).toBe('routine-routine-1');
  });

  it('does not schedule a due reminder for an inactive task, a task with no active days, or a paused routine - but does cancel any existing one natively', async () => {
    const inactiveTask = task({ id: 'inactive', active: false });
    const noDaysTask = task({ id: 'no-days', days: [] });
    const pausedRoutineTask = task({ id: 'paused-routine-task' });
    const routine1 = { id: 'r1', title: 'R1', tasks: [inactiveTask], active: true, notes: '' };
    const routine2 = { id: 'r2', title: 'R2', tasks: [noDaysTask], active: true, notes: '' };
    const routine3 = { id: 'r3', title: 'R3', tasks: [pausedRoutineTask], active: false, notes: '' };

    await scheduleTaskNotifications(inactiveTask, routine1);
    await scheduleTaskNotifications(noDaysTask, routine2);
    await scheduleTaskNotifications(pausedRoutineTask, routine3);

    expect(calls.dueReminderScheduled).toHaveLength(0);
    expect(calls.dueReminderCancelled.sort()).toEqual(['inactive', 'no-days', 'paused-routine-task']);
  });

  it('does not cancel the native due reminder merely to reschedule an active task - only stock plugin ids', async () => {
    // Regression check: scheduleTaskNotifications used to call the full cancelTaskNotifications
    // (which clears DueReminderStore) before every reschedule, defeating
    // DueReminderScheduler.schedule()'s no-op-if-unchanged comparison on literally every sync,
    // since there would never be a previous entry left to compare against.
    await scheduleTaskNotifications(task({ id: 'stays-armed' }), {
      id: 'routine-7',
      title: 'Stays armed',
      tasks: [task({ id: 'stays-armed' })],
      active: true,
      notes: '',
    });

    expect(calls.dueReminderCancelled).toHaveLength(0);
    expect(calls.dueReminderScheduled).toHaveLength(1);
  });

  it('passes isDoneToday through so the native scheduler can catch up an already-overdue task', async () => {
    const overdueTask = task({ id: 'overdue', time: '08:00' }); // now is 10:00 - already passed
    const routine = { id: 'routine-8', title: 'Overdue', tasks: [overdueTask], active: true, notes: '' };

    await scheduleTaskNotifications(overdueTask, routine); // no completions - not done
    expect(calls.dueReminderScheduled[0].isDoneToday).toBe(false);

    resetCalls();
    const completions = { overdue: { [TODAY_KEY]: 1 } };
    await scheduleTaskNotifications(overdueTask, routine, completions);
    expect(calls.dueReminderScheduled[0].isDoneToday).toBe(true);
  });

  it('cancels the native due reminder as part of cancelTaskNotifications', async () => {
    await cancelTaskNotifications(task({ id: 'to-cancel' }));

    expect(calls.dueReminderCancelled).toEqual(['to-cancel']);
  });

  it('dismisses today\'s native due reminder as part of dismissTaskReminders', async () => {
    await dismissTaskReminders(task({ id: 'to-dismiss' }));

    expect(calls.dueReminderDismissed).toEqual(['to-dismiss']);
  });
});

describe('native extra reminders', () => {
  it('schedules one native extra reminder per configured reminderTime, keyed by slot', async () => {
    const extraTask = task({ id: 'extra-1', reminderTimes: ['09:00', '14:30'] });
    const routine = { id: 'routine-extra', title: 'Extra', tasks: [extraTask], active: true, notes: '' };

    await scheduleTaskNotifications(extraTask, routine);

    expect(calls.extraReminderScheduled).toHaveLength(2);
    expect(calls.extraReminderScheduled[0]).toMatchObject({
      taskId: 'extra-1',
      slot: 0,
      days: [TUESDAY],
      hour: 9,
      minute: 0,
    });
    expect(calls.extraReminderScheduled[1]).toMatchObject({
      taskId: 'extra-1',
      slot: 1,
      hour: 14,
      minute: 30,
    });
  });

  it('cancels the remaining slots when a task now has fewer reminderTimes than before', async () => {
    const extraTask = task({ id: 'extra-2', reminderTimes: ['09:00'] });
    const routine = { id: 'routine-extra-2', title: 'Extra 2', tasks: [extraTask], active: true, notes: '' };

    await scheduleTaskNotifications(extraTask, routine);

    // Slot 0 was scheduled; every remaining slot up to MAX_EXTRA_REMINDERS should be cancelled
    // so a task that used to have more reminder times doesn't leave stale native alarms armed.
    expect(calls.extraReminderScheduled).toHaveLength(1);
    expect(calls.extraReminderSlotCancelled.map((c) => c.slot).sort()).toEqual([1, 2, 3, 4]);
    expect(calls.extraReminderSlotCancelled.every((c) => c.taskId === 'extra-2')).toBe(true);
  });

  it('cancels every extra-reminder slot for an inactive task, a task with no active days, or a paused routine', async () => {
    const inactiveTask = task({ id: 'inactive-extra', active: false, reminderTimes: ['09:00'] });
    const routine = { id: 'r-inactive-extra', title: 'R', tasks: [inactiveTask], active: true, notes: '' };

    await scheduleTaskNotifications(inactiveTask, routine);

    expect(calls.extraReminderScheduled).toHaveLength(0);
    expect(calls.extraRemindersCancelled).toEqual(['inactive-extra']);
  });

  it('tags an extra reminder with the routine group and quickAddAmounts, same as the due reminder', async () => {
    const qtyTask = task({
      id: 'qty-extra',
      completionType: 'quantity',
      target: 8,
      quickAdd: [1, 2],
      reminderTimes: ['12:00'],
    });
    const taskB = task({ id: 'sibling' });
    const routine = { id: 'routine-qty-extra', title: 'Hydrate', tasks: [qtyTask, taskB], active: true, notes: '' };

    await scheduleTaskNotifications(qtyTask, routine);

    expect(calls.extraReminderScheduled[0]).toMatchObject({
      completionType: 'quantity',
      quickAddAmounts: [1, 2],
      group: 'routine-routine-qty-extra',
    });
  });

  it('cancels every extra-reminder slot as part of cancelTaskNotifications', async () => {
    await cancelTaskNotifications(task({ id: 'to-cancel-extra' }));

    expect(calls.extraRemindersCancelled).toEqual(['to-cancel-extra']);
  });

  it('dismisses today\'s extra reminders as part of dismissTaskReminders', async () => {
    await dismissTaskReminders(task({ id: 'to-dismiss-extra' }));

    expect(calls.extraRemindersDismissed).toEqual(['to-dismiss-extra']);
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

    expect(calls.summaryShown).toHaveLength(1);
    const summary = calls.summaryShown[0];
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

    const summary = calls.summaryShown[0];
    expect(summary.body).toBe('All done for today 🎉');
    expect(summary.ongoing).toBe(false);
  });

  it('cancels the summary notification entirely when nothing is due today', async () => {
    const routine = { id: 'a', title: 'Meditate', active: true, tasks: [{ id: 'ta' }] };
    const taskVersionsMap = { ta: [{ ...version('boolean'), days: [] }] };

    await updateSummaryNotification([routine], taskVersionsMap, { ta: {} });

    expect(calls.summaryCancelled).toBe(1);
    expect(calls.summaryShown).toHaveLength(0);
  });
});

describe('native daily digest and streak-risk', () => {
  it('schedules the morning and evening digests natively with fixed hours', async () => {
    const routine = { id: 'r1', title: 'Routine', active: true, tasks: [{ id: 't1' }] };
    const taskVersionsMap = {
      t1: [{ effectiveFrom: '2020-01-01', active: true, days: [TUESDAY], completionType: 'boolean' }],
    };

    await syncDynamicNotifications([routine], taskVersionsMap, { t1: {} });

    const morning = calls.dailyDigestScheduled.find((e) => e.kind === 'morning');
    const evening = calls.dailyDigestScheduled.find((e) => e.kind === 'evening');
    expect(morning).toMatchObject({ title: 'Good morning', hour: 8, minute: 0 });
    expect(evening).toMatchObject({ title: 'Evening wrap-up', hour: 21, minute: 0 });
  });

  it('schedules the streak-risk digest when a routine has a live streak >= 2 and is not yet done today', async () => {
    const routine = { id: 'r1', title: 'Streak Routine', active: true, tasks: [{ id: 't1' }] };
    // Due Mon(1)/Tue(2) only - completed on the last two occurrences (this Monday and the
    // Tuesday before that), giving calcRoutineStreak a live streak of 2 as of "now" (today,
    // Tuesday, not yet done).
    const taskVersionsMap = {
      t1: [{ effectiveFrom: '2020-01-01', active: true, days: [1, 2], completionType: 'boolean' }],
    };
    const completions = { t1: { '2026-07-06': 1, '2026-06-30': 1 } };

    await syncDynamicNotifications([routine], taskVersionsMap, completions);

    expect(calls.dailyDigestScheduled).toContainEqual({
      kind: 'streak-risk',
      title: 'Your streak is at risk',
      body: 'Finish "Streak Routine" today to keep your streak alive.',
      hour: 19,
      minute: 0,
    });
  });

  it('cancels the streak-risk digest when nothing is at risk', async () => {
    const routine = { id: 'r1', title: 'Routine', active: true, tasks: [{ id: 't1' }] };
    const taskVersionsMap = {
      t1: [{ effectiveFrom: '2020-01-01', active: true, days: [TUESDAY], completionType: 'boolean' }],
    };

    // Already done today, so nothing is at risk regardless of streak length.
    await syncDynamicNotifications([routine], taskVersionsMap, { t1: { [TODAY_KEY]: 1 } });

    expect(calls.dailyDigestCancelled).toEqual(['streak-risk']);
    expect(calls.dailyDigestScheduled.find((e) => e.kind === 'streak-risk')).toBeUndefined();
  });
});
