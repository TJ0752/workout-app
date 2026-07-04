package com.tharuka.routines.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat

/**
 * Creates every notification channel shared by the "computed"/reminder notification kinds -
 * `routine-reminders` (due reminder, extra reminders, group summary), `daily-digest` (morning/
 * evening/streak-risk), and `daily-summary`. `workout-session-timer` (WorkoutTimerService) and
 * `background-sync` (BackgroundSyncService) create their own channels independently since each
 * is only ever used by its own service.
 *
 * Previously created via @capacitor/local-notifications' LocalNotifications.createChannel() in
 * src/notifications.js's initNotifications() - moved here since every notification using these
 * channels is now posted natively, not through that plugin (which is kept installed solely for
 * its runtime POST_NOTIFICATIONS permission check/request - see the doc comment on
 * initNotifications() in notifications.js). Channels are OS-level and app-wide, not scoped to
 * whichever plugin/mechanism posts into them, so this move is purely mechanical.
 */
internal fun createNotificationChannels(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)

    val routineReminders = NotificationChannel(
        DUE_REMINDER_CHANNEL_ID,
        "Routine reminders",
        NotificationManager.IMPORTANCE_HIGH,
    )
    routineReminders.lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
    manager.createNotificationChannel(routineReminders)

    val dailyDigest = NotificationChannel(
        DIGEST_CHANNEL_ID,
        "Daily digests",
        NotificationManager.IMPORTANCE_DEFAULT,
    )
    dailyDigest.lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
    manager.createNotificationChannel(dailyDigest)

    val dailySummary = NotificationChannel(
        SUMMARY_CHANNEL_ID,
        "Today at a glance",
        NotificationManager.IMPORTANCE_LOW,
    )
    dailySummary.lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
    manager.createNotificationChannel(dailySummary)
}
