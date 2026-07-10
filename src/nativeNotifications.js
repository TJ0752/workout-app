import { Capacitor, registerPlugin } from '@capacitor/core';

const NativeNotifications = Capacitor.isNativePlatform() ? registerPlugin('NativeNotifications') : null;

/**
 * Posts (or updates) the daily summary notification with a real setDeleteIntent() behind it -
 * unlike @capacitor/local-notifications, which builds notifications natively with no exposed
 * hook for one - so a swipe-dismiss immediately reappears instead of just vanishing. See
 * CLAUDE.md for why the stock plugin can't support this at all.
 */
export async function showSummaryNotification(title, body, ongoing) {
  if (!NativeNotifications) return;
  await NativeNotifications.showSummary({ title, body, ongoing });
}

export async function cancelSummaryNotification() {
  if (!NativeNotifications) return;
  await NativeNotifications.cancelSummary();
}

/**
 * Wires the due-by reminder's Mark-done/+N action-button taps to the *same* onMarkDone/
 * onAddQuantity callbacks App.jsx already passes to notifications.js's initActionListener - this
 * is a second event source feeding the existing handlers, not new completion logic. Snooze isn't
 * included here: it never touches completions (handled entirely natively, see
 * DueReminderActionReceiver.kt), so there's nothing for JS to do for it.
 */
export function initDueReminderActionListener(onMarkDone, onAddQuantity) {
  if (!NativeNotifications) return null;
  return NativeNotifications.addListener('dueReminderAction', (event) => {
    if (event.actionId === 'MARK_DONE') {
      onMarkDone?.(event.taskId);
    } else if (event.actionId === 'ADD_QUANTITY') {
      onAddQuantity?.(event.taskId, event.amount);
    }
  });
}

/**
 * Schedules the per-task due-by reminder natively (see DueReminderScheduler.kt) - the
 * "reappear on dismiss" replacement for the ongoing pinned reminder @capacitor/local-notifications
 * used to own, which can't support a real setDeleteIntent(). Content (title/body/group) is
 * computed by the caller via notifications.js's existing taskNotificationContent, not
 * recomputed here, so there's exactly one place that logic lives.
 */
export async function nativeScheduleDueReminder(entry) {
  if (!NativeNotifications) return;
  await NativeNotifications.scheduleDueReminder(entry);
}

export async function nativeCancelDueReminder(taskId) {
  if (!NativeNotifications) return;
  await NativeNotifications.cancelDueReminder({ taskId });
}

/** Clears awaitingCompletion and cancels today's notification - called once a task is marked done. */
export async function nativeDismissDueReminderToday(taskId) {
  if (!NativeNotifications) return;
  await NativeNotifications.dismissDueReminderToday({ taskId });
}

/**
 * Schedules one extra-reminder nudge natively (see ExtraReminderScheduler.kt) - the native
 * replacement for the stock plugin's per-(day, slot) recurring schedule. One self-rescheduling
 * alarm per (taskId, slot) covers every day in `days`, mirroring how the due-by reminder itself
 * already covers every day with a single alarm.
 */
export async function nativeScheduleExtraReminder(entry) {
  if (!NativeNotifications) return;
  await NativeNotifications.scheduleExtraReminder(entry);
}

/** Cancels a single extra-reminder slot - used when a task now has fewer reminder times than before. */
export async function nativeCancelExtraReminderSlot(taskId, slot) {
  if (!NativeNotifications) return;
  await NativeNotifications.cancelExtraReminderSlot({ taskId, slot });
}

/** Full teardown of every extra-reminder slot for a task - used when a task is removed or paused. */
export async function nativeCancelExtraReminders(taskId) {
  if (!NativeNotifications) return;
  await NativeNotifications.cancelExtraReminders({ taskId });
}

/** Clears whichever extra-reminder slots are currently showing for this task, for today only - called once a task is marked done. */
export async function nativeDismissExtraRemindersToday(taskId) {
  if (!NativeNotifications) return;
  await NativeNotifications.dismissExtraRemindersToday({ taskId });
}

/**
 * Schedules a genuine one-shot reminder for a single rescheduled occurrence (see
 * RescheduleReminderScheduler.kt) - unlike the due/extra reminders above, this fires exactly
 * once, on the specific calendar date task_reschedules moved this occurrence to, never again.
 * `newDate` is a plain 'YYYY-MM-DD' string; content mirrors the due reminder's own
 * (title/body/completionType/quickAddAmounts), computed by the caller as usual.
 */
export async function nativeScheduleRescheduleReminder(entry) {
  if (!NativeNotifications) return;
  await NativeNotifications.scheduleRescheduleReminder(entry);
}

/** Full teardown of every pending one-shot reschedule reminder for a task - called on every
 * resync and rebuilt fresh from the task's current reschedules, safe because a one-shot alarm
 * (unlike the recurring due reminder) has no persisted "awaitingCompletion"/reappear-on-dismiss
 * state that a destructive cancel+rearm could lose. */
export async function nativeCancelRescheduleReminders(taskId) {
  if (!NativeNotifications) return;
  await NativeNotifications.cancelRescheduleReminders({ taskId });
}

/**
 * Immediately builds and posts the multi-task routine group summary (see
 * GroupSummaryNotificationBuilder.kt) as an expandable InboxStyle notification listing every
 * currently-pending task by title - plain and swipeable by design, no reappear-on-dismiss,
 * unlike the per-task reminders it groups.
 */
export async function nativeUpdateGroupSummary(routineId, title, pendingTaskTitles) {
  if (!NativeNotifications) return;
  await NativeNotifications.updateGroupSummary({ routineId, title, pendingTaskTitles });
}

export async function nativeCancelGroupSummary(routineId) {
  if (!NativeNotifications) return;
  await NativeNotifications.cancelGroupSummary({ routineId });
}

/**
 * Schedules one of the 3 daily digest kinds ("morning", "evening", "streak-risk") natively (see
 * DailyDigestScheduler.kt) - one self-rescheduling alarm per kind, firing every day at its own
 * hour:minute. Content (title/body) is computed by the caller, same as every other native
 * notification wrapper here.
 */
export async function nativeScheduleDailyDigest(kind, title, body, hour, minute) {
  if (!NativeNotifications) return;
  await NativeNotifications.scheduleDailyDigest({ kind, title, body, hour, minute });
}

/** Streak-risk is the one kind that needs a cancel path - morning/evening always have content, even "Nothing due today." */
export async function nativeCancelDailyDigest(kind) {
  if (!NativeNotifications) return;
  await NativeNotifications.cancelDailyDigest({ kind });
}

/**
 * Listens for a tap on any native notification's body (see NotificationTapIntent.kt /
 * NotificationTapBridge.kt) - every notification in the app now deep-links here instead of just
 * opening to whatever screen the app was last on. `taskId`/`routineId` are both optional: a
 * task-specific notification (due/extra reminder) carries both, the group summary carries only
 * `routineId`, and the daily summary/digests/background-sync notification carry neither (they
 * just bring the app to the foreground on the Today tab with nothing specific to focus). Covers
 * both cold start (MainActivity relaunched fresh - NativeNotificationsPlugin.load() reads the
 * launch intent's extras) and warm start (MainActivity already running, singleTask - Kotlin's
 * onNewIntent dispatches through NotificationTapBridge instead) transparently; JS sees the same
 * event either way.
 */
export function initNotificationTapListener(onOpenTarget) {
  if (!NativeNotifications) return null;
  return NativeNotifications.addListener('notificationTapped', (event) => {
    onOpenTarget?.(event.taskId ?? null, event.routineId ?? null);
  });
}

/**
 * Listens for the native background-sync service's periodic tick (see BackgroundSyncService.kt)
 * - fired roughly every 15 minutes while the app process is alive, foreground or backgrounded,
 * so digest/summary/streak-risk content stays fresh without requiring the user to reopen the
 * app or make a completion change. The service itself is started automatically once per app
 * process (see NativeNotificationsPlugin.load()) - there's no JS-side start call.
 */
export function initBackgroundSyncListener(onTick) {
  if (!NativeNotifications) return null;
  return NativeNotifications.addListener('backgroundSyncTick', () => {
    onTick?.();
  });
}
