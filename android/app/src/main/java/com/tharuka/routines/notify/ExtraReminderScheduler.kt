package com.tharuka.routines.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.tharuka.routines.shared.reminders.computeNextOccurrenceDaysFromNow
import com.tharuka.routines.shared.reminders.hashToInt
import java.util.Calendar

// Disjoint from every other range in CLAUDE.md's notification-id table. The old JS-side
// EXTRA_REMINDER_ID_BASE (500,000,000, in src/notifications.js) is retired in the same
// migration that introduces this, rather than silently reused - this is an intentionally fresh
// value.
internal const val EXTRA_REMINDER_ID_BASE = 450_000_000
internal const val EXTRA_SLOT = "slot"

internal fun extraReminderNotificationId(taskId: String, slot: Int): Int =
    EXTRA_REMINDER_ID_BASE + hashToInt("$taskId:$slot")

/**
 * Owns the extra-reminder alarm lifecycle - one self-rescheduling alarm per (task, slot),
 * mirroring DueReminderScheduler's arm()/armAt() but without the due-by moment's
 * catch-up/overdue-today logic (extra reminders are plain nudges leading up to the real due
 * time, never pinned/reappearing) - so scheduling is just "is the content the same as last
 * time, and if not, save + re-arm."
 */
object ExtraReminderScheduler {
    fun schedule(context: Context, entry: ExtraReminderEntry) {
        val existing = ExtraReminderStore.read(context, entry.taskId, entry.slot)
        if (existing == entry) return // pure resync, nothing changed - leave the existing alarm alone

        ExtraReminderStore.save(context, entry)
        arm(context, entry)
    }

    fun cancel(context: Context, taskId: String, slot: Int) {
        ExtraReminderStore.clear(context, taskId, slot)
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.cancel(pendingIntent(context, taskId, slot))
    }

    fun cancelAllForTask(context: Context, taskId: String) {
        for (slot in 0 until MAX_EXTRA_REMINDERS) {
            cancel(context, taskId, slot)
        }
    }

    internal fun arm(context: Context, entry: ExtraReminderEntry) {
        val calendar = Calendar.getInstance()
        // Calendar.DAY_OF_WEEK is 1=Sunday..7=Saturday; computeNextOccurrenceDaysFromNow uses
        // JS's Date.getDay() convention (0=Sunday..6=Saturday) - see DueReminderScheduler.arm().
        val todayWeekday = calendar.get(Calendar.DAY_OF_WEEK) - 1
        val nowHour = calendar.get(Calendar.HOUR_OF_DAY)
        val nowMinute = calendar.get(Calendar.MINUTE)
        val daysFromNow = computeNextOccurrenceDaysFromNow(
            entry.days,
            entry.hour,
            entry.minute,
            todayWeekday,
            nowHour,
            nowMinute,
        ) ?: return

        calendar.add(Calendar.DAY_OF_YEAR, daysFromNow)
        calendar.set(Calendar.HOUR_OF_DAY, entry.hour)
        calendar.set(Calendar.MINUTE, entry.minute)
        calendar.set(Calendar.SECOND, 0)
        calendar.set(Calendar.MILLISECOND, 0)

        armAt(context, entry.taskId, entry.slot, calendar.timeInMillis)
    }

    /** Shared by arm() (the next scheduled occurrence) and ExtraReminderActionReceiver's Snooze
     * handling (now + 15min) - same reused-PendingIntent-slot pattern as DueReminderScheduler. */
    internal fun armAt(context: Context, taskId: String, slot: Int, triggerAtMillis: Long) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = pendingIntent(context, taskId, slot)
        val canScheduleExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()
        if (canScheduleExact) {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending)
        } else {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending)
        }
    }

    internal fun pendingIntent(context: Context, taskId: String, slot: Int): PendingIntent {
        val intent = Intent(context, ExtraReminderAlarmReceiver::class.java)
        intent.putExtra(EXTRA_TASK_ID, taskId)
        intent.putExtra(EXTRA_SLOT, slot)
        return PendingIntent.getBroadcast(
            context,
            extraReminderNotificationId(taskId, slot),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
