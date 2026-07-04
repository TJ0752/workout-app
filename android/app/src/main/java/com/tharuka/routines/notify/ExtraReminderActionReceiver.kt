package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles Mark-done/+N/Snooze taps on an extra reminder. Mark-done/+N dispatch through the
 * exact same dispatchDueReminderAction path (and the same "dueReminderAction" JS event) the
 * due-by reminder's own action receiver uses - JS's handler dispatches purely by
 * actionId/taskId, it has no notion of which native mechanism sent it, so no new JS listener is
 * needed. Snooze re-arms this specific (task, slot) alarm 15 minutes out, same pattern as the
 * due reminder's own snooze.
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
                ExtraReminderScheduler.armAt(context, taskId, slot, triggerAtMillis)
            }
        }
    }
}
