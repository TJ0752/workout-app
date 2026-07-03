package com.tharuka.routines.shared.reminders

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ReminderScheduleTest {
    @Test
    fun computeNextOccurrenceDaysFromNow_emptyDaysReturnsNull() {
        assertNull(computeNextOccurrenceDaysFromNow(emptyList(), 9, 0, todayWeekday = 3, nowHour = 8, nowMinute = 0))
    }

    @Test
    fun computeNextOccurrenceDaysFromNow_laterTodayReturnsZero() {
        val result = computeNextOccurrenceDaysFromNow(
            days = listOf(3),
            hour = 9,
            minute = 0,
            todayWeekday = 3,
            nowHour = 8,
            nowMinute = 30,
        )
        assertEquals(0, result)
    }

    @Test
    fun computeNextOccurrenceDaysFromNow_exactCurrentMinuteIsNotStillUpcoming() {
        // Strictly after now, not equal - an already-due moment should roll to the next
        // occurrence rather than re-match instantly.
        val result = computeNextOccurrenceDaysFromNow(
            days = listOf(3),
            hour = 9,
            minute = 0,
            todayWeekday = 3,
            nowHour = 9,
            nowMinute = 0,
        )
        assertEquals(7, result)
    }

    @Test
    fun computeNextOccurrenceDaysFromNow_pastTodaySkipsToNextActiveDay() {
        // Wednesday, already past due, only Monday active -> 5 days away (Thu,Fri,Sat,Sun,Mon).
        val result = computeNextOccurrenceDaysFromNow(
            days = listOf(1),
            hour = 9,
            minute = 0,
            todayWeekday = 3,
            nowHour = 10,
            nowMinute = 0,
        )
        assertEquals(5, result)
    }

    @Test
    fun computeNextOccurrenceDaysFromNow_wrapsAcrossWeekBoundary() {
        // Saturday, next active day is Sunday -> 1 day away, wrapping past index 6 back to 0.
        val result = computeNextOccurrenceDaysFromNow(
            days = listOf(0),
            hour = 9,
            minute = 0,
            todayWeekday = 6,
            nowHour = 10,
            nowMinute = 0,
        )
        assertEquals(1, result)
    }

    @Test
    fun computeNextOccurrenceDaysFromNow_allSevenDaysPastDueTodayReturnsTomorrow() {
        val result = computeNextOccurrenceDaysFromNow(
            days = listOf(0, 1, 2, 3, 4, 5, 6),
            hour = 9,
            minute = 0,
            todayWeekday = 3,
            nowHour = 10,
            nowMinute = 0,
        )
        assertEquals(1, result)
    }

    @Test
    fun hashToInt_isDeterministic() {
        assertEquals(hashToInt("task-abc"), hashToInt("task-abc"))
    }

    @Test
    fun hashToInt_isNonNegative() {
        val ids = listOf("a", "task-1", "0000000000000000000000000000000000", "z".repeat(500))
        for (id in ids) {
            assertTrue(hashToInt(id) >= 0, "hashToInt(\"$id\") was negative")
        }
    }

    @Test
    fun hashToInt_staysWithinExpectedRange() {
        assertTrue(hashToInt("some-task-id") < 1_000_000)
    }
}
