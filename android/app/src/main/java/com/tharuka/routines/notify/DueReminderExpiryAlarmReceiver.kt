package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Fires a short buffer after each task's own due-by moment (see DueReminderScheduler.armExpiry)
 * and auto-dismisses the reminder if it's still showing - an individual, per-task "expected end
 * time," not a single clock time every task shares. Unlike a swipe (which only reappears while
 * awaitingCompletion is true - see DueReminderDismissReceiver), this unconditionally clears the
 * flag and cancels the notification, whether the task was ever completed or not, so a reminder
 * never lingers past its own due-by moment. A harmless no-op if nothing was showing.
 */
class DueReminderExpiryAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        val entry = DueReminderStore.read(context, taskId) ?: return
        DueReminderStore.setAwaitingCompletion(context, taskId, false)
        NotificationManagerCompat.from(context).cancel(dueReminderNotificationId(taskId))
        // Always re-arm next week's occurrence, mirroring every other self-rescheduling alarm in
        // this family.
        DueReminderScheduler.armExpiry(context, entry)
    }
}
