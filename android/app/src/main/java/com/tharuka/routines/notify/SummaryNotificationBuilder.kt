package com.tharuka.routines.notify

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Sits between JS's SUMMARY_NOTIFICATION_ID (900,000,001, in src/notifications.js) and the
 * due-reminder range this migration also introduces (DUE_REMINDER_ID_BASE, 600,000,000) - see
 * CLAUDE.md for the full id-range map now split across JS and Kotlin.
 */
internal const val SUMMARY_NOTIFICATION_ID = 800_000_001
internal const val SUMMARY_CHANNEL_ID = "daily-summary"

/**
 * Shared by NativeNotificationsPlugin.showSummary (the normal JS-driven path) and
 * SummaryDismissReceiver (the repost-on-swipe path) so both always build an identical
 * notification from the same persisted content.
 */
internal fun buildAndPostSummaryNotification(context: Context, content: SummaryContent) {
    val deleteIntent = Intent(context, SummaryDismissReceiver::class.java)
    val deletePendingIntent = PendingIntent.getBroadcast(
        context,
        SUMMARY_NOTIFICATION_ID,
        deleteIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(context, SUMMARY_CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_recent_history)
        .setContentTitle(content.title)
        .setContentText(content.body)
        .setOngoing(content.ongoing)
        .setAutoCancel(false)
        .setDeleteIntent(deletePendingIntent)
        .setGroup(APP_GROUP_KEY)
        .setContentIntent(notificationTapPendingIntent(context, SUMMARY_NOTIFICATION_ID))
        .build()
    NotificationManagerCompat.from(context).notify(SUMMARY_NOTIFICATION_ID, notification)
}
