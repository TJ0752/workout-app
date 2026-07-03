package com.tharuka.routines.workout

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tharuka.routines.shared.workout.Exercise
import com.tharuka.routines.shared.workout.LoggedSet
import com.tharuka.routines.shared.workout.findNextPosition
import kotlinx.coroutines.delay

data class SetValues(val reps: Int?, val weight: Double?, val durationSeconds: Int?, val completed: Boolean)

@Composable
fun WorkoutSessionScreen(
    taskTitle: String,
    exercises: List<Exercise>,
    initialLogs: Map<String, List<LoggedSet>>,
    onLogSet: (Exercise, Int, SetValues) -> Unit,
    onRestStart: (Int) -> Unit,
    onRestEnd: () -> Unit,
    onClose: () -> Unit,
) {
    var logsByExercise by remember { mutableStateOf(initialLogs) }
    val start = remember { findNextPosition(exercises, initialLogs) }
    var exerciseIndex by remember { mutableStateOf(start?.exerciseIndex ?: 0) }
    var setIndex by remember { mutableStateOf(start?.setIndex ?: 0) }
    var finished by remember { mutableStateOf(start == null) }
    var resting by remember { mutableStateOf(false) }
    var restRemaining by remember { mutableStateOf(0) }

    LaunchedEffect(resting, restRemaining) {
        if (resting && restRemaining > 0) {
            delay(1000)
            restRemaining -= 1
            if (restRemaining <= 0) {
                resting = false
                onRestEnd()
            }
        }
    }

    val exercise = exercises.getOrNull(exerciseIndex) ?: return
    val isDuration = exercise.unit == "seconds"
    val totalSets = maxOf(1, exercise.targetSets ?: 1)
    val setsForExercise = logsByExercise[exercise.id] ?: emptyList()
    val loggedSet = setsForExercise.find { it.setIndex == setIndex }

    var reps by remember(exerciseIndex, setIndex) {
        mutableStateOf((loggedSet?.reps ?: exercise.targetReps)?.toString() ?: "")
    }
    var weight by remember(exerciseIndex, setIndex) {
        mutableStateOf((loggedSet?.weight ?: exercise.targetWeight)?.toString() ?: "")
    }
    var duration by remember(exerciseIndex, setIndex) {
        mutableStateOf((loggedSet?.durationSeconds ?: exercise.targetDurationSeconds)?.toString() ?: "")
    }

    fun jumpTo(index: Int) {
        exerciseIndex = index
        setIndex = 0
        finished = false
        resting = false
    }

    fun goNext() {
        if (setIndex + 1 < totalSets) {
            setIndex += 1
        } else if (exerciseIndex + 1 < exercises.size) {
            exerciseIndex += 1
            setIndex = 0
        }
    }

    fun goPrev() {
        if (setIndex > 0) {
            setIndex -= 1
        } else if (exerciseIndex > 0) {
            val prevExercise = exercises[exerciseIndex - 1]
            exerciseIndex -= 1
            setIndex = maxOf(0, (prevExercise.targetSets ?: 1) - 1)
        }
    }

    fun markDone() {
        val values = SetValues(
            reps = if (isDuration) null else reps.toIntOrNull(),
            weight = weight.toDoubleOrNull(),
            durationSeconds = if (isDuration) duration.toIntOrNull() else null,
            completed = true,
        )
        onLogSet(exercise, setIndex, values)
        val updatedSets = setsForExercise.filterNot { it.setIndex == setIndex } +
            LoggedSet(setIndex, values.reps, values.weight, values.durationSeconds, true, exercise.name, null)
        logsByExercise = logsByExercise + (exercise.id to updatedSets)

        val hasNextSet = setIndex + 1 < totalSets
        val hasNextExercise = exerciseIndex + 1 < exercises.size
        val restSeconds = exercise.restSeconds ?: 0
        if ((hasNextSet || hasNextExercise) && restSeconds > 0) {
            restRemaining = restSeconds
            resting = true
            onRestStart(restSeconds)
        }
        if (hasNextSet || hasNextExercise) {
            goNext()
        } else {
            finished = true
        }
    }

    val totalCompletedSets = exercises.sumOf { ex -> (logsByExercise[ex.id] ?: emptyList()).count { it.completed } }
    val totalPlannedSets = exercises.sumOf { ex -> maxOf(1, ex.targetSets ?: 1) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(taskTitle) },
                actions = {
                    IconButton(onClick = onClose) { Text("✕") }
                }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            LazyRow(modifier = Modifier.padding(8.dp)) {
                itemsIndexed(exercises) { index, ex ->
                    val sets = logsByExercise[ex.id] ?: emptyList()
                    val doneCount = sets.count { it.completed }
                    val exTotal = maxOf(1, ex.targetSets ?: 1)
                    FilterChip(
                        selected = index == exerciseIndex && !finished,
                        onClick = { jumpTo(index) },
                        label = { Text("${ex.name} $doneCount/$exTotal") },
                        modifier = Modifier.padding(end = 8.dp)
                    )
                }
            }

            when {
                finished -> {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        Text("✓", style = MaterialTheme.typography.displayMedium)
                        Text("Workout complete", style = MaterialTheme.typography.headlineSmall)
                        Text("$totalCompletedSets of $totalPlannedSets sets logged")
                        Button(onClick = onClose, modifier = Modifier.padding(top = 16.dp)) { Text("Done") }
                    }
                }
                resting -> {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        Text("Rest")
                        Text("${restRemaining}s", style = MaterialTheme.typography.displayMedium)
                        Button(onClick = { resting = false; onRestEnd() }, modifier = Modifier.padding(top = 16.dp)) {
                            Text("Skip rest")
                        }
                    }
                }
                else -> {
                    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                        Text(exercise.name, style = MaterialTheme.typography.headlineSmall)

                        Row(modifier = Modifier.padding(vertical = 8.dp)) {
                            for (i in 0 until totalSets) {
                                val done = setsForExercise.any { it.setIndex == i && it.completed }
                                OutlinedButton(
                                    onClick = { setIndex = i },
                                    modifier = Modifier.padding(end = 4.dp)
                                ) { Text("${i + 1}${if (done) " ✓" else ""}") }
                            }
                        }

                        if (isDuration) {
                            OutlinedTextField(
                                value = duration,
                                onValueChange = { duration = it },
                                label = { Text("Duration (sec)") },
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier.fillMaxWidth()
                            )
                        } else {
                            OutlinedTextField(
                                value = reps,
                                onValueChange = { reps = it },
                                label = { Text("Reps") },
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                        OutlinedTextField(
                            value = weight,
                            onValueChange = { weight = it },
                            label = { Text("Weight (optional)") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            IconButton(onClick = ::goPrev, enabled = !(exerciseIndex == 0 && setIndex == 0)) {
                                Text("‹", style = MaterialTheme.typography.headlineMedium)
                            }
                            Button(onClick = ::markDone) { Text("Mark set done") }
                            IconButton(
                                onClick = ::goNext,
                                enabled = !(exerciseIndex == exercises.size - 1 && setIndex == totalSets - 1)
                            ) {
                                Text("›", style = MaterialTheme.typography.headlineMedium)
                            }
                        }
                    }
                }
            }
        }
    }
}
