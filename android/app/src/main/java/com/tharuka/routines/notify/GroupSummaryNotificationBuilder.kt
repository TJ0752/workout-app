package com.tharuka.routines.notify

import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.tharuka.routines.shared.reminders.hashToInt

// Same numeric value as the JS-side GROUP_SUMMARY_ID_BASE it replaces (src/notifications.js) -
// see CLAUDE.md's notification-id range table.
internal const val GROUP_SUMMARY_ID_BASE = 700_000_000

internal fun groupSummaryNotificationId(routineId: String): Int = GROUP_SUMMARY_ID_BASE + hashToInt(routineId)

/**
 * Immediate build-and-post, no alarm and no delete-intent - the group summary is deliberately
 * plain/swipeable (only the per-task reminders it groups are pinned, see CLAUDE.md), so unlike
 * the daily summary there's no reappear-on-dismiss decision to make and nothing needs
 * persisting. Recomputed every time any of the routine's tasks reschedule - cheap and
 * idempotent (an immediate NotificationManagerCompat.notify() to the same id just overwrites
 * whatever's currently shown), so it's simplest to always call it rather than track every place
 * that could change the routine's active-task count.
 */
internal fun buildAndPostGroupSummaryNotification(context: Context, routineId: String, title: String, activeTaskCount: Int) {
    val notification = NotificationCompat.Builder(context, DUE_REMINDER_CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_recent_history)
        .setContentTitle(title)
        .setContentText("$activeTaskCount tasks")
        .setGroup("routine-$routineId")
        .setGroupSummary(true)
        .setAutoCancel(true)
        .build()
    NotificationManagerCompat.from(context).notify(groupSummaryNotificationId(routineId), notification)
}
