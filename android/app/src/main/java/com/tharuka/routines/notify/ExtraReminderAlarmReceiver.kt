package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat

/**
 * Fires when an extra-reminder alarm goes off - reads the entry from the store (not app
 * memory) so this works with the app process fully dead, posts the notification, and
 * immediately self-reschedules the next occurrence, mirroring DueReminderAlarmReceiver's
 * self-rescheduling pattern.
 */
class ExtraReminderAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // TEMPORARY diagnostic logging - see scripts/verify-extra-reminder.mjs's file header
        // for why: dumpsys activity broadcasts reports this receiver as "Skipped (manifest)"
        // for every broadcast sent to it via `adb shell am broadcast -n`, even with
        // --include-stopped-packages and with no `am force-stop` anywhere in the test flow.
        // This log line settles unambiguously whether onReceive() ever actually runs, instead
        // of relying on dumpsys's own dump-format terminology, which may not mean what it
        // looks like it means. Remove once the emulator-verify investigation concludes.
        Log.i("ExtraReminderDiag", "onReceive called, action=${intent.action} extras=${intent.extras}")
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: run {
            Log.i("ExtraReminderDiag", "no taskId extra, returning early")
            return
        }
        val slot = intent.getIntExtra(EXTRA_SLOT, -1)
        if (slot < 0) {
            Log.i("ExtraReminderDiag", "no slot extra, returning early")
            return
        }
        val entry = ExtraReminderStore.read(context, taskId, slot) ?: run {
            Log.i("ExtraReminderDiag", "no store entry for $taskId:$slot, returning early")
            return
        }
        Log.i("ExtraReminderDiag", "building and posting notification for $taskId:$slot")
        val notification = buildExtraReminderNotification(context, entry)
        NotificationManagerCompat.from(context).notify(extraReminderNotificationId(taskId, slot), notification)
        Log.i("ExtraReminderDiag", "notify() call completed")
        ExtraReminderScheduler.arm(context, entry)
    }
}
