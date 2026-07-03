package com.tharuka.routines.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.tharuka.routines.shared.reminders.computeNextOccurrenceDaysFromNow
import com.tharuka.routines.shared.reminders.hashToInt
import com.tharuka.routines.shared.reminders.isOverdueToday
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
    /**
     * `isDoneToday` comes from the caller (src/notifications.js's isTaskDoneToday, computed
     * against SQLite completions) since native code must never read the app's DB directly (see
     * CLAUDE.md) - it's the one piece of state this decision needs that isn't already in
     * DueReminderEntry.
     */
    fun schedule(context: Context, entry: DueReminderEntry, isDoneToday: Boolean) {
        val existing = DueReminderStore.read(context, entry.taskId)
        // Content-only equality (ignoring awaitingCompletion, which is bookkeeping, not content)
        // is what removes the need to ever destructively cancel+rearm on every resync - the exact
        // bug catchUpDueReminderIfNeeded (formerly in src/notifications.js) was built to patch
        // around for the old stock-plugin-backed reminder.
        val contentUnchanged = existing?.copy(awaitingCompletion = false) == entry.copy(awaitingCompletion = false)

        val calendar = Calendar.getInstance()
        // Calendar.DAY_OF_WEEK is 1=Sunday..7=Saturday; isOverdueToday/computeNextOccurrenceDaysFromNow
        // use JS's Date.getDay() convention (0=Sunday..6=Saturday) - see arm() below.
        val todayWeekday = calendar.get(Calendar.DAY_OF_WEEK) - 1
        val nowHour = calendar.get(Calendar.HOUR_OF_DAY)
        val nowMinute = calendar.get(Calendar.MINUTE)
        val overdueToday = !isDoneToday && isOverdueToday(entry.days, entry.hour, entry.minute, todayWeekday, nowHour, nowMinute)
        val alreadyCaughtUp = contentUnchanged && existing?.awaitingCompletion == true

        if (contentUnchanged && !(overdueToday && !alreadyCaughtUp)) {
            // Pure resync: nothing about the reminder's content changed and there's nothing new
            // to catch up on - leave the existing alarm/notification exactly as they are.
            return
        }

        val awaitingCompletion = overdueToday || (contentUnchanged && existing?.awaitingCompletion == true)
        DueReminderStore.save(context, entry.copy(awaitingCompletion = awaitingCompletion))

        if (overdueToday && !alreadyCaughtUp) {
            // The reminder should already be showing (due today, not done) but isn't going to
            // fire on its own - arm() only ever targets a future occurrence, never "later today
            // if already passed" (see computeNextOccurrenceDaysFromNow). Without this, a
            // brand-new or just-edited overdue task - or one whose alarm silently missed its
            // moment (doze, device off) - would stay silent until its next natural occurrence,
            // possibly a full week away.
            val notification = buildDueReminderNotification(context, entry)
            NotificationManagerCompat.from(context).notify(dueReminderNotificationId(entry.taskId), notification)
        }
        if (!contentUnchanged) {
            arm(context, entry)
        }
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

        armAt(context, entry.taskId, calendar.timeInMillis)
    }

    /**
     * Re-arms the same per-task alarm slot for an arbitrary future time - shared by arm() (the
     * next scheduled occurrence) and DueReminderActionReceiver's Snooze handling (now + 15min).
     * Reusing the same PendingIntent/requestCode is deliberate: whichever fires next naturally
     * overrides the other via FLAG_UPDATE_CURRENT, and when the snoozed alarm eventually fires it
     * re-arms the real next occurrence itself (see DueReminderAlarmReceiver), so snoozing needs
     * no separate bookkeeping beyond a temporary earlier alarm.
     */
    internal fun armAt(context: Context, taskId: String, triggerAtMillis: Long) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = pendingIntent(context, taskId)
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
