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
