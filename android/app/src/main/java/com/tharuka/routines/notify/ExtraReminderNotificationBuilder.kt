package com.tharuka.routines.notify

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

/**
 * Shared by ExtraReminderAlarmReceiver - builds the plain, dismissible nudge notification for
 * one (task, slot) extra reminder. Same channel and Mark-done/+N/Snooze actions as the due-by
 * reminder (DueReminderNotificationBuilder), but no delete-intent/reappear-on-dismiss - these
 * were always meant to be one-shot nudges leading up to the real due time, not pinned.
 */
internal fun buildExtraReminderNotification(context: Context, entry: ExtraReminderEntry): Notification {
    val notificationId = extraReminderNotificationId(entry.taskId, entry.slot)
    val builder = NotificationCompat.Builder(context, DUE_REMINDER_CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_recent_history)
        .setContentTitle(entry.title)
        .setContentText(entry.body)
        .setAutoCancel(true)
    if (entry.group != null) builder.setGroup(entry.group)

    if (entry.completionType == "quantity") {
        for (amount in entry.quickAddAmounts) {
            builder.addAction(
                0,
                "+$amount",
                extraReminderActionPendingIntent(context, entry.taskId, entry.slot, notificationId, ACTION_ADD_QUANTITY, amount),
            )
        }
    } else {
        builder.addAction(
            0,
            "Mark done",
            extraReminderActionPendingIntent(context, entry.taskId, entry.slot, notificationId, ACTION_MARK_DONE, null),
        )
    }
    builder.addAction(
        0,
        "Snooze 15m",
        extraReminderActionPendingIntent(context, entry.taskId, entry.slot, notificationId, ACTION_SNOOZE, null),
    )

    return builder.build()
}

private fun extraReminderActionPendingIntent(
    context: Context,
    taskId: String,
    slot: Int,
    notificationId: Int,
    action: String,
    amount: Int?,
): PendingIntent {
    val intent = Intent(context, ExtraReminderActionReceiver::class.java)
    intent.action = action
    intent.putExtra(EXTRA_TASK_ID, taskId)
    intent.putExtra(EXTRA_SLOT, slot)
    if (amount != null) intent.putExtra(EXTRA_AMOUNT, amount)
    val requestCode = notificationId + action.hashCode() + (amount ?: 0)
    return PendingIntent.getBroadcast(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}
