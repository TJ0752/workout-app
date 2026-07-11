package com.tharuka.routines.shared.workout

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun ex(id: String, groupId: String? = null, targetSets: Int = 3) =
    Exercise(id, id, targetSets, null, null, "reps", null, supersetGroupId = groupId)

private fun completedSet(setIndex: Int) = LoggedSet(setIndex, null, null, null, true, null, null)

class SupersetLogicTest {
    @Test
    fun isLinkedToNext_falseForUngroupedExercises() {
        assertEquals(false, isLinkedToNext(listOf(ex("a"), ex("b")), 0))
    }

    @Test
    fun isLinkedToNext_trueForTwoExercisesSharingAGroupId() {
        assertTrue(isLinkedToNext(listOf(ex("a", "g1"), ex("b", "g1")), 0))
    }

    @Test
    fun isLinkedToNext_falseAtTheLastExercise() {
        assertEquals(false, isLinkedToNext(listOf(ex("a", "g1"), ex("b", "g1")), 1))
    }

    @Test
    fun isLinkedToNext_falseForDifferentGroupIds() {
        assertEquals(false, isLinkedToNext(listOf(ex("a", "g1"), ex("b", "g2")), 0))
    }

    @Test
    fun buildSupersetSequence_degradesToPlainInOrderTraversalForUngroupedExercises() {
        val exercises = listOf(ex("a", null, 2), ex("b", null, 2))
        assertEquals(
            listOf(
                SessionPosition(0, 0),
                SessionPosition(0, 1),
                SessionPosition(1, 0),
                SessionPosition(1, 1),
            ),
            buildSupersetSequence(exercises),
        )
    }

    @Test
    fun buildSupersetSequence_roundRobinsWithinALinkedGroup() {
        val exercises = listOf(ex("a", "g1", 2), ex("b", "g1", 2))
        assertEquals(
            listOf(
                SessionPosition(0, 0),
                SessionPosition(1, 0),
                SessionPosition(0, 1),
                SessionPosition(1, 1),
            ),
            buildSupersetSequence(exercises),
        )
    }

    @Test
    fun buildSupersetSequence_roundRobinsAThreeMemberGroup() {
        val exercises = listOf(ex("a", "g1", 2), ex("b", "g1", 2), ex("c", "g1", 2))
        assertEquals(
            listOf(
                SessionPosition(0, 0), SessionPosition(1, 0), SessionPosition(2, 0),
                SessionPosition(0, 1), SessionPosition(1, 1), SessionPosition(2, 1),
            ),
            buildSupersetSequence(exercises),
        )
    }

    @Test
    fun buildSupersetSequence_sequencesAGroupFollowedByASoloExercise() {
        val exercises = listOf(ex("a", "g1", 2), ex("b", "g1", 2), ex("c", null, 1))
        assertEquals(
            listOf(
                SessionPosition(0, 0), SessionPosition(1, 0),
                SessionPosition(0, 1), SessionPosition(1, 1),
                SessionPosition(2, 0),
            ),
            buildSupersetSequence(exercises),
        )
    }

    @Test
    fun buildSupersetSequence_defensivelySkipsARoundBeyondAMemberWithFewerSets() {
        val exercises = listOf(ex("a", "g1", 3), ex("b", "g1", 1))
        assertEquals(
            listOf(
                SessionPosition(0, 0), SessionPosition(1, 0),
                SessionPosition(0, 1),
                SessionPosition(0, 2),
            ),
            buildSupersetSequence(exercises),
        )
    }

    @Test
    fun findNextSupersetPosition_returnsFirstIncompletePositionInTraversalOrder() {
        val exercises = listOf(ex("a", "g1", 2), ex("b", "g1", 2))
        val logs = mapOf("a" to listOf(completedSet(0)))
        assertEquals(SessionPosition(1, 0), findNextSupersetPosition(exercises, logs))
    }

    @Test
    fun findNextSupersetPosition_returnsNullOnceEverySetIsLogged() {
        val exercises = listOf(ex("a", "g1", 1), ex("b", "g1", 1))
        val logs = mapOf("a" to listOf(completedSet(0)), "b" to listOf(completedSet(0)))
        assertNull(findNextSupersetPosition(exercises, logs))
    }

    @Test
    fun nextSupersetPosition_advancesWithinAGroupBeforeReturningToRoundTwo() {
        val exercises = listOf(ex("a", "g1", 2), ex("b", "g1", 2))
        assertEquals(SessionPosition(1, 0), nextSupersetPosition(exercises, SessionPosition(0, 0)))
        assertEquals(SessionPosition(0, 1), nextSupersetPosition(exercises, SessionPosition(1, 0)))
    }

    @Test
    fun nextSupersetPosition_returnsNullPastTheVeryLastPosition() {
        val exercises = listOf(ex("a", null, 1))
        assertNull(nextSupersetPosition(exercises, SessionPosition(0, 0)))
    }

    @Test
    fun prevSupersetPosition_isTheExactInverseOfNextSupersetPosition() {
        val exercises = listOf(ex("a", "g1", 2), ex("b", "g1", 2), ex("c", null, 1))
        val sequence = buildSupersetSequence(exercises)
        for (i in 1 until sequence.size) {
            assertEquals(sequence[i - 1], prevSupersetPosition(exercises, sequence[i]))
        }
        assertNull(prevSupersetPosition(exercises, sequence[0]))
    }

    @Test
    fun shouldRestAfter_falseMidSuperset() {
        val exercises = listOf(ex("a", "g1"), ex("b", "g1"))
        assertEquals(false, shouldRestAfter(exercises, 0))
    }

    @Test
    fun shouldRestAfter_trueForTheLastMemberOfAGroup() {
        val exercises = listOf(ex("a", "g1"), ex("b", "g1"))
        assertTrue(shouldRestAfter(exercises, 1))
    }

    @Test
    fun shouldRestAfter_trueForASoloUngroupedExercise() {
        val exercises = listOf(ex("a"), ex("b"))
        assertTrue(shouldRestAfter(exercises, 0))
    }

    @Test
    fun supersetGroupLabels_assignsLettersOnlyToMultiMemberGroupsInOrder() {
        val exercises = listOf(ex("a", "g1"), ex("b", "g1"), ex("c"), ex("d", "g2"), ex("e", "g2"))
        val labels = supersetGroupLabels(exercises)
        assertEquals("A", labels["a"])
        assertEquals("A", labels["b"])
        assertEquals(null, labels["c"])
        assertEquals("B", labels["d"])
        assertEquals("B", labels["e"])
    }
}
