package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Fires when an extra-reminder alarm goes off - reads its own schedule entry (not app memory) so
 * this works with the app process fully dead, and immediately self-reschedules the next
 * occurrence, mirroring DueReminderAlarmReceiver's self-rescheduling pattern.
 *
 * Posts to the *due-by reminder's own* notification id, not a separate one - an extra reminder is
 * conceptually "another nudge toward the same underlying task," not a distinct notification, so
 * firing one re-alerts (sound/vibration, since NotificationCompat re-alerts on every notify() call
 * by default) whatever's already showing for this task rather than adding a second visible entry.
 * This also means the merged notification starts being pinned/reappearing-on-dismiss from
 * whichever nudge fires *first* in a day - extra reminder or the due-by moment itself - not just
 * from the due-by moment onward, since awaitingCompletion is set here too.
 *
 * Falls back to posting its own dedicated notification (the pre-merge behavior) only if no
 * DueReminderStore entry exists for this task - shouldn't normally happen, since
 * scheduleTaskNotifications always schedules a due reminder alongside any extra reminders, but
 * keeping this path means an extra reminder is never silently dropped if that invariant is ever
 * violated.
 */
class ExtraReminderAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        val slot = intent.getIntExtra(EXTRA_SLOT, -1)
        if (slot < 0) return
        val entry = ExtraReminderStore.read(context, taskId, slot) ?: return

        val dueEntry = DueReminderStore.read(context, taskId)
        if (dueEntry != null) {
            DueReminderStore.setAwaitingCompletion(context, taskId, true)
            val notification = buildDueReminderNotification(context, dueEntry.copy(awaitingCompletion = true))
            NotificationManagerCompat.from(context).notify(dueReminderNotificationId(taskId), notification)
        } else {
            val notification = buildExtraReminderNotification(context, entry)
            NotificationManagerCompat.from(context).notify(extraReminderNotificationId(taskId, slot), notification)
        }

        ExtraReminderScheduler.arm(context, entry)
    }
}
