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
