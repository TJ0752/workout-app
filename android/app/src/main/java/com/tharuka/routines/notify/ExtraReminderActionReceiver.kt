package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles Mark-done/+N/Snooze taps on an extra reminder. Mark-done/+N dispatch through the
 * exact same dispatchDueReminderAction path (and the same "dueReminderAction" JS event) the
 * due-by reminder's own action receiver uses - JS's handler dispatches purely by
 * actionId/taskId, it has no notion of which native mechanism sent it, so no new JS listener is
 * needed.
 *
 * Snooze re-arms the *due-by reminder's own* alarm slot (DueReminderScheduler.armAt), not this
 * (task, slot)'s own extra-reminder alarm - since the merged notification (see
 * ExtraReminderAlarmReceiver) is now always built from DueReminderStore's content and posted
 * under the due reminder's own id, "snooze this" means "re-alert the one notification for this
 * task in 15 minutes," a single concept independent of whichever nudge happened to be showing
 * when it was tapped. This specific (task, slot)'s own regular extra-reminder schedule is left
 * completely untouched and keeps firing at its configured time regardless of any snooze -
 * DueReminderAlarmReceiver already self-corrects back to the real next due-by occurrence the
 * moment the snoozed alarm fires (see DueReminderScheduler.arm()), so temporarily reusing its
 * PendingIntent slot for an earlier one-off fire has no lasting effect on the due-by schedule.
 */
class ExtraReminderActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        val slot = intent.getIntExtra(EXTRA_SLOT, -1)
        if (slot < 0) return
        when (intent.action) {
            ACTION_MARK_DONE -> dispatchDueReminderAction(context, taskId, "MARK_DONE", null)
            ACTION_ADD_QUANTITY -> {
                val amount = intent.getIntExtra(EXTRA_AMOUNT, 0)
                dispatchDueReminderAction(context, taskId, "ADD_QUANTITY", amount)
            }
            ACTION_SNOOZE -> {
                val triggerAtMillis = System.currentTimeMillis() + SNOOZE_MINUTES * 60_000L
                DueReminderScheduler.armAt(context, taskId, triggerAtMillis)
            }
        }
    }
}
