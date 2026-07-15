package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Fires once near the end of each day a task is due (see DueReminderScheduler.armExpiry) and
 * auto-dismisses the reminder if it's still showing - a task is due for its entire calendar day
 * regardless of windowStart/time (see CLAUDE.md), so once that day is essentially over there's
 * nothing left to remind about, whether the task was completed or not. Unlike a swipe (which only
 * reappears while awaitingCompletion is true - see DueReminderDismissReceiver), this
 * unconditionally clears the flag and cancels the notification, so a reminder never lingers,
 * pinned or otherwise, into the next day. A harmless no-op if nothing was showing.
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
