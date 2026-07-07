package com.tharuka.routines.shared.workout

import kotlin.math.max
import kotlin.math.min

private fun plannedSetsFor(exercise: Exercise): Int {
    val targetSets = exercise.targetSets
    return if (targetSets == null || targetSets == 0) 1 else max(1, targetSets)
}

fun computeSessionFraction(exercises: List<Exercise>, logsForTaskDate: Map<String, List<LoggedSet>>): Double {
    if (exercises.isEmpty()) return 0.0
    var planned = 0
    var completed = 0
    for (exercise in exercises) {
        planned += plannedSetsFor(exercise)
        val sets = logsForTaskDate[exercise.id] ?: emptyList()
        completed += sets.count { it.completed }
    }
    if (planned == 0) return 0.0
    return min(1.0, completed.toDouble() / planned.toDouble())
}

fun getExerciseVolume(logs: List<LoggedSet>): Double {
    var sum = 0.0
    for (set in logs) {
        val reps = set.reps
        val weight = set.weight
        if (!set.completed || reps == null || reps == 0 || weight == null || weight == 0.0) continue
        sum += reps.toDouble() * weight
    }
    return sum
}

fun getExercisePR(logs: List<LoggedSet>): LoggedSet? {
    var best: LoggedSet? = null
    for (set in logs) {
        val weight = set.weight
        if (!set.completed || weight == null || weight == 0.0) continue
        val setReps = set.reps ?: 0
        val bestWeight = best?.weight
        val bestReps = best?.reps ?: 0
        if (best == null || weight > bestWeight!! || (weight == bestWeight && setReps > bestReps)) {
            best = set
        }
    }
    return best
}

/**
 * True if `newSet` beats the PR `previousLogs` already had (strictly - tying the existing PR
 * isn't "new"), using the same weight-then-reps tie-break as getExercisePR. Used by the live
 * workout notification's "New PR!" callout: called with the exercise's logs *before* the set
 * being logged, so it can tell a genuine new best apart from just matching an old one.
 */
fun isNewPR(previousLogs: List<LoggedSet>, newSet: LoggedSet): Boolean {
    if (!newSet.completed) return false
    val weight = newSet.weight
    if (weight == null || weight == 0.0) return false
    val previousBest = getExercisePR(previousLogs) ?: return true
    val previousWeight = previousBest.weight ?: return true
    val previousReps = previousBest.reps ?: 0
    val newReps = newSet.reps ?: 0
    return weight > previousWeight || (weight == previousWeight && newReps > previousReps)
}

/**
 * The most recently logged weight for an exercise, across every routine/task that logs it -
 * matched by exerciseId (the cross-routine exercise-repository identity), not scoped to the one
 * task currently being logged, so the same real-world exercise logged under two different
 * routines shares one last-used-weight/regression-warning baseline. Mirrors getLastUsedWeight in
 * src/utils/workouts.js exactly - `sources` is the flattened shape buildWorkoutLogSources (JS) /
 * WorkoutSessionActivity's payload parsing (native) both produce. Looks back through every date
 * on or before a cutoff across every source whose exercises include a matching exerciseId
 * (including sets already logged earlier the same day), picking whichever (date, setIndex) pair
 * is latest overall.
 */
fun getLastUsedWeight(
    sources: List<WorkoutLogSource>,
    exerciseId: String,
    onOrBeforeDateKey: String,
): Double? {
    var bestDate: String? = null
    var bestSetIndex = -1
    var bestWeight: Double? = null
    for (source in sources) {
        val localIds = source.exercises.filter { it.exerciseId == exerciseId }.map { it.id }
        if (localIds.isEmpty()) continue
        for ((date, byExerciseId) in source.logsByDate) {
            if (date > onOrBeforeDateKey) continue
            for (localId in localIds) {
                val sets = (byExerciseId[localId] ?: emptyList()).filter { it.completed && it.weight != null }
                for (set in sets) {
                    if (bestDate == null || date > bestDate!! || (date == bestDate && set.setIndex > bestSetIndex)) {
                        bestDate = date
                        bestSetIndex = set.setIndex
                        bestWeight = set.weight
                    }
                }
            }
        }
    }
    return bestWeight
}

private const val KG_PER_LB = 0.45359237

/** kg -> lb, for the dual-unit weight field. Canonical storage stays kg. */
fun kgToLb(kg: Double): Double = kg / KG_PER_LB

/** lb -> kg, the inverse of kgToLb. */
fun lbToKg(lb: Double): Double = lb * KG_PER_LB

fun findNextPosition(exercises: List<Exercise>, logsForDate: Map<String, List<LoggedSet>>): SessionPosition? {
    for (ei in exercises.indices) {
        val exercise = exercises[ei]
        val totalSets = plannedSetsFor(exercise)
        val sets = logsForDate[exercise.id] ?: emptyList()
        for (si in 0 until totalSets) {
            val alreadyDone = sets.any { it.setIndex == si && it.completed }
            if (!alreadyDone) return SessionPosition(ei, si)
        }
    }
    return null
}
