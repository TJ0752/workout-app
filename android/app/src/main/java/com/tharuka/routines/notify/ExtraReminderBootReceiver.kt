package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * AlarmManager alarms don't survive reboot on their own - re-arms every stored extra-reminder
 * alarm using the exact same scheduling logic normal (re)scheduling uses, mirroring
 * DueReminderBootReceiver.
 */
class ExtraReminderBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        for (entry in ExtraReminderStore.readAll(context)) {
            ExtraReminderScheduler.arm(context, entry)
        }
    }
}
