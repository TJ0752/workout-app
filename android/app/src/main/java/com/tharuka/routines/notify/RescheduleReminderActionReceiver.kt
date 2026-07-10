package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Mirrors DueReminderActionReceiver's Mark-done/+N/Snooze handling for a one-shot rescheduled
 * reminder. Mark-done/+N reuse dispatchDueReminderAction as-is - JS's "dueReminderAction"
 * listener dispatches purely by actionId/taskId, with no notion of which native mechanism sent
 * it, so no second JS listener is needed. Snooze re-arms this same one-shot alarm 15 minutes
 * later instead of any recurring slot.
 */
class RescheduleReminderActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        val newDate = intent.getStringExtra(EXTRA_NEW_DATE) ?: return
        when (intent.action) {
            ACTION_MARK_DONE -> dispatchDueReminderAction(context, taskId, "MARK_DONE", null)
            ACTION_ADD_QUANTITY -> {
                val amount = intent.getIntExtra(EXTRA_AMOUNT, 0)
                dispatchDueReminderAction(context, taskId, "ADD_QUANTITY", amount)
            }
            ACTION_SNOOZE -> {
                val triggerAtMillis = System.currentTimeMillis() + SNOOZE_MINUTES * 60_000L
                RescheduleReminderScheduler.armAt(context, taskId, newDate, triggerAtMillis)
            }
        }
    }
}
