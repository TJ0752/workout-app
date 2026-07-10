package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * AlarmManager alarms do not survive reboot on their own (see DueReminderBootReceiver's own doc
 * comment) - re-arms every RescheduleReminderStore entry via the exact same arm() a fresh
 * schedule() call would use. arm()'s own "skip if the moment already passed" guard naturally
 * no-ops any entry whose target date/time fell during the reboot window, rather than firing a
 * surprise notification for an occurrence that's already come and gone.
 *
 * Not directBootAware, and no LOCKED_BOOT_COMPLETED - same real crash already documented for the
 * other three boot receivers in CLAUDE.md: SharedPreferences (credential-encrypted by default)
 * aren't readable until after the user's first unlock post-reboot, and BOOT_COMPLETED alone
 * already fires at that point, which is early enough.
 */
class RescheduleReminderBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        for (entry in RescheduleReminderStore.readAll(context)) {
            RescheduleReminderScheduler.arm(context, entry)
        }
    }
}
