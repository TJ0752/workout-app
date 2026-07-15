package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Fires when a task's `windowStart` moment arrives (see task.windowStart in CLAUDE.md) - a
 * proactive, silent post of the same due-reminder notification, shown from the start of a task's
 * "active window" rather than only once it's actually due/overdue. Reads DueReminderEntry from
 * the store, same as DueReminderAlarmReceiver, so this works with the app process fully dead.
 *
 * This alarm is only ever armed at all for a task with a real (non-'00:00') windowStart (see
 * DueReminderScheduler.armWindowStart) - the common case (no custom window) never schedules it,
 * so there's no behavior change for any task that doesn't set one.
 */
class WindowStartAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        val entry = DueReminderStore.read(context, taskId) ?: return
        if (!entry.doneToday && !entry.skipDates.contains(todayDateKey())) {
            DueReminderStore.setAwaitingCompletion(context, taskId, true)
            val notification = buildDueReminderNotification(context, entry, silent = true)
            NotificationManagerCompat.from(context).notify(dueReminderNotificationId(taskId), notification)
        }
        // Always re-arm next week's occurrence, mirroring DueReminderAlarmReceiver's own
        // unconditional self-reschedule - a skipped/already-done day doesn't disturb the
        // recurring schedule itself, only this one visible post.
        DueReminderScheduler.armWindowStart(context, entry)
    }
}
