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
 * Immediately builds and posts the multi-task routine group summary (see
 * GroupSummaryNotificationBuilder.kt) - plain and swipeable by design, no reappear-on-dismiss,
 * unlike the per-task reminders it groups.
 */
export async function nativeUpdateGroupSummary(routineId, title, activeTaskCount) {
  if (!NativeNotifications) return;
  await NativeNotifications.updateGroupSummary({ routineId, title, activeTaskCount });
}

export async function nativeCancelGroupSummary(routineId) {
  if (!NativeNotifications) return;
  await NativeNotifications.cancelGroupSummary({ routineId });
}
