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
            Exercise("e1", "", 3, null, null, "reps", null),
            Exercise("e2", "", 2, null, null, "reps", null)
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
        val exercises = listOf(Exercise("e1", "", 0, null, null, "reps", null))
        val logs = mapOf("e1" to listOf(set(0)))
        assertEquals(1.0, computeSessionFraction(exercises, logs))
    }

    @Test
    fun computeSessionFraction_clampsToOne() {
        val exercises = listOf(Exercise("e1", "", 2, null, null, "reps", null))
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
    fun isNewPR_trueForHigherWeightThanPreviousBest() {
        val previous = listOf(set(0, weight = 40.0, reps = 5))
        assertTrue(isNewPR(previous, set(1, weight = 50.0, reps = 5)))
    }

    @Test
    fun isNewPR_falseForLowerWeightThanPreviousBest() {
        val previous = listOf(set(0, weight = 40.0, reps = 5))
        assertEquals(false, isNewPR(previous, set(1, weight = 30.0, reps = 5)))
    }

    @Test
    fun isNewPR_tiedWeightNeedsHigherRepsToCount() {
        val previous = listOf(set(0, weight = 40.0, reps = 5))
        assertTrue(isNewPR(previous, set(1, weight = 40.0, reps = 8)))
        assertEquals(false, isNewPR(previous, set(1, weight = 40.0, reps = 5)))
        assertEquals(false, isNewPR(previous, set(1, weight = 40.0, reps = 3)))
    }

    @Test
    fun isNewPR_trueForFirstEverWeightedSet() {
        assertTrue(isNewPR(emptyList(), set(0, weight = 20.0, reps = 10)))
    }

    @Test
    fun isNewPR_falseWhenNewSetIsNotCompletedOrHasNoWeight() {
        val previous = listOf(set(0, weight = 20.0, reps = 10))
        assertEquals(false, isNewPR(previous, set(1, weight = 100.0, reps = 10, completed = false)))
        assertEquals(false, isNewPR(previous, set(1, weight = null, reps = 10)))
    }

    @Test
    fun findNextPosition_resumesAtFirstIncompleteSet() {
        val exercises = listOf(
            Exercise("e1", "", 2, null, null, "reps", null),
            Exercise("e2", "", 2, null, null, "reps", null)
        )
        val logs = mapOf("e1" to listOf(set(0), set(1)), "e2" to listOf(set(0)))
        val pos = findNextPosition(exercises, logs)
        assertEquals(SessionPosition(1, 1), pos)
    }

    @Test
    fun findNextPosition_returnsNullWhenAllSetsDone() {
        val exercises = listOf(Exercise("e1", "", 1, null, null, "reps", null))
        val logs = mapOf("e1" to listOf(set(0)))
        assertNull(findNextPosition(exercises, logs))
    }

    private fun source(taskId: String, exerciseId: String, logsByDate: Map<String, Map<String, List<LoggedSet>>>) =
        WorkoutLogSource(taskId, listOf(ExerciseIdentity("e1", exerciseId)), logsByDate)

    @Test
    fun getLastUsedWeight_picksMostRecentDateOnOrBeforeCutoff() {
        val sources = listOf(
            source(
                "t1", "ex1",
                mapOf(
                    "2026-07-01" to mapOf("e1" to listOf(set(0, weight = 60.0))),
                    "2026-07-03" to mapOf("e1" to listOf(set(0, weight = 65.0))),
                    "2026-07-02" to mapOf("e1" to listOf(set(0, weight = 62.0))),
                )
            )
        )
        assertEquals(65.0, getLastUsedWeight(sources, "ex1", "2026-07-05"))
    }

    @Test
    fun getLastUsedWeight_withinADatePrefersHighestSetIndex() {
        val sources = listOf(
            source(
                "t1", "ex1",
                mapOf(
                    "2026-07-01" to mapOf(
                        "e1" to listOf(set(0, weight = 60.0), set(1, weight = 62.5), set(2, weight = 65.0))
                    )
                )
            )
        )
        assertEquals(65.0, getLastUsedWeight(sources, "ex1", "2026-07-01"))
    }

    @Test
    fun getLastUsedWeight_ignoresDatesAfterCutoffAndIncompleteOrWeightlessSets() {
        val sources = listOf(
            source(
                "t1", "ex1",
                mapOf(
                    "2026-07-01" to mapOf("e1" to listOf(set(0, weight = 60.0))),
                    "2026-07-05" to mapOf("e1" to listOf(set(0, weight = 100.0))),
                    "2026-07-02" to mapOf(
                        "e1" to listOf(set(0, weight = 999.0, completed = false), set(1, weight = null))
                    ),
                )
            )
        )
        assertEquals(60.0, getLastUsedWeight(sources, "ex1", "2026-07-03"))
    }

    @Test
    fun getLastUsedWeight_nullWhenNothingEverLogged() {
        assertNull(getLastUsedWeight(emptyList(), "ex1", "2026-07-01"))
        assertNull(
            getLastUsedWeight(
                listOf(source("t1", "other", mapOf("2026-07-01" to mapOf("e1" to listOf(set(0)))))),
                "ex1",
                "2026-07-01",
            )
        )
    }

    @Test
    fun getLastUsedWeight_mergesAcrossSourcesSharingExerciseId_mostRecentOverallWins() {
        val sources = listOf(
            source("t1", "ex1", mapOf("2026-07-01" to mapOf("e1" to listOf(set(0, weight = 60.0))))),
            source("t2", "ex1", mapOf("2026-07-03" to mapOf("e1" to listOf(set(0, weight = 70.0))))),
        )
        assertEquals(70.0, getLastUsedWeight(sources, "ex1", "2026-07-05"))
    }

    @Test
    fun getLastUsedWeight_doesNotMergeAcrossSourcesWithDifferentExerciseId() {
        val sources = listOf(
            source("t1", "ex1", mapOf("2026-07-05" to mapOf("e1" to listOf(set(0, weight = 60.0))))),
            source("t2", "ex2", mapOf("2026-07-01" to mapOf("e1" to listOf(set(0, weight = 999.0))))),
        )
        assertEquals(60.0, getLastUsedWeight(sources, "ex1", "2026-07-05"))
    }

    @Test
    fun kgToLb_and_lbToKg_convertAndRoundTrip() {
        assertEquals(220.462, kgToLb(100.0), 0.01)
        assertEquals(100.0, lbToKg(220.462), 0.01)
        assertEquals(62.5, lbToKg(kgToLb(62.5)), 0.000001)
    }
}
