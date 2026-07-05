package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Fires when an extra-reminder alarm goes off - reads the entry from the store (not app
 * memory) so this works with the app process fully dead, posts the notification, and
 * immediately self-reschedules the next occurrence, mirroring DueReminderAlarmReceiver's
 * self-rescheduling pattern.
 */
class ExtraReminderAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        val slot = intent.getIntExtra(EXTRA_SLOT, -1)
        if (slot < 0) return
        val entry = ExtraReminderStore.read(context, taskId, slot) ?: return
        val notification = buildExtraReminderNotification(context, entry)
        NotificationManagerCompat.from(context).notify(extraReminderNotificationId(taskId, slot), notification)
        ExtraReminderScheduler.arm(context, entry)
    }
}
