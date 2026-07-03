package com.tharuka.routines.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.tharuka.routines.shared.reminders.computeNextOccurrenceDaysFromNow
import com.tharuka.routines.shared.reminders.hashToInt
import java.util.Calendar

// Sits in the gap between JS-owned ranges (EXTRA_REMINDER_ID_BASE=500,000,000,
// GROUP_SUMMARY_ID_BASE=700,000,000 in src/notifications.js) and the native
// SUMMARY_NOTIFICATION_ID=800,000,001 also introduced by this migration - see CLAUDE.md.
internal const val DUE_REMINDER_ID_BASE = 600_000_000
internal const val EXTRA_TASK_ID = "taskId"

internal fun dueReminderNotificationId(taskId: String): Int = DUE_REMINDER_ID_BASE + hashToInt(taskId)

/**
 * Owns the due-by reminder's entire alarm lifecycle - schedule(), cancel(), and the next-trigger
 * arithmetic - replacing @capacitor/local-notifications for this one notification type, since it
 * builds its own notifications with no exposed hook for a custom setDeleteIntent() (see
 * CLAUDE.md). Unlike the stock plugin's own AlarmManager.setRepeating() use, this arms one
 * one-shot alarm at a time and re-arms it after each fire (see DueReminderAlarmReceiver) -
 * avoids setRepeating's long-run drift and matches the self-rescheduling pattern already
 * confirmed in the stock plugin's own TimedNotificationPublisher.
 */
object DueReminderScheduler {
    fun schedule(context: Context, entry: DueReminderEntry) {
        val existing = DueReminderStore.read(context, entry.taskId)
        // No-op if nothing that affects the alarm or its content actually changed - this is
        // what removes the need to ever destructively cancel+rearm on every resync, the exact
        // bug catchUpDueReminderIfNeeded (src/notifications.js) was built to patch around for
        // the old stock-plugin-backed reminder.
        if (existing != null &&
            existing.days == entry.days &&
            existing.hour == entry.hour &&
            existing.minute == entry.minute &&
            existing.title == entry.title &&
            existing.body == entry.body &&
            existing.group == entry.group &&
            existing.completionType == entry.completionType &&
            existing.quickAddAmounts == entry.quickAddAmounts
        ) {
            return
        }
        DueReminderStore.save(context, entry.copy(awaitingCompletion = existing?.awaitingCompletion ?: false))
        arm(context, entry)
    }

    fun cancel(context: Context, taskId: String) {
        DueReminderStore.clear(context, taskId)
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.cancel(pendingIntent(context, taskId))
    }

    internal fun arm(context: Context, entry: DueReminderEntry) {
        val calendar = Calendar.getInstance()
        // Calendar.DAY_OF_WEEK is 1=Sunday..7=Saturday; computeNextOccurrenceDaysFromNow uses
        // JS's Date.getDay() convention (0=Sunday..6=Saturday) so task.days passes straight
        // through from JS with no translation - only this boundary needs the -1 conversion.
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

        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val triggerAtMillis = calendar.timeInMillis
        val pending = pendingIntent(context, entry.taskId)
        // Matches @capacitor/local-notifications' own graceful degradation (confirmed by
        // reading its source) - never hard-require SCHEDULE_EXACT_ALARM.
        val canScheduleExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()
        if (canScheduleExact) {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending)
        } else {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending)
        }
    }

    internal fun pendingIntent(context: Context, taskId: String): PendingIntent {
        val intent = Intent(context, DueReminderAlarmReceiver::class.java)
        intent.putExtra(EXTRA_TASK_ID, taskId)
        return PendingIntent.getBroadcast(
            context,
            dueReminderNotificationId(taskId),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
