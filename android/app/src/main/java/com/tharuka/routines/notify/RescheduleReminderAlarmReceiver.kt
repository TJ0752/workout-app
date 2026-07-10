package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Fires exactly once, when a rescheduled occurrence's target moment arrives - reads its own
 * one-shot entry (not app memory) so this works with the app process fully dead. Unlike
 * DueReminderAlarmReceiver/ExtraReminderAlarmReceiver, there's no self-rescheduling here: nothing
 * recurs, so the entry is cleared immediately after posting since this occurrence is now
 * consumed, whether or not the user acts on it.
 */
class RescheduleReminderAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        val newDate = intent.getStringExtra(EXTRA_NEW_DATE) ?: return
        val entry = RescheduleReminderStore.read(context, taskId, newDate) ?: return

        val notification = buildRescheduleReminderNotification(context, entry)
        NotificationManagerCompat.from(context).notify(rescheduleReminderNotificationId(taskId, newDate), notification)
        RescheduleReminderStore.clear(context, taskId, newDate)
    }
}
