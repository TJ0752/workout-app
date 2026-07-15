package com.tharuka.routines.notify

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

// The channel already exists - created by createNotificationChannels() (NotificationChannels.kt),
// called from NativeNotificationsPlugin.load() - channels are app-wide, not plugin-scoped.
internal const val DUE_REMINDER_CHANNEL_ID = "routine-reminders"

internal const val ACTION_MARK_DONE = "com.tharuka.routines.notify.action.MARK_DONE"
internal const val ACTION_ADD_QUANTITY = "com.tharuka.routines.notify.action.ADD_QUANTITY"
internal const val ACTION_SNOOZE = "com.tharuka.routines.notify.action.SNOOZE"
internal const val EXTRA_AMOUNT = "amount"

/**
 * Shared by DueReminderAlarmReceiver (the normal fire path), WindowStartAlarmReceiver (the
 * proactive active-window path), and DueReminderDismissReceiver (the repost-on-swipe path) so
 * every one of them always builds an identical notification for a given entry/mode. No more
 * registered-actionTypeId indirection needed here (unlike @capacitor/local-notifications' action
 * model) - action PendingIntents are built directly per-notification since this code owns the
 * whole pipeline.
 *
 * `silent` (setSilent) suppresses sound/vibration/lights for this one post - used for the
 * windowStart proactive post and the "just completed" repost, neither of which should demand
 * attention the way an actual due-by or extra-reminder alert does.
 *
 * `completed` switches to a plain, swipeable "final state" notification once a task is marked
 * done while its reminder is already showing: no action buttons (nothing left to do), not
 * `ongoing` (so a plain swipe dismisses it for good), and no delete-intent (no reappear-on-swipe -
 * see NativeNotificationsPlugin.dismissDueReminderToday).
 */
internal fun buildDueReminderNotification(
    context: Context,
    entry: DueReminderEntry,
    silent: Boolean = false,
    completed: Boolean = false,
): Notification {
    val notificationId = dueReminderNotificationId(entry.taskId)

    val builder = NotificationCompat.Builder(context, DUE_REMINDER_CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_recent_history)
        .setContentTitle(entry.title)
        .setContentText(entry.body)
        .setOngoing(!completed)
        .setAutoCancel(completed)
        .setSilent(silent)
        .setGroup(APP_GROUP_KEY)
        .setContentIntent(notificationTapPendingIntent(context, notificationId, entry.taskId, entry.routineId))

    if (!completed) {
        val deleteIntent = Intent(context, DueReminderDismissReceiver::class.java)
        deleteIntent.putExtra(EXTRA_TASK_ID, entry.taskId)
        val deletePendingIntent = PendingIntent.getBroadcast(
            context,
            notificationId,
            deleteIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        builder.setDeleteIntent(deletePendingIntent)

        if (entry.completionType == "quantity") {
            for (amount in entry.quickAddAmounts) {
                builder.addAction(0, "+$amount", actionPendingIntent(context, entry.taskId, notificationId, ACTION_ADD_QUANTITY, amount))
            }
        } else {
            builder.addAction(0, "Mark done", actionPendingIntent(context, entry.taskId, notificationId, ACTION_MARK_DONE, null))
        }
        builder.addAction(0, "Snooze 15m", actionPendingIntent(context, entry.taskId, notificationId, ACTION_SNOOZE, null))
    }

    return builder.build()
}

/**
 * requestCode incorporates the (task-specific) notificationId plus the action's own hash and
 * amount, since PendingIntent identity/caching ignores Intent extras - without this, multiple
 * action buttons on the same notification (or the same action across different tasks) could
 * collide and silently reuse a stale PendingIntent's extras via FLAG_UPDATE_CURRENT.
 */
private fun actionPendingIntent(
    context: Context,
    taskId: String,
    notificationId: Int,
    action: String,
    amount: Int?,
): PendingIntent {
    val intent = Intent(context, DueReminderActionReceiver::class.java)
    intent.action = action
    intent.putExtra(EXTRA_TASK_ID, taskId)
    if (amount != null) intent.putExtra(EXTRA_AMOUNT, amount)
    val requestCode = notificationId + action.hashCode() + (amount ?: 0)
    return PendingIntent.getBroadcast(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}
