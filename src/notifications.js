import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { calcRoutineStreak, getRoutineFraction } from './utils/date';
import { quickAddAmountsFor, isTaskDoneToday, MAX_EXTRA_REMINDERS } from './utils/tasks';
import {
  showSummaryNotification,
  cancelSummaryNotification,
  nativeScheduleDueReminder,
  nativeCancelDueReminder,
  nativeDismissDueReminderToday,
} from './nativeNotifications';

const CHANNEL_ID = 'routine-reminders';
const DIGEST_CHANNEL_ID = 'daily-digest';
// Also hardcoded as SUMMARY_CHANNEL_ID in android/app/.../notify/SummaryNotificationBuilder.kt -
// the channel itself is still created here via LocalNotifications.createChannel (channels are
// app-wide, not plugin-scoped), but the notification is now posted natively - see
// showSummaryNotification below.
const SUMMARY_CHANNEL_ID = 'daily-summary';

const BOOLEAN_ACTION_TYPE = 'task-boolean';

const MORNING_DIGEST_ID = 900000002;
const EVENING_DIGEST_ID = 900000003;
const STREAK_RISK_ID = 900000004;

const MORNING_HOUR = 8;
const EVENING_HOUR = 21;
const STREAK_RISK_HOUR = 19;
const STREAK_RISK_MIN_STREAK = 2;
const SNOOZE_MINUTES = 15;

function hashToInt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 1000000;
}

function notificationIdFor(taskId, weekday) {
  return hashToInt(taskId) * 10 + weekday;
}

// Extra reminder ids are keyed by (task, weekday, slot) rather than the
// reminder's actual time, so cancelTaskNotifications can always sweep every
// slot that could ever have been scheduled - even after the user removes or
// changes a time and we no longer know its old value. Offset well clear of
// notificationIdFor's range so extra reminders can never collide with a due
// reminder id.
const EXTRA_REMINDER_ID_BASE = 500000000;

function extraReminderIdFor(taskId, weekday, slot) {
  return EXTRA_REMINDER_ID_BASE + notificationIdFor(taskId, weekday) * 10 + slot;
}

function snoozeIdFor(taskId) {
  return hashToInt(`${taskId}-snooze`);
}

// Offset clear of every other id range (extra reminders top out around
// EXTRA_REMINDER_ID_BASE + 10_000_000ish) so group-summary ids never collide.
const GROUP_SUMMARY_ID_BASE = 700000000;

function groupSummaryIdFor(routineId) {
  return GROUP_SUMMARY_ID_BASE + hashToInt(routineId);
}

function quantityActionTypeId(amounts) {
  return `task-qty-${amounts.join('-')}`;
}

export async function initNotifications() {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      await LocalNotifications.requestPermissions();
    }
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Routine reminders',
      importance: 4,
      visibility: 1,
    });
    await LocalNotifications.createChannel({
      id: DIGEST_CHANNEL_ID,
      name: 'Daily digests',
      importance: 3,
      visibility: 1,
    });
    await LocalNotifications.createChannel({
      id: SUMMARY_CHANNEL_ID,
      name: 'Today at a glance',
      importance: 2,
      visibility: 1,
    });
    return true;
  } catch (err) {
    console.warn('Notification init failed', err);
    return false;
  }
}

/**
 * Action buttons are attached to a shared, pre-registered "action type", not
 * to individual notifications - so we register one type for boolean tasks
 * and one per distinct quick-add combination in use. Which task/routine a
 * tap applies to is carried on each notification's own `extra` payload.
 */
export async function registerNotificationActionTypes(routines) {
  if (!Capacitor.isNativePlatform()) return;

  const quantityCombos = new Map();
  let hasBoolean = false;
  for (const routine of routines) {
    for (const task of routine.tasks) {
      if (task.completionType === 'quantity') {
        const amounts = quickAddAmountsFor(task);
        quantityCombos.set(quantityActionTypeId(amounts), amounts);
      } else {
        hasBoolean = true;
      }
    }
  }

  const types = [];
  if (hasBoolean) {
    types.push({
      id: BOOLEAN_ACTION_TYPE,
      actions: [
        { id: 'MARK_DONE', title: 'Mark done' },
        { id: 'SNOOZE', title: `Snooze ${SNOOZE_MINUTES}m` },
      ],
    });
  }
  for (const [id, amounts] of quantityCombos) {
    types.push({
      id,
      actions: [
        ...amounts.map((amount) => ({ id: `ADD_${amount}`, title: `+${amount}` })),
        { id: 'SNOOZE', title: `Snooze ${SNOOZE_MINUTES}m` },
      ],
    });
  }

  try {
    await LocalNotifications.registerActionTypes({ types });
  } catch (err) {
    console.warn('Failed to register action types', err);
  }
}

/**
 * Cancels only the stock-plugin-scheduled ids (extra reminder nudges, snooze, and any per-day
 * due-by alarm left over from installs upgrading mid-migration) - never the native due reminder.
 * scheduleTaskNotifications calls this (not the full cancelTaskNotifications below) before every
 * reschedule, so a plain resync never clears DueReminderStore's persisted entry - doing so would
 * defeat DueReminderScheduler.schedule()'s no-op-if-unchanged comparison on literally every call,
 * since there'd never be a previous entry left to compare against.
 */
async function cancelStockNotifications(task) {
  const ids = [{ id: snoozeIdFor(task.id) }];
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    ids.push({ id: notificationIdFor(task.id, day) });
    for (let slot = 0; slot < MAX_EXTRA_REMINDERS; slot++) {
      ids.push({ id: extraReminderIdFor(task.id, day, slot) });
    }
  }
  try {
    await LocalNotifications.cancel({ notifications: ids });
  } catch (err) {
    console.warn('Failed to cancel notifications', err);
  }
}

/** Full teardown - stock ids plus the native due reminder. Used when a task is actually being removed or paused, not just rescheduled. */
export async function cancelTaskNotifications(task) {
  if (!Capacitor.isNativePlatform()) return;
  await cancelStockNotifications(task);
  await nativeCancelDueReminder(task.id);
}

/**
 * Dismisses whatever reminder(s) for this task are currently showing in the
 * shade, for today only - used once a task is marked done so the "stays open
 * while pending" notification (see scheduleTaskNotifications) actually goes
 * away, without touching the underlying recurring schedule for future days.
 */
export async function dismissTaskReminders(task) {
  if (!Capacitor.isNativePlatform()) return;
  const today = new Date().getDay();
  // Kept to clean up any pre-migration stock-scheduled due notification still shown; a no-op
  // once nothing's posted that way anymore.
  const ids = [{ id: notificationIdFor(task.id, today) }];
  for (let slot = 0; slot < MAX_EXTRA_REMINDERS; slot++) {
    ids.push({ id: extraReminderIdFor(task.id, today, slot) });
  }
  try {
    await LocalNotifications.removeDeliveredNotifications({ notifications: ids });
  } catch (err) {
    console.warn('Failed to dismiss task reminders', err);
  }
  await nativeDismissDueReminderToday(task.id);
}

/** Call after any completion change so a just-completed task's pinned reminder clears immediately. */
export async function refreshTaskReminderVisibility(task, completions) {
  if (!Capacitor.isNativePlatform() || !isTaskDoneToday(task, completions)) return;
  await dismissTaskReminders(task);
}

function taskNotificationContent(task, routine) {
  const title = routine && routine.title !== task.title ? `${routine.title} · ${task.title}` : task.title;
  const body = (routine && routine.notes) || 'Time to complete your task';
  const actionTypeId =
    task.completionType === 'quantity' ? quantityActionTypeId(quickAddAmountsFor(task)) : BOOLEAN_ACTION_TYPE;
  const group = routine && routine.tasks.length > 1 ? `routine-${routine.id}` : undefined;
  const extra = { taskId: task.id, routineId: routine?.id };
  return { title, body, actionTypeId, group, extra };
}

/**
 * A genuine Android group-summary notification (`groupSummary: true`,
 * plugin support confirmed in LocalNotificationManager.java - not just
 * cosmetic `group` tagging) for a multi-task routine, so its individual due
 * reminders collapse into one expandable "N tasks" entry in the shade
 * instead of appearing as separate top-level notifications. Recomputed
 * every time any of the routine's tasks reschedule (see
 * scheduleTaskNotifications) - cheap and idempotent, so it's simplest to
 * just always call it rather than track every place that could change the
 * routine's active-task count.
 */
export async function updateRoutineGroupSummary(routine) {
  if (!Capacitor.isNativePlatform() || !routine) return;
  const id = groupSummaryIdFor(routine.id);
  const activeTaskCount = routine.tasks.filter((t) => t.active && t.days.length > 0).length;
  // Only worth a group summary once there are 2+ *active* tasks to collapse -
  // routine.tasks.length alone (used for the `group` tag on individual
  // reminders) undercounts a routine that's mostly paused down to one task.
  if (!routine.active || activeTaskCount <= 1) {
    await cancelRoutineGroupSummary(routine.id);
    return;
  }
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title: routine.title,
          body: `${activeTaskCount} tasks`,
          channelId: CHANNEL_ID,
          group: `routine-${routine.id}`,
          groupSummary: true,
          autoCancel: true,
          extra: { routineId: routine.id },
        },
      ],
    });
  } catch (err) {
    console.warn('Failed to update routine group summary', err);
  }
}

export async function cancelRoutineGroupSummary(routineId) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: groupSummaryIdFor(routineId) }] });
  } catch (err) {
    console.warn('Failed to cancel routine group summary', err);
  }
}

export async function scheduleTaskNotifications(task, routine, completions = {}) {
  if (!Capacitor.isNativePlatform()) return;
  await cancelStockNotifications(task);
  if (!task.active || task.days.length === 0 || routine?.active === false) {
    await nativeCancelDueReminder(task.id);
    if (routine) await updateRoutineGroupSummary(routine);
    return;
  }

  const { title, body, actionTypeId, group, extra } = taskNotificationContent(task, routine);
  const [hour, minute] = task.time.split(':').map(Number);

  // The due-by reminder itself is scheduled natively (see nativeScheduleDueReminder) so it can
  // reappear immediately if swiped away before the task is done - @capacitor/local-notifications
  // has no exposed hook for a custom setDeleteIntent() at all (see CLAUDE.md). Extra reminder
  // times are normal, dismissible nudges leading up to it and stay on the stock plugin
  // unchanged; they get their own ids (extraReminderIdFor) since Android's AlarmManager treats
  // two alarms scheduled under the same id as the same alarm and the later one cancels the
  // earlier before it can ever fire.
  const extraTimes = (task.reminderTimes || []).slice(0, MAX_EXTRA_REMINDERS);
  const extraNotifications = [];
  for (const day of task.days) {
    extraTimes.forEach((timeStr, slot) => {
      const [h, m] = timeStr.split(':').map(Number);
      extraNotifications.push({
        id: extraReminderIdFor(task.id, day, slot),
        title,
        body,
        channelId: CHANNEL_ID,
        actionTypeId,
        group,
        extra,
        schedule: {
          on: { weekday: day + 1, hour: h, minute: m },
          allowWhileIdle: true,
        },
      });
    });
  }

  if (extraNotifications.length > 0) {
    try {
      await LocalNotifications.schedule({ notifications: extraNotifications });
    } catch (err) {
      console.warn('Failed to schedule notifications', err);
    }
  }

  await nativeScheduleDueReminder({
    taskId: task.id,
    routineId: routine?.id,
    title,
    body,
    days: task.days,
    hour,
    minute,
    group,
    completionType: task.completionType,
    quickAddAmounts: task.completionType === 'quantity' ? quickAddAmountsFor(task) : [],
    // Lets DueReminderScheduler catch up immediately on an already-overdue, not-yet-done task
    // instead of waiting for its next natural occurrence (which may be a week away) - see
    // DueReminderScheduler.schedule's isDoneToday param for why this can't be computed natively.
    isDoneToday: isTaskDoneToday(task, completions),
  });
  if (routine) await updateRoutineGroupSummary(routine);
}

export async function syncAllNotifications(routines, completions = {}) {
  if (!Capacitor.isNativePlatform()) return;
  await registerNotificationActionTypes(routines);
  for (const routine of routines) {
    for (const task of routine.tasks) {
      await scheduleTaskNotifications(task, routine, completions);
    }
  }
}

async function scheduleSnooze(notification) {
  if (!Capacitor.isNativePlatform() || !notification) return;
  const { taskId } = notification.extra || {};
  if (!taskId) return;
  const at = new Date(Date.now() + SNOOZE_MINUTES * 60 * 1000);
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: snoozeIdFor(taskId),
          title: notification.title,
          body: notification.body,
          channelId: CHANNEL_ID,
          actionTypeId: notification.actionTypeId,
          extra: notification.extra,
          schedule: { at, allowWhileIdle: true },
        },
      ],
    });
  } catch (err) {
    console.warn('Failed to schedule snooze', err);
  }
}

/**
 * Wires notification action-button taps (Mark done / +N / Snooze) to
 * callbacks. Returns the listener handle promise so callers can remove it
 * on unmount.
 */
export function initActionListener({ onMarkDone, onAddQuantity, onSnooze }) {
  if (!Capacitor.isNativePlatform()) return null;
  return LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
    const { taskId } = event.notification.extra || {};
    if (!taskId) return;
    if (event.actionId === 'MARK_DONE') {
      onMarkDone?.(taskId);
    } else if (event.actionId?.startsWith('ADD_')) {
      const amount = Number(event.actionId.slice('ADD_'.length));
      if (!Number.isNaN(amount)) onAddQuantity?.(taskId, amount);
    } else if (event.actionId === 'SNOOZE') {
      onSnooze?.(event.notification);
      scheduleSnooze(event.notification);
    }
  });
}

function activeDueRoutines(routines, taskVersionsMap, completions, date) {
  return routines
    .map((routine) => ({ routine, fraction: getRoutineFraction(routine, taskVersionsMap, completions, date) }))
    .filter((r) => r.fraction !== null);
}

function formatRoutineList(entries) {
  return entries.map((r) => r.routine.title).join(', ');
}

/** e.g. "Push-ups 30% · Water 60%" - each still-due routine's actual fraction, not just its name. */
function formatRoutineProgress(entries) {
  return entries.map((r) => `${r.routine.title} ${Math.round(r.fraction * 100)}%`).join(' · ');
}

/**
 * Refreshes the persistent "today at a glance" notification. Posted natively (see
 * nativeNotifications.js) with a real setDeleteIntent() rather than through
 * @capacitor/local-notifications, so a swipe-dismiss reappears immediately instead of just
 * vanishing - @capacitor/local-notifications builds its notifications with no exposed hook for
 * a custom delete-intent at all (see CLAUDE.md). Still no live-ticking chronometer display here
 * (that's only feasible via a real foreground service, see the workout session), just a
 * point-in-time snapshot recomputed on every app-open/completion change.
 *
 * Title shows the actual overall completion (average of every due routine's
 * own fraction, itself an average of its due tasks' fractions - see
 * getRoutineFraction), not a coarse done/not-done routine count: a routine
 * sitting at 90% (e.g. 9/10 reps on a quantity task) reads as real progress
 * here instead of counting identically to a routine at 0%. The body lists
 * each still-due routine's own percentage for the same reason.
 */
export async function updateSummaryNotification(routines, taskVersionsMap, completions) {
  if (!Capacitor.isNativePlatform()) return;
  const today = new Date();
  const due = activeDueRoutines(routines, taskVersionsMap, completions, today);
  if (due.length === 0) {
    await cancelSummaryNotification();
    return;
  }
  const overallFraction = due.reduce((sum, r) => sum + r.fraction, 0) / due.length;
  const overallPct = Math.round(overallFraction * 100);
  const remaining = due.filter((r) => r.fraction < 1);
  const body = remaining.length === 0 ? 'All done for today 🎉' : formatRoutineProgress(remaining);

  try {
    await showSummaryNotification(`Today: ${overallPct}% complete`, body, remaining.length > 0);
  } catch (err) {
    console.warn('Failed to update summary notification', err);
  }
}

async function updateStreakRiskNotification(routines, taskVersionsMap, completions) {
  const today = new Date();
  const atRisk = routines.filter((routine) => {
    if (!routine.active) return false;
    const fraction = getRoutineFraction(routine, taskVersionsMap, completions, today);
    if (fraction === null || fraction === 1) return false;
    return calcRoutineStreak(routine, taskVersionsMap, completions) >= STREAK_RISK_MIN_STREAK;
  });

  if (atRisk.length === 0) {
    await LocalNotifications.cancel({ notifications: [{ id: STREAK_RISK_ID }] });
    return;
  }

  const names = atRisk.map((r) => r.title).join(', ');
  const body =
    atRisk.length === 1
      ? `Finish "${names}" today to keep your streak alive.`
      : `${names} still need finishing to keep their streaks alive.`;

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: STREAK_RISK_ID,
          title: atRisk.length === 1 ? 'Your streak is at risk' : 'Streaks at risk tonight',
          body,
          channelId: DIGEST_CHANNEL_ID,
          schedule: { on: { hour: STREAK_RISK_HOUR, minute: 0 }, allowWhileIdle: true },
        },
      ],
    });
  } catch (err) {
    console.warn('Failed to schedule streak-risk notification', err);
  }
}

async function updateMorningDigest(routines, taskVersionsMap, completions) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayDue = activeDueRoutines(routines, taskVersionsMap, completions, yesterday);
  const yesterdayDone = yesterdayDue.filter((r) => r.fraction === 1).length;
  const yesterdaySummary = yesterdayDue.length
    ? `Yesterday: ${yesterdayDone}/${yesterdayDue.length} completed.`
    : 'No routines were due yesterday.';

  const todayDue = activeDueRoutines(routines, taskVersionsMap, completions, new Date());
  const todaySummary = todayDue.length
    ? `Today: ${formatRoutineList(todayDue)}.`
    : 'Nothing due today.';

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: MORNING_DIGEST_ID,
          title: 'Good morning',
          body: `${yesterdaySummary} ${todaySummary}`,
          channelId: DIGEST_CHANNEL_ID,
          schedule: { on: { hour: MORNING_HOUR, minute: 0 }, allowWhileIdle: true },
        },
      ],
    });
  } catch (err) {
    console.warn('Failed to schedule morning digest', err);
  }
}

async function updateEveningDigest(routines, taskVersionsMap, completions) {
  const today = new Date();
  const todayDue = activeDueRoutines(routines, taskVersionsMap, completions, today);
  const todayDone = todayDue.filter((r) => r.fraction === 1).length;
  const todaySummary = todayDue.length
    ? `Today: ${todayDone}/${todayDue.length} completed.`
    : 'Nothing was due today.';

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDue = activeDueRoutines(routines, taskVersionsMap, completions, tomorrow);
  const tomorrowSummary = tomorrowDue.length
    ? `Tomorrow: ${formatRoutineList(tomorrowDue)}.`
    : 'Nothing due tomorrow.';

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: EVENING_DIGEST_ID,
          title: 'Evening wrap-up',
          body: `${todaySummary} ${tomorrowSummary}`,
          channelId: DIGEST_CHANNEL_ID,
          schedule: { on: { hour: EVENING_HOUR, minute: 0 }, allowWhileIdle: true },
        },
      ],
    });
  } catch (err) {
    console.warn('Failed to schedule evening digest', err);
  }
}

/**
 * Refreshes every "computed" notification (persistent summary, streak-risk
 * nudge, morning/evening digests). None of these can be freshly computed at
 * the moment they fire - there's no background task runner wired up - so
 * content reflects whatever it was the last time the app was open. Call this
 * on every app refresh and after every completion change to keep it as
 * current as possible. See CLAUDE.md for the tradeoffs here.
 */
export async function syncDynamicNotifications(routines, taskVersionsMap, completions) {
  if (!Capacitor.isNativePlatform()) return;
  await updateSummaryNotification(routines, taskVersionsMap, completions);
  await updateStreakRiskNotification(routines, taskVersionsMap, completions);
  await updateMorningDigest(routines, taskVersionsMap, completions);
  await updateEveningDigest(routines, taskVersionsMap, completions);
}
