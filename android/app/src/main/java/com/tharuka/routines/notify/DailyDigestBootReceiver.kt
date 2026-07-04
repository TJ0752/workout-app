package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** AlarmManager alarms don't survive reboot on their own - re-arms every stored digest kind. */
class DailyDigestBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        for (entry in DailyDigestStore.readAll(context)) {
            DailyDigestScheduler.arm(context, entry)
        }
    }
}
