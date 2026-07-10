package com.tharuka.routines.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.tharuka.routines.shared.reminders.hashToInt
import java.util.Calendar

// Fresh, disjoint value against every other range in CLAUDE.md's notification-id table -
// distinct from EXTRA_REMINDER_ID_BASE (450,000,000) and DUE_REMINDER_ID_BASE (600,000,000).
internal const val RESCHEDULE_REMINDER_ID_BASE = 480_000_000
internal const val EXTRA_NEW_DATE = "newDate"

internal fun rescheduleReminderNotificationId(taskId: String, newDate: String): Int =
    RESCHEDULE_REMINDER_ID_BASE + hashToInt("$taskId:$newDate")

/**
 * A genuinely one-shot alarm - unlike DueReminderScheduler/ExtraReminderScheduler, which always
 * arm the *next* occurrence across a recurring set of weekdays, a rescheduled occurrence's
 * reminder fires exactly once, on the single specific calendar date task_reschedules moved it
 * to, and is never re-armed after firing. Parses entry.newDate ('YYYY-MM-DD') directly into a
 * Calendar moment rather than reusing computeNextOccurrenceDaysFromNow's day-of-week arithmetic,
 * since there's no recurrence to compute here at all.
 */
object RescheduleReminderScheduler {
    fun schedule(context: Context, entry: RescheduleReminderEntry) {
        val existing = RescheduleReminderStore.read(context, entry.taskId, entry.newDate)
        if (existing == entry) return // pure resync, nothing changed - leave the existing alarm alone

        RescheduleReminderStore.save(context, entry)
        arm(context, entry)
    }

    fun cancel(context: Context, taskId: String, newDate: String) {
        RescheduleReminderStore.clear(context, taskId, newDate)
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.cancel(pendingIntent(context, taskId, newDate))
    }

    fun cancelAllForTask(context: Context, taskId: String) {
        for (entry in RescheduleReminderStore.readAllForTask(context, taskId)) {
            cancel(context, taskId, entry.newDate)
        }
    }

    /**
     * Silently skips arming if the parsed moment has already passed - a reschedule made after
     * its own target date/time has nothing left to remind about. RescheduleReminderBootReceiver
     * relies on this same guard to naturally no-op a stale entry on reboot instead of firing a
     * surprise notification days late for an occurrence that's already come and gone.
     */
    internal fun arm(context: Context, entry: RescheduleReminderEntry) {
        val parts = entry.newDate.split("-")
        if (parts.size != 3) return
        val year = parts[0].toIntOrNull() ?: return
        val month = parts[1].toIntOrNull() ?: return
        val day = parts[2].toIntOrNull() ?: return

        val calendar = Calendar.getInstance()
        calendar.set(year, month - 1, day, entry.hour, entry.minute, 0)
        calendar.set(Calendar.MILLISECOND, 0)
        if (calendar.timeInMillis <= System.currentTimeMillis()) return

        armAt(context, entry.taskId, entry.newDate, calendar.timeInMillis)
    }

    /** Shared by arm() and RescheduleReminderActionReceiver's Snooze handling (now + 15min) -
     * same reused-PendingIntent-slot pattern as DueReminderScheduler/ExtraReminderScheduler. */
    internal fun armAt(context: Context, taskId: String, newDate: String, triggerAtMillis: Long) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = pendingIntent(context, taskId, newDate)
        val canScheduleExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()
        if (canScheduleExact) {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending)
        } else {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending)
        }
    }

    internal fun pendingIntent(context: Context, taskId: String, newDate: String): PendingIntent {
        val intent = Intent(context, RescheduleReminderAlarmReceiver::class.java)
        intent.putExtra(EXTRA_TASK_ID, taskId)
        intent.putExtra(EXTRA_NEW_DATE, newDate)
        return PendingIntent.getBroadcast(
            context,
            rescheduleReminderNotificationId(taskId, newDate),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
