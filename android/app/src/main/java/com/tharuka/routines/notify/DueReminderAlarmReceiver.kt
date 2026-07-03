package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Fires when a due reminder's alarm goes off. Stub for now (Stage 4 only needs
 * DueReminderScheduler to compile against a real class) - building/posting the actual
 * notification and self-rescheduling next week's occurrence is the next stage.
 */
class DueReminderAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // TODO: build and post the notification from DueReminderStore, then re-arm next week.
    }
}
