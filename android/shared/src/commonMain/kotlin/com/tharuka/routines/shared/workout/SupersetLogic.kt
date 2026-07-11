package com.tharuka.routines.shared.workout

import kotlin.math.max

/**
 * Mirrors src/utils/supersets.js exactly - see that file's own comments for the full design
 * rationale. Only the session-navigation half is ported here (buildSupersetSequence and what's
 * derived from it): the link/unlink/group-id-rebuild editor logic has no native counterpart,
 * since routine editing only ever happens in the web/JS RoutineForm - a task's exercises
 * (including their supersetGroupId) arrive here already fully formed across the plugin bridge.
 *
 * A superset changes the *order* sets get logged in, nothing else: round-robin within a group
 * (every member's set 1, then every member's set 2, ...) instead of finishing one exercise
 * before starting the next. A solo exercise is just a group of one, so buildSupersetSequence is
 * safe to use unconditionally - it degrades to the exact plain in-order traversal every exercise
 * used before this feature existed.
 */

/** Whether the exercise at `index` shares a group with the one immediately after it. */
fun isLinkedToNext(exercises: List<Exercise>, index: Int): Boolean {
    val a = exercises.getOrNull(index) ?: return false
    val b = exercises.getOrNull(index + 1) ?: return false
    val groupId = a.supersetGroupId ?: return false
    return groupId == b.supersetGroupId
}

/** The full ordered (exerciseIndex, setIndex) traversal for one session. */
fun buildSupersetSequence(exercises: List<Exercise>): List<SessionPosition> {
    val sequence = mutableListOf<SessionPosition>()
    var i = 0
    while (i < exercises.size) {
        var j = i
        while (isLinkedToNext(exercises, j)) j++
        val groupIndices = (i..j).toList()
        val plannedSets = { k: Int -> max(1, exercises[k].targetSets ?: 1) }
        val maxSets = groupIndices.maxOf(plannedSets)
        for (round in 0 until maxSets) {
            for (k in groupIndices) {
                if (round < plannedSets(k)) {
                    sequence.add(SessionPosition(k, round))
                }
            }
        }
        i = j + 1
    }
    return sequence
}

/** The first not-yet-completed position in traversal order, or null once every set is done. */
fun findNextSupersetPosition(exercises: List<Exercise>, logsForDate: Map<String, List<LoggedSet>>): SessionPosition? {
    for (pos in buildSupersetSequence(exercises)) {
        val exercise = exercises[pos.exerciseIndex]
        val sets = logsForDate[exercise.id] ?: emptyList()
        val alreadyDone = sets.any { it.setIndex == pos.setIndex && it.completed }
        if (!alreadyDone) return pos
    }
    return null
}

/** The position right after `current` in traversal order, or null if `current` was the last. */
fun nextSupersetPosition(exercises: List<Exercise>, current: SessionPosition): SessionPosition? {
    val sequence = buildSupersetSequence(exercises)
    val idx = sequence.indexOf(current)
    if (idx == -1 || idx + 1 >= sequence.size) return null
    return sequence[idx + 1]
}

/** The position right before `current` in traversal order, or null if `current` was the first. */
fun prevSupersetPosition(exercises: List<Exercise>, current: SessionPosition): SessionPosition? {
    val sequence = buildSupersetSequence(exercises)
    val idx = sequence.indexOf(current)
    if (idx <= 0) return null
    return sequence[idx - 1]
}

/** Whether completing a set of the exercise at `exerciseIndex` should trigger a rest before
 * advancing - false when it's chained mid-superset into the next group member (no rest between
 * superset exercises, regardless of that exercise's own configured restSeconds), true
 * otherwise (a solo exercise between its own sets/exercises, or the last member of a group
 * finishing a round). */
fun shouldRestAfter(exercises: List<Exercise>, exerciseIndex: Int): Boolean {
    return !isLinkedToNext(exercises, exerciseIndex)
}

/** Assigns a display letter (A, B, C, ...) to each *multi-member* group's exercise ids, in the
 * order the groups appear - a solo/ungrouped exercise gets no entry. Used purely for UI
 * labeling ("Superset A"); mirrors src/utils/supersets.js's supersetGroupLabels. */
fun supersetGroupLabels(exercises: List<Exercise>): Map<String, String> {
    val labels = mutableMapOf<String, String>()
    var letterCode = 'A'.code
    var i = 0
    while (i < exercises.size) {
        var j = i
        while (isLinkedToNext(exercises, j)) j++
        if (j > i) {
            val label = letterCode.toChar().toString()
            letterCode += 1
            for (k in i..j) labels[exercises[k].id] = label
        }
        i = j + 1
    }
    return labels
}
