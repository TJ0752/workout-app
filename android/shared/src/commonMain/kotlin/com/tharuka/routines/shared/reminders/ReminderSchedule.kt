package com.tharuka.routines.shared.reminders

/**
 * Given the set of active weekdays and the due hour/minute, returns how many days from today
 * (0 = later today, 1 = tomorrow, ... up to 6) the next occurrence falls on, or null if `days`
 * is empty. `days`/`todayWeekday` use JS's Date.getDay() convention (0=Sunday..6=Saturday) so
 * task.days can be passed straight through from JS with no translation - only the Android
 * caller's own Calendar.DAY_OF_WEEK (1=Sunday..7=Saturday) needs a -1 conversion at the
 * boundary.
 *
 * This replaces the stock @capacitor/local-notifications plugin's DateMatch.postponeTriggerIfNeeded,
 * which jumps a full week forward once today's hour:minute has passed rather than considering
 * whether a different day this week still qualifies - see catchUpDueReminderIfNeeded in
 * src/notifications.js for the workaround this was built to eliminate.
 */
fun computeNextOccurrenceDaysFromNow(
    days: List<Int>,
    hour: Int,
    minute: Int,
    todayWeekday: Int,
    nowHour: Int,
    nowMinute: Int,
): Int? {
    if (days.isEmpty()) return null

    val todayStillUpcoming = days.contains(todayWeekday) && (hour > nowHour || (hour == nowHour && minute > nowMinute))
    if (todayStillUpcoming) return 0

    for (offset in 1..7) {
        val weekday = (todayWeekday + offset) % 7
        if (days.contains(weekday)) return offset
    }
    return null // unreachable when days is non-empty, but keeps the function total
}

/**
 * Deterministic, stable hash for deriving a native notification id from a task id string -
 * doesn't need to match src/notifications.js's own hashToInt bit-for-bit (they feed disjoint id
 * ranges, see CLAUDE.md), just needs to be idempotent for the same input.
 */
fun hashToInt(str: String): Int {
    var h = 0
    for (ch in str) {
        h = h * 31 + ch.code
    }
    // abs(Int.MIN_VALUE) overflows and stays negative on the JVM, unlike JS's float-based
    // Math.abs - guard explicitly rather than risk an occasional negative id.
    val absH = if (h == Int.MIN_VALUE) 0 else kotlin.math.abs(h)
    return absH % 1_000_000
}
