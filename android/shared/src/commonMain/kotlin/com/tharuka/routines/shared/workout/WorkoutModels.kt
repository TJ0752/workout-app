package com.tharuka.routines.shared.workout

data class Exercise(
    val id: String,
    val name: String,
    val targetSets: Int?,
    val targetReps: Int?,
    val targetWeight: Double?,
    val targetDurationSeconds: Int?,
    val unit: String,
    val restSeconds: Int?
)

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
