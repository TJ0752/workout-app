package com.tharuka.routines.notify

import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.tharuka.routines.shared.reminders.hashToInt

// Same numeric value as the JS-side GROUP_SUMMARY_ID_BASE it replaces (src/notifications.js) -
// see CLAUDE.md's notification-id range table.
internal const val GROUP_SUMMARY_ID_BASE = 700_000_000

internal fun groupSummaryNotificationId(routineId: String): Int = GROUP_SUMMARY_ID_BASE + hashToInt(routineId)

// In-memory only (not SharedPreferences) - this cache exists purely to skip a redundant re-alert
// when nothing actually changed, not to survive process death like the due-reminder/digest
// stores do; a cold start naturally treats the first post after launch as "changed from
// nothing," which is the correct behavior anyway. Cleared per-routineId by cancelGroupSummary so
// a routine that drops to <=1 active task and later grows back to the exact same pending list
// doesn't get silently skipped.
private val lastPostedContent = mutableMapOf<String, Pair<String, List<String>>>()

internal fun clearGroupSummaryContentCache(routineId: String) {
    lastPostedContent.remove(routineId)
}

/**
 * Immediate build-and-post, no alarm and no delete-intent - the group summary is deliberately
 * plain/swipeable (only the per-task reminders it groups are pinned, see CLAUDE.md), so unlike
 * the daily summary there's no reappear-on-dismiss decision to make and nothing needs
 * persisting. Recomputed on every completion change and background-sync tick (not just
 * schedule/cancel events), so the pending-task list is always current, not a stale task count -
 * see updateRoutineGroupSummary in src/notifications.js. No-ops (skips the notify() call
 * entirely) if the content is identical to the last post for this routine - NotificationCompat
 * re-alerts on every notify() by default, and this gets called on every app open/background-sync
 * tick regardless of whether anything actually changed, so without this check reopening the app
 * would re-sound this notification every time even when the pending list is unchanged.
 *
 * Uses InboxStyle to list each currently-pending task as its own line, expandable to show them
 * all at a glance without opening the app - this is a real notification (setGroup(APP_GROUP_KEY),
 * not setGroupSummary) alongside the individual per-task reminders it lists, not the app-wide OS
 * group summary (see AppGroupSummary.kt) - Android only allows one summary-flagged notification
 * per group, and that role belongs to the app-wide one so every notification kind (not just
 * grouped routines) reliably collapses together.
 */
internal fun buildAndPostGroupSummaryNotification(context: Context, routineId: String, title: String, pendingTaskTitles: List<String>) {
    val newContent = title to pendingTaskTitles
    if (lastPostedContent[routineId] == newContent) return
    lastPostedContent[routineId] = newContent

    val summaryText = if (pendingTaskTitles.isEmpty()) "All done for today 🎉" else "${pendingTaskTitles.size} pending"
    val style = NotificationCompat.InboxStyle().setBigContentTitle(title).setSummaryText(summaryText)
    if (pendingTaskTitles.isEmpty()) {
        style.addLine("All done for today 🎉")
    } else {
        for (taskTitle in pendingTaskTitles) style.addLine(taskTitle)
    }

    val notification = NotificationCompat.Builder(context, DUE_REMINDER_CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_recent_history)
        .setContentTitle(title)
        .setContentText(summaryText)
        .setStyle(style)
        .setGroup(APP_GROUP_KEY)
        .setAutoCancel(true)
        .setContentIntent(notificationTapPendingIntent(context, groupSummaryNotificationId(routineId), routineId = routineId))
        .build()
    NotificationManagerCompat.from(context).notify(groupSummaryNotificationId(routineId), notification)
}
