package com.tharuka.routines.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.tharuka.routines.shared.reminders.computeNextOccurrenceDaysFromNow
import java.util.Calendar

internal const val EXTRA_DIGEST_KIND = "kind"

// Fixed ids per kind (not hashed - there are only ever these 3) - same numeric values as the
// JS-side constants they replace (src/notifications.js), see CLAUDE.md's id-range table.
internal const val MORNING_DIGEST_ID = 900_000_002
internal const val EVENING_DIGEST_ID = 900_000_003
internal const val STREAK_RISK_ID = 900_000_004

internal fun dailyDigestNotificationId(kind: String): Int = when (kind) {
    "morning" -> MORNING_DIGEST_ID
    "evening" -> EVENING_DIGEST_ID
    "streak-risk" -> STREAK_RISK_ID
    else -> error("Unknown daily digest kind: $kind")
}

private val ALL_DAYS = listOf(0, 1, 2, 3, 4, 5, 6)

/**
 * Owns the daily-digest alarm lifecycle for all 3 kinds - one self-rescheduling alarm per kind,
 * firing every day at its own hour:minute, mirroring DueReminderScheduler's arm()/armAt() but
 * with no per-day catch-up logic - digest/streak-risk content is recomputed and re-pushed by JS
 * on every sync (see updateMorningDigest/updateEveningDigest/updateStreakRiskNotification in
 * src/notifications.js), not caught up natively.
 */
object DailyDigestScheduler {
    fun schedule(context: Context, entry: DailyDigestEntry) {
        val existing = DailyDigestStore.read(context, entry.kind)
        if (existing == entry) return // pure resync, nothing changed - leave the existing alarm alone

        DailyDigestStore.save(context, entry)
        arm(context, entry)
    }

    fun cancel(context: Context, kind: String) {
        DailyDigestStore.clear(context, kind)
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.cancel(pendingIntent(context, kind))
    }

    internal fun arm(context: Context, entry: DailyDigestEntry) {
        val calendar = Calendar.getInstance()
        val todayWeekday = calendar.get(Calendar.DAY_OF_WEEK) - 1
        val nowHour = calendar.get(Calendar.HOUR_OF_DAY)
        val nowMinute = calendar.get(Calendar.MINUTE)
        val daysFromNow = computeNextOccurrenceDaysFromNow(
            ALL_DAYS,
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

        armAt(context, entry.kind, calendar.timeInMillis)
    }

    internal fun armAt(context: Context, kind: String, triggerAtMillis: Long) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = pendingIntent(context, kind)
        val canScheduleExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()
        if (canScheduleExact) {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending)
        } else {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pending)
        }
    }

    internal fun pendingIntent(context: Context, kind: String): PendingIntent {
        val intent = Intent(context, DailyDigestAlarmReceiver::class.java)
        intent.putExtra(EXTRA_DIGEST_KIND, kind)
        return PendingIntent.getBroadcast(
            context,
            dailyDigestNotificationId(kind),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
