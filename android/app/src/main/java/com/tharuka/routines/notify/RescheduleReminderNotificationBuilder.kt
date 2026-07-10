package com.tharuka.routines.notify

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

/**
 * Plain, dismissible, no reappear-on-dismiss - unlike the due-by reminder, a one-shot alarm for a
 * single moved occurrence has no recurring slot to keep pinned, so there's nothing to reappear
 * into. Reuses the exact same Mark-done/+N/Snooze action wiring (dispatchDueReminderAction,
 * the requestCode-incorporates-notificationId+action+amount discipline) DueReminderNotificationBuilder
 * already established - JS's "dueReminderAction" listener dispatches purely by actionId/taskId,
 * with no notion of which native mechanism sent it, so no second JS listener is needed here.
 */
internal fun buildRescheduleReminderNotification(context: Context, entry: RescheduleReminderEntry): Notification {
    val notificationId = rescheduleReminderNotificationId(entry.taskId, entry.newDate)

    val builder = NotificationCompat.Builder(context, DUE_REMINDER_CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_recent_history)
        .setContentTitle(entry.title)
        .setContentText(entry.body)
        .setAutoCancel(true)
        .setGroup(APP_GROUP_KEY)
        .setContentIntent(notificationTapPendingIntent(context, notificationId, entry.taskId, entry.routineId))

    if (entry.completionType == "quantity") {
        for (amount in entry.quickAddAmounts) {
            builder.addAction(
                0,
                "+$amount",
                rescheduleActionPendingIntent(context, entry, notificationId, ACTION_ADD_QUANTITY, amount),
            )
        }
    } else {
        builder.addAction(
            0,
            "Mark done",
            rescheduleActionPendingIntent(context, entry, notificationId, ACTION_MARK_DONE, null),
        )
    }
    builder.addAction(0, "Snooze 15m", rescheduleActionPendingIntent(context, entry, notificationId, ACTION_SNOOZE, null))

    return builder.build()
}

private fun rescheduleActionPendingIntent(
    context: Context,
    entry: RescheduleReminderEntry,
    notificationId: Int,
    action: String,
    amount: Int?,
): PendingIntent {
    val intent = Intent(context, RescheduleReminderActionReceiver::class.java)
    intent.action = action
    intent.putExtra(EXTRA_TASK_ID, entry.taskId)
    intent.putExtra(EXTRA_NEW_DATE, entry.newDate)
    if (amount != null) intent.putExtra(EXTRA_AMOUNT, amount)
    val requestCode = notificationId + action.hashCode() + (amount ?: 0)
    return PendingIntent.getBroadcast(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}
