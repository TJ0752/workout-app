package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * AlarmManager alarms do not survive reboot on their own - confirmed from
 * @capacitor/local-notifications' own LocalNotificationRestoreReceiver, which exists purely to
 * re-arm every alarm from its own persisted store after boot. This mirrors that pattern for the
 * due-by reminder's alarms: re-arm every DueReminderStore entry via the exact same scheduling
 * logic normal (re)scheduling uses, so a rebooted device ends up in the same state a fresh
 * schedule() call would produce.
 */
class DueReminderBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        for (entry in DueReminderStore.readAll(context)) {
            DueReminderScheduler.arm(context, entry)
            DueReminderScheduler.armWindowStart(context, entry)
        }
    }
}
