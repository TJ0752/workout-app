package com.tharuka.routines.shared.workout

data class Exercise(
    val id: String,
    val name: String,
    val targetSets: Int?,
    val targetReps: Int?,
    val targetDurationSeconds: Int?,
    val unit: String,
    val restSeconds: Int?,
    // Default "weights" (not "calisthenics") matches the pre-existing behavior for exercises
    // saved before this field existed - the weight input always used to show. Placed last, with
    // a default, so WorkoutLogicTest's positional Exercise(...) constructor calls keep compiling.
    val type: String = "weights",
    // The cross-routine exercise-repository identity (see CLAUDE.md's "Exercise repository"
    // section) - null for exercises predating that migration and not yet backfilled, in which
    // case getLastUsedWeight falls back to matching by name, mirroring
    // src/utils/workouts.js's buildWorkoutLogSources. Trailing, with a default, for the same
    // WorkoutLogicTest positional-constructor reason as `type` above.
    val exerciseId: String? = null
)

/** One task's exercises + full log history - the flattened shape getLastUsedWeight scans across
 * every workout task app-wide (not just the one currently being logged), so a match by
 * exerciseId can find the same real-world exercise logged under a different routine. Mirrors
 * src/utils/workouts.js's buildWorkoutLogSources output exactly - the JS side has a Routine/Task
 * object model to build this from directly; native never does (WorkoutSessionActivity only ever
 * receives flat exercises/logs shapes across the plugin bridge), so this is the boundary shape
 * both sides agree on instead. */
data class WorkoutLogSource(
    val taskId: String,
    val exercises: List<ExerciseIdentity>,
    val logsByDate: Map<String, Map<String, List<LoggedSet>>>
)

/** Just enough of an Exercise to resolve a WorkoutLogSource's per-task-local id to its
 * cross-routine exerciseId - deliberately not the full Exercise data class, since a source's
 * other exercise fields are irrelevant to any one getLastUsedWeight lookup. */
data class ExerciseIdentity(val id: String, val exerciseId: String)

data class LoggedSet(
    val setIndex: Int,
    val reps: Int?,
    val weight: Double?,
    val durationSeconds: Int?,
    val completed: Boolean,
    val exerciseName: String?,
    val updatedAt: String?
)

data class SessionPosition(val exerciseIndex: Int, val setIndex: Int)
