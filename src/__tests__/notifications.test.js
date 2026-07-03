import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = {
  scheduled: [],
  cancelled: [],
  removed: [],
  registered: [],
  summaryShown: [],
  summaryCancelled: 0,
  dueReminderScheduled: [],
  dueReminderCancelled: [],
  dueReminderDismissed: [],
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
  })),
}));

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

import {
  scheduleTaskNotifications,
  cancelTaskNotifications,
  dismissTaskReminders,
  updateRoutineGroupSummary,
  updateSummaryNotification,
} from '../notifications.js';

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
  calls.summaryShown.length = 0;
  calls.summaryCancelled = 0;
  calls.dueReminderScheduled.length = 0;
  calls.dueReminderCancelled.length = 0;
  calls.dueReminderDismissed.length = 0;
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

    await scheduleTaskNotifications(taskA, routine);
    await scheduleTaskNotifications(taskB, routine);

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

    await scheduleTaskNotifications(soloTask, routine);

    expect(calls.scheduled.find((n) => n.groupSummary === true)).toBeUndefined();
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

  it('does not schedule a due reminder for an inactive task, a task with no active days, or a paused routine', async () => {
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
