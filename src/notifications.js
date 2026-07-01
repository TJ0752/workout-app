import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { calcRoutineStreak, getRoutineFraction } from './utils/date';
import { quickAddAmountsFor } from './utils/tasks';

const CHANNEL_ID = 'routine-reminders';
const DIGEST_CHANNEL_ID = 'daily-digest';
const SUMMARY_CHANNEL_ID = 'daily-summary';

const BOOLEAN_ACTION_TYPE = 'task-boolean';

const SUMMARY_NOTIFICATION_ID = 900000001;
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

function snoozeIdFor(taskId) {
  return hashToInt(`${taskId}-snooze`);
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

export async function cancelTaskNotifications(task) {
  if (!Capacitor.isNativePlatform()) return;
  const ids = [0, 1, 2, 3, 4, 5, 6]
    .map((day) => ({ id: notificationIdFor(task.id, day) }))
    .concat([{ id: snoozeIdFor(task.id) }]);
  try {
    await LocalNotifications.cancel({ notifications: ids });
  } catch (err) {
    console.warn('Failed to cancel notifications', err);
  }
}

export async function scheduleTaskNotifications(task, routine) {
  if (!Capacitor.isNativePlatform()) return;
  await cancelTaskNotifications(task);
  if (!task.active || task.days.length === 0) return;

  const [hour, minute] = task.time.split(':').map(Number);
  const title = routine && routine.title !== task.title ? `${routine.title} · ${task.title}` : task.title;
  const body = (routine && routine.notes) || 'Time to complete your task';
  const actionTypeId =
    task.completionType === 'quantity' ? quantityActionTypeId(quickAddAmountsFor(task)) : BOOLEAN_ACTION_TYPE;
  const group = routine && routine.tasks.length > 1 ? `routine-${routine.id}` : undefined;

  const notifications = task.days.map((day) => ({
    id: notificationIdFor(task.id, day),
    title,
    body,
    channelId: CHANNEL_ID,
    actionTypeId,
    group,
    extra: { taskId: task.id, routineId: routine?.id },
    schedule: {
      on: { weekday: day + 1, hour, minute },
      allowWhileIdle: true,
    },
  }));

  try {
    await LocalNotifications.schedule({ notifications });
  } catch (err) {
    console.warn('Failed to schedule notifications', err);
  }
}

export async function syncAllNotifications(routines) {
  if (!Capacitor.isNativePlatform()) return;
  await registerNotificationActionTypes(routines);
  for (const routine of routines) {
    for (const task of routine.tasks) {
      await scheduleTaskNotifications(task, routine);
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

/**
 * Refreshes the persistent "today at a glance" notification. Uses `ongoing`
 * (non-swipeable) instead of a live-ticking display, since the Android APIs
 * for a real live countdown/chronometer aren't exposed by this plugin - see
 * CLAUDE.md.
 */
export async function updateSummaryNotification(routines, taskVersionsMap, completions) {
  if (!Capacitor.isNativePlatform()) return;
  const today = new Date();
  const due = activeDueRoutines(routines, taskVersionsMap, completions, today);
  if (due.length === 0) {
    await LocalNotifications.cancel({ notifications: [{ id: SUMMARY_NOTIFICATION_ID }] });
    return;
  }
  const doneCount = due.filter((r) => r.fraction === 1).length;
  const remaining = due.filter((r) => r.fraction < 1);
  const body =
    remaining.length === 0
      ? 'All done for today 🎉'
      : `Still due: ${formatRoutineList(remaining)}`;

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: SUMMARY_NOTIFICATION_ID,
          title: `Today: ${doneCount}/${due.length} completed`,
          body,
          channelId: SUMMARY_CHANNEL_ID,
          ongoing: remaining.length > 0,
          autoCancel: false,
        },
      ],
    });
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
