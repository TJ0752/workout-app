package com.tharuka.routines.notify

import android.app.Notification
import android.content.Context
import androidx.core.app.NotificationCompat

// Reuses the existing daily-digest channel, created by createNotificationChannels()
// (NotificationChannels.kt) - channels are app-wide, not plugin-scoped.
internal const val DIGEST_CHANNEL_ID = "daily-digest"

/** Plain, dismissible - no actions, no delete-intent. Shared by DailyDigestAlarmReceiver. */
internal fun buildDailyDigestNotification(context: Context, entry: DailyDigestEntry): Notification {
    return NotificationCompat.Builder(context, DIGEST_CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_recent_history)
        .setContentTitle(entry.title)
        .setContentText(entry.body)
        .setAutoCancel(true)
        .setGroup(APP_GROUP_KEY)
        .setContentIntent(notificationTapPendingIntent(context, dailyDigestNotificationId(entry.kind)))
        .build()
}
