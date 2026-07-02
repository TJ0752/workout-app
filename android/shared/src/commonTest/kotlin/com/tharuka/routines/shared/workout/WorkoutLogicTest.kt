package com.tharuka.routines.shared.workout

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun set(
    setIndex: Int = 0,
    reps: Int? = 10,
    weight: Double? = 20.0,
    completed: Boolean = true
) = LoggedSet(setIndex, reps, weight, null, completed, null, null)

class WorkoutLogicTest {
    @Test
    fun computeSessionFraction_returnsZeroForNoExercises() {
        assertEquals(0.0, computeSessionFraction(emptyList(), emptyMap()))
    }

    @Test
    fun computeSessionFraction_isCompletedOverPlannedAcrossExercises() {
        val exercises = listOf(
            Exercise("e1", "", 3, null, null, null, "reps", null),
            Exercise("e2", "", 2, null, null, null, "reps", null)
        )
        val logs = mapOf(
            "e1" to listOf(set(0), set(1), set(2, completed = false)),
            "e2" to listOf(set(0))
        )
        // planned = 3 + 2 = 5, completed = 2 + 1 = 3
        assertEquals(0.6, computeSessionFraction(exercises, logs), 0.0001)
    }

    @Test
    fun computeSessionFraction_zeroTargetSetsNeedsAtLeastOne() {
        val exercises = listOf(Exercise("e1", "", 0, null, null, null, "reps", null))
        val logs = mapOf("e1" to listOf(set(0)))
        assertEquals(1.0, computeSessionFraction(exercises, logs))
    }

    @Test
    fun computeSessionFraction_clampsToOne() {
        val exercises = listOf(Exercise("e1", "", 2, null, null, null, "reps", null))
        val logs = mapOf("e1" to listOf(set(0), set(1), set(2), set(3)))
        assertEquals(1.0, computeSessionFraction(exercises, logs))
    }

    @Test
    fun getExerciseVolume_sumsRepsTimesWeightForCompletedSetsOnly() {
        val logs = listOf(
            set(0, reps = 10, weight = 20.0),
            set(1, reps = 8, weight = 25.0),
            set(2, reps = 100, weight = 100.0, completed = false)
        )
        assertEquals(10.0 * 20.0 + 8.0 * 25.0, getExerciseVolume(logs))
    }

    @Test
    fun getExerciseVolume_excludesDurationSetsWithNoWeight() {
        val logs = listOf(set(0, reps = 10, weight = null), set(1, reps = null, weight = 20.0))
        assertEquals(0.0, getExerciseVolume(logs))
    }

    @Test
    fun getExercisePR_picksHighestCompletedWeight() {
        val logs = listOf(
            set(0, weight = 20.0, reps = 10),
            set(1, weight = 40.0, reps = 5),
            set(2, weight = 30.0, reps = 8)
        )
        assertEquals(40.0, getExercisePR(logs)?.weight)
    }

    @Test
    fun getExercisePR_tiesBrokenByHigherReps() {
        val logs = listOf(set(0, weight = 40.0, reps = 5), set(1, weight = 40.0, reps = 8))
        assertEquals(8, getExercisePR(logs)?.reps)
    }

    @Test
    fun getExercisePR_ignoresIncompleteAndNoWeightSets() {
        val logs = listOf(set(0, weight = 100.0, completed = false), set(1, weight = null, reps = 999))
        assertNull(getExercisePR(logs))
    }

    @Test
    fun findNextPosition_resumesAtFirstIncompleteSet() {
        val exercises = listOf(
            Exercise("e1", "", 2, null, null, null, "reps", null),
            Exercise("e2", "", 2, null, null, null, "reps", null)
        )
        val logs = mapOf("e1" to listOf(set(0), set(1)), "e2" to listOf(set(0)))
        val pos = findNextPosition(exercises, logs)
        assertEquals(SessionPosition(1, 1), pos)
    }

    @Test
    fun findNextPosition_returnsNullWhenAllSetsDone() {
        val exercises = listOf(Exercise("e1", "", 1, null, null, null, "reps", null))
        val logs = mapOf("e1" to listOf(set(0)))
        assertNull(findNextPosition(exercises, logs))
    }
}
