package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Fires when a due reminder's alarm goes off. Reads the entry from the store (not app memory) so
 * this works with the app process fully dead, marks it awaitingCompletion for
 * DueReminderDismissReceiver's repost decision (next stage), posts the notification, and
 * immediately self-reschedules next week's occurrence - mirroring
 * @capacitor/local-notifications' own TimedNotificationPublisher's confirmed self-rescheduling,
 * since this replaces AlarmManager.setRepeating()'s single long-lived alarm with a one-shot
 * chain instead.
 *
 * If today is one of entry.skipDates (this week's occurrence was moved elsewhere via
 * task_reschedules), the alarm still fires and still re-arms next week's occurrence as normal,
 * but nothing is posted/re-alerted - the task genuinely isn't due today.
 * RescheduleReminderScheduler owns the actual reminder for wherever this occurrence moved to.
 */
class DueReminderAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        val entry = DueReminderStore.read(context, taskId) ?: return
        if (!entry.skipDates.contains(todayDateKey())) {
            DueReminderStore.setAwaitingCompletion(context, taskId, true)
            val notification = buildDueReminderNotification(context, entry)
            NotificationManagerCompat.from(context).notify(dueReminderNotificationId(taskId), notification)
        }
        DueReminderScheduler.arm(context, entry)
    }
}
