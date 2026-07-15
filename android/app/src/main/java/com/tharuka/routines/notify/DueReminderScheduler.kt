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
// A PendingIntent requestCode namespace, not a notification id - the window-start alarm and the
// due-time alarm both eventually post to the *same* notification id (dueReminderNotificationId),
// but need distinct AlarmManager PendingIntents to coexist as two separate armed alarms. Sits in
// the gap between DUE_REMINDER_ID_BASE (600M) and GROUP_SUMMARY_ID_BASE (700M) - see CLAUDE.md's
// notification-id-ranges list, which this must stay disjoint from too.
internal const val WINDOW_START_ALARM_ID_BASE = 620_000_000
// Same PendingIntent-requestCode namespace reasoning as WINDOW_START_ALARM_ID_BASE - a third,
// independently-armed alarm per task, also eventually posting to (or here, clearing) the same
// notification id. 640M keeps a clean 20M-wide gap alongside the other two in this "due-reminder
// alarm family" cluster, still disjoint from every other range in CLAUDE.md's list.
internal const val EXPIRY_ALARM_ID_BASE = 640_000_000
// A short delay after a task's own due-by moment (entry.hour:entry.minute), not a shared
// end-of-day cutoff every task waits until - "the expected [period] end" is that task's own
// due-by time, individually different per task. The buffer exists purely so this alarm can't race
// the due-time alarm itself, which needs to actually post/re-alert the notification at
// entry.hour:entry.minute before this dismisses it - AlarmManager doesn't guarantee ordering
// between two independently-scheduled alarms landing at the identical millisecond.
internal const val EXPIRY_BUFFER_MS = 2 * 60_000L
internal const val EXTRA_TASK_ID = "taskId"

internal fun dueReminderNotificationId(taskId: String): Int = DUE_REMINDER_ID_BASE + hashToInt(taskId)

/** Today's date as 'YYYY-MM-DD', matching the dateKey format task_reschedules/skipDates use -
 * shared by DueReminderScheduler's catch-up check and DueReminderAlarmReceiver/
 * ExtraReminderAlarmReceiver's fire-time skip check. */
internal fun todayDateKey(): String {
    val calendar = Calendar.getInstance()
    val year = calendar.get(Calendar.YEAR)
    val month = calendar.get(Calendar.MONTH) + 1
    val day = calendar.get(Calendar.DAY_OF_MONTH)
    return "%04d-%02d-%02d".format(year, month, day)
}

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
        val incoming = entry.copy(doneToday = isDoneToday)
        val existing = DueReminderStore.read(context, incoming.taskId)
        // Content-only equality (ignoring awaitingCompletion/doneToday, both bookkeeping, not
        // content) is what removes the need to ever destructively cancel+rearm on every resync -
        // the exact bug catchUpDueReminderIfNeeded (formerly in src/notifications.js) was built to
        // patch around for the old stock-plugin-backed reminder.
        val contentUnchanged = existing?.copy(awaitingCompletion = false, doneToday = false) ==
            incoming.copy(awaitingCompletion = false, doneToday = false)

        val calendar = Calendar.getInstance()
        // Calendar.DAY_OF_WEEK is 1=Sunday..7=Saturday; isOverdueToday/computeNextOccurrenceDaysFromNow
        // use JS's Date.getDay() convention (0=Sunday..6=Saturday) - see arm() below.
        val todayWeekday = calendar.get(Calendar.DAY_OF_WEEK) - 1
        val nowHour = calendar.get(Calendar.HOUR_OF_DAY)
        val nowMinute = calendar.get(Calendar.MINUTE)
        // A skip date means this week's occurrence was moved elsewhere (task_reschedules) - the
        // task genuinely isn't due today, so there's nothing to catch up on even if the
        // day-of-week/time math alone would otherwise call it overdue.
        val skippedToday = incoming.skipDates.contains(todayDateKey())
        val overdueToday = !isDoneToday && !skippedToday &&
            isOverdueToday(incoming.days, incoming.hour, incoming.minute, todayWeekday, nowHour, nowMinute)
        val alreadyCaughtUp = contentUnchanged && existing?.awaitingCompletion == true

        if (contentUnchanged && !(overdueToday && !alreadyCaughtUp)) {
            // Pure resync: nothing about the reminder's real content changed and there's nothing
            // new to catch up on - leave the existing alarm/notification exactly as they are.
            // doneToday is bookkeeping-only, but still needs to stay fresh even on this fast path -
            // DueReminderAlarmReceiver/WindowStartAlarmReceiver read it later and can't compute
            // isTaskDoneToday themselves, so a stale value here would let an already-completed
            // task's alarm post/re-alert anyway once it fires.
            if (existing != null && existing.doneToday != isDoneToday) {
                DueReminderStore.save(context, existing.copy(doneToday = isDoneToday))
            }
            return
        }

        val awaitingCompletion = overdueToday || (contentUnchanged && existing?.awaitingCompletion == true)
        DueReminderStore.save(context, incoming.copy(awaitingCompletion = awaitingCompletion))

        if (overdueToday && !alreadyCaughtUp) {
            // The reminder should already be showing (due today, not done) but isn't going to
            // fire on its own - arm() only ever targets a future occurrence, never "later today
            // if already passed" (see computeNextOccurrenceDaysFromNow). Without this, a
            // brand-new or just-edited overdue task - or one whose alarm silently missed its
            // moment (doze, device off) - would stay silent until its next natural occurrence,
            // possibly a full week away.
            val notification = buildDueReminderNotification(context, incoming)
            NotificationManagerCompat.from(context).notify(dueReminderNotificationId(incoming.taskId), notification)
            // Today's own due moment has already passed (that's what overdueToday means), so
            // armExpiry's normal next-occurrence math would skip straight to next week for the
            // exact same reason arm() does - leaving this just-caught-up notification with no
            // expiry armed for today at all. Arm one directly, a short buffer from right now,
            // instead; its own self-reschedule (DueReminderExpiryAlarmReceiver) re-establishes
            // the normal weekly cadence from there.
            armExpiryAt(context, incoming.taskId, System.currentTimeMillis() + EXPIRY_BUFFER_MS)
        }
        if (!contentUnchanged) {
            arm(context, incoming)
            armWindowStart(context, incoming)
            if (!overdueToday) armExpiry(context, incoming)
        }
    }

    fun cancel(context: Context, taskId: String) {
        DueReminderStore.clear(context, taskId)
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.cancel(pendingIntent(context, taskId))
        cancelWindowStart(context, taskId)
        cancelExpiry(context, taskId)
    }

    /**
     * Arms a once-per-due-day cleanup alarm a short buffer (EXPIRY_BUFFER_MS) after *this task's
     * own* due-by moment (entry.hour:entry.minute) that auto-dismisses the reminder if it's still
     * showing, whether the task was ever completed or not - an individual, per-task moment, not a
     * single clock time every task shares. Applies unconditionally to every task (unlike
     * armWindowStart, there's no opt-in), so a reminder never lingers, pinned or otherwise, past
     * its own due time.
     */
    internal fun armExpiry(context: Context, entry: DueReminderEntry) {
        val calendar = Calendar.getInstance()
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

        armExpiryAt(context, entry.taskId, calendar.timeInMillis + EXPIRY_BUFFER_MS)
    }

    internal fun armExpiryAt(context: Context, taskId: String, triggerAtMillis: Long) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = expiryPendingIntent(context, taskId)
        val canScheduleExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()
        if (canScheduleExact) {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending)
        } else {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending)
        }
    }

    internal fun cancelExpiry(context: Context, taskId: String) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.cancel(expiryPendingIntent(context, taskId))
    }

    private fun expiryPendingIntent(context: Context, taskId: String): PendingIntent {
        val intent = Intent(context, DueReminderExpiryAlarmReceiver::class.java)
        intent.putExtra(EXTRA_TASK_ID, taskId)
        return PendingIntent.getBroadcast(
            context,
            EXPIRY_ALARM_ID_BASE + hashToInt(taskId),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * Arms (or, if the task has no real windowStart, cancels) a proactive, silent post of the
     * same due-reminder notification at task.windowStart - showing live status throughout a
     * task's "active window," not just from its due-by time onward. A completely separate armed
     * alarm from arm()/the due-time alarm (see WINDOW_START_ALARM_ID_BASE), even though both
     * eventually post to the same notification id - the due-time alarm firing later still
     * re-alerts normally, since actually becoming due is a real, attention-worthy moment.
     */
    internal fun armWindowStart(context: Context, entry: DueReminderEntry) {
        val hour = entry.windowStartHour
        if (hour == null) {
            cancelWindowStart(context, entry.taskId)
            return
        }
        val minute = entry.windowStartMinute ?: 0

        val calendar = Calendar.getInstance()
        val todayWeekday = calendar.get(Calendar.DAY_OF_WEEK) - 1
        val nowHour = calendar.get(Calendar.HOUR_OF_DAY)
        val nowMinute = calendar.get(Calendar.MINUTE)
        val daysFromNow = computeNextOccurrenceDaysFromNow(
            entry.days,
            hour,
            minute,
            todayWeekday,
            nowHour,
            nowMinute,
        ) ?: return

        calendar.add(Calendar.DAY_OF_YEAR, daysFromNow)
        calendar.set(Calendar.HOUR_OF_DAY, hour)
        calendar.set(Calendar.MINUTE, minute)
        calendar.set(Calendar.SECOND, 0)
        calendar.set(Calendar.MILLISECOND, 0)

        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = windowStartPendingIntent(context, entry.taskId)
        val canScheduleExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()
        if (canScheduleExact) {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, calendar.timeInMillis, pending)
        } else {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, calendar.timeInMillis, pending)
        }
    }

    internal fun cancelWindowStart(context: Context, taskId: String) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.cancel(windowStartPendingIntent(context, taskId))
    }

    private fun windowStartPendingIntent(context: Context, taskId: String): PendingIntent {
        val intent = Intent(context, WindowStartAlarmReceiver::class.java)
        intent.putExtra(EXTRA_TASK_ID, taskId)
        return PendingIntent.getBroadcast(
            context,
            WINDOW_START_ALARM_ID_BASE + hashToInt(taskId),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
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
