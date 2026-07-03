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
