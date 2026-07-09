@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.tharuka.routines.workout

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tharuka.routines.shared.workout.Exercise
import com.tharuka.routines.shared.workout.LoggedSet
import com.tharuka.routines.shared.workout.WorkoutLogSource
import com.tharuka.routines.shared.workout.findNextPosition
import com.tharuka.routines.shared.workout.getExercisePR
import com.tharuka.routines.shared.workout.getExerciseVolume
import com.tharuka.routines.shared.workout.getLastUsedWeight
import com.tharuka.routines.shared.workout.isNewPR
import com.tharuka.routines.shared.workout.kgToLb
import com.tharuka.routines.shared.workout.lbToKg
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

data class SetValues(val reps: Int?, val weight: Double?, val durationSeconds: Int?, val completed: Boolean)

/** Common gym plate increment, used for the weight steppers' +/- step size. */
private const val WEIGHT_STEP_KG = 2.5

/** Fed to WorkoutTimerService.updateProgress() so the API-36+ live notification (see that file)
 * can mirror what's on screen - current exercise, per-exercise progress, and the last logged set. */
data class ProgressSnapshot(
    val exerciseName: String,
    val plannedSetsPerExercise: List<Int>,
    val completedSetsPerExercise: List<Int>,
    val currentExerciseIndex: Int,
    val lastSetSummary: String?,
    val isPR: Boolean,
)

/** Matches src/index.css's "Soft Paper" tokens exactly, so this native screen no longer falls
 * back to the stock Material3 default palette (which reads as generic purple, not this app's
 * identity). Defined once here and reused both for WorkoutSessionColorScheme below and for the
 * full-bleed green completion screen, which intentionally paints outside the theme's normal
 * surface/background roles. */
object AppPalette {
    val Background = Color(0xFFF7ECD2)
    val Card = Color(0xFFFFFFFF)
    val CardBorder = Color(0x29825F0F)
    val TextMain = Color(0xFF241D10)
    val TextSoft = Color(0xFF8C7F57)
    val Accent = Color(0xFF0A9764)
    val AccentInk = Color(0xFF062F1F)
    // Matches src/index.css's --bad token exactly (warm terracotta) - "missed/below-threshold"
    // everywhere else in the app, reused here for the weight-regression warning.
    val Bad = Color(0xFFD96C5F)
    // Matches src/index.css's --gold-ink exactly - reserved for streaks/PRs/achievement, reused
    // here for the duration timer's overtime display since exceeding a target reads as a small
    // win, not a warning (see DurationTimer below).
    val GoldInk = Color(0xFF6B4C14)
}

val WorkoutColorScheme = lightColorScheme(
    primary = AppPalette.Accent,
    onPrimary = Color.White,
    primaryContainer = AppPalette.Accent.copy(alpha = 0.15f),
    onPrimaryContainer = AppPalette.Accent,
    secondary = AppPalette.Accent,
    background = AppPalette.Background,
    onBackground = AppPalette.TextMain,
    surface = AppPalette.Card,
    onSurface = AppPalette.TextMain,
    surfaceVariant = AppPalette.Card,
    onSurfaceVariant = AppPalette.TextSoft,
    outline = AppPalette.CardBorder,
    outlineVariant = AppPalette.CardBorder,
)

@Composable
fun WorkoutSessionScreen(
    taskId: String,
    taskTitle: String,
    exercises: List<Exercise>,
    initialLogs: Map<String, List<LoggedSet>>,
    workoutLogSources: List<WorkoutLogSource>,
    dateKey: String,
    onLogSet: (Exercise, Int, SetValues) -> Unit,
    onRestStart: (Int) -> Unit,
    onRestEnd: () -> Unit,
    onProgressUpdate: (ProgressSnapshot) -> Unit,
    onClose: () -> Unit,
) {
    var logsByExercise by remember { mutableStateOf(initialLogs) }
    val start = remember { findNextPosition(exercises, initialLogs) }
    var exerciseIndex by remember { mutableStateOf(start?.exerciseIndex ?: 0) }
    var setIndex by remember { mutableStateOf(start?.setIndex ?: 0) }
    var finished by remember { mutableStateOf(start == null) }
    var resting by remember { mutableStateOf(false) }
    var restRemaining by remember { mutableStateOf(0) }
    // Captured separately from `exercise.restSeconds` because markDone() calls goNext() right
    // after starting a rest, which reassigns `exercise` to the *upcoming* one - reading
    // restSeconds from it later (e.g. at render time) would use the wrong exercise's configured
    // rest duration whenever the two differ. Mirrors WorkoutSessionView.jsx's identical fix.
    var restTotalSeconds by remember { mutableStateOf(0) }
    var restAnimKey by remember { mutableStateOf(0) }

    fun notifyProgressUpdate(lastSetSummary: String? = null, isPR: Boolean = false) {
        onProgressUpdate(
            ProgressSnapshot(
                exerciseName = exercises.getOrNull(exerciseIndex)?.name ?: taskTitle,
                plannedSetsPerExercise = exercises.map { maxOf(1, it.targetSets ?: 1) },
                completedSetsPerExercise = exercises.map { ex -> (logsByExercise[ex.id] ?: emptyList()).count { it.completed } },
                currentExerciseIndex = exerciseIndex,
                lastSetSummary = lastSetSummary,
                isPR = isPR,
            )
        )
    }

    LaunchedEffect(Unit) { notifyProgressUpdate() }

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
    // Purely a label/framing choice now (see the weight block below) - a calisthenics exercise's
    // weight field is "added weight" (a vest/belt worn on top of bodyweight) rather than
    // "weight", but both are logged into the same `weight` field and feed the identical
    // prefill/regression/PR/volume pipeline. Exercises saved before `type` existed have no field
    // at all - treating anything other than an explicit "calisthenics" as weighted preserves
    // their old "Weight" labeling, rather than needing a one-time backfill/migration.
    val isWeighted = exercise.type != "calisthenics"
    val totalSets = maxOf(1, exercise.targetSets ?: 1)
    val setsForExercise = logsByExercise[exercise.id] ?: emptyList()
    val loggedSet = setsForExercise.find { it.setIndex == setIndex }
    // workoutLogSources is a static snapshot from when the session launched, covering every
    // workout task across every routine (not just this one); logsByExercise is this session's
    // own live, already-updated state for today. Overriding just this task's own source's
    // logsByDate with logsByExercise is what lets getLastUsedWeight see a set logged a moment
    // ago in this same session, not just prior days - every other source is used as-is, since
    // only this task is being edited this session.
    val effectiveSources = workoutLogSources.map { src ->
        if (src.taskId == taskId) src.copy(logsByDate = src.logsByDate + (dateKey to logsByExercise)) else src
    }
    val exerciseKey = exercise.exerciseId ?: exercise.name
    val lastUsedWeight = getLastUsedWeight(effectiveSources, exerciseKey, dateKey)

    var reps by remember(exerciseIndex, setIndex) {
        mutableStateOf((loggedSet?.reps ?: exercise.targetReps)?.toString() ?: "")
    }
    // Canonical value stays kg; lb is a second, independently-typed field so editing one doesn't
    // fight the other's rounding while mid-keystroke - only the field NOT currently being typed
    // into gets recomputed. Mirrors WorkoutSessionView.jsx's identical approach.
    var weightKgText by remember(exerciseIndex, setIndex) {
        val initialKg = loggedSet?.weight ?: lastUsedWeight
        mutableStateOf(initialKg?.toString() ?: "")
    }
    var weightLbText by remember(exerciseIndex, setIndex) {
        val initialKg = loggedSet?.weight ?: lastUsedWeight
        mutableStateOf(initialKg?.let { formatNumber(kgToLb(it)) } ?: "")
    }

    fun handleKgChange(value: String) {
        weightKgText = value
        weightLbText = value.toDoubleOrNull()?.let { formatNumber(kgToLb(it)) } ?: ""
    }

    fun handleLbChange(value: String) {
        weightLbText = value
        weightKgText = value.toDoubleOrNull()?.let { formatNumber(lbToKg(it)) } ?: ""
    }

    fun adjustWeight(deltaKg: Double) {
        val current = weightKgText.toDoubleOrNull() ?: 0.0
        val next = maxOf(0.0, Math.round((current + deltaKg) * 100.0) / 100.0)
        handleKgChange(formatNumber(next))
    }

    val currentWeightKg = weightKgText.toDoubleOrNull()
    val isWeightRegression = lastUsedWeight != null && currentWeightKg != null && currentWeightKg < lastUsedWeight

    fun jumpTo(index: Int) {
        exerciseIndex = index
        setIndex = 0
        finished = false
        resting = false
        notifyProgressUpdate()
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

    fun logSetValues(values: SetValues) {
        onLogSet(exercise, setIndex, values)
        val newLoggedSet = LoggedSet(setIndex, values.reps, values.weight, values.durationSeconds, true, exercise.name, null)
        val wasNewPR = isNewPR(setsForExercise, newLoggedSet)
        val updatedSets = setsForExercise.filterNot { it.setIndex == setIndex } + newLoggedSet
        logsByExercise = logsByExercise + (exercise.id to updatedSets)

        // Attribute the summary/PR badge to the exercise that was just logged, not wherever
        // navigation lands next - notifyProgressUpdate() is called again below, but only if
        // navigation actually moves to a *different* exercise, so this stays visible for a
        // moment when simply advancing to the next set of the same exercise.
        val summaryText = when {
            isDuration -> values.durationSeconds?.let { "${it}s" }
            values.reps != null && values.weight != null -> "${values.reps} × ${formatNumber(values.weight)}"
            values.reps != null -> "${values.reps} reps"
            else -> null
        }
        notifyProgressUpdate(lastSetSummary = summaryText, isPR = wasNewPR)

        val hasNextSet = setIndex + 1 < totalSets
        val hasNextExercise = exerciseIndex + 1 < exercises.size
        val restSeconds = exercise.restSeconds ?: 0
        if ((hasNextSet || hasNextExercise) && restSeconds > 0) {
            restRemaining = restSeconds
            restTotalSeconds = restSeconds
            restAnimKey += 1
            resting = true
            onRestStart(restSeconds)
        }
        if (hasNextSet || hasNextExercise) {
            val movingToNewExercise = !hasNextSet && hasNextExercise
            goNext()
            if (movingToNewExercise) notifyProgressUpdate()
        } else {
            finished = true
        }
    }

    fun markDone() {
        logSetValues(
            SetValues(
                reps = reps.toIntOrNull(),
                weight = weightKgText.toDoubleOrNull(),
                durationSeconds = null,
                completed = true,
            )
        )
    }

    // DurationTimer's Stop-then-review flow is the only way a duration set gets logged now -
    // finalSeconds is whatever the user chose there (full time, target-only, or a typed custom
    // value), not anything read back out of component state here. Mirrors
    // WorkoutSessionView.jsx's markDoneWithDuration.
    fun markDoneWithDuration(finalSeconds: Int) {
        logSetValues(
            SetValues(
                reps = null,
                weight = weightKgText.toDoubleOrNull(),
                durationSeconds = finalSeconds,
                completed = true,
            )
        )
    }

    val totalCompletedSets = exercises.sumOf { ex -> (logsByExercise[ex.id] ?: emptyList()).count { it.completed } }
    val totalPlannedSets = exercises.sumOf { ex -> maxOf(1, ex.targetSets ?: 1) }
    val currentExercisePR = getExercisePR(setsForExercise)
    val sessionVolume = exercises.sumOf { ex -> getExerciseVolume(logsByExercise[ex.id] ?: emptyList()) }

    if (finished) {
        WorkoutCompleteScreen(totalCompletedSets = totalCompletedSets, totalPlannedSets = totalPlannedSets, onClose = onClose)
        return
    }

    Scaffold(
        containerColor = AppPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text(taskTitle, fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton(onClick = onClose) { Text("✕", fontSize = 18.sp) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = AppPalette.Background),
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            LazyRow(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                itemsIndexed(exercises) { index, ex ->
                    val sets = logsByExercise[ex.id] ?: emptyList()
                    val doneCount = sets.count { it.completed }
                    val exTotal = maxOf(1, ex.targetSets ?: 1)
                    FilterChip(
                        selected = index == exerciseIndex,
                        onClick = { jumpTo(index) },
                        label = { Text("${ex.name} $doneCount/$exTotal") },
                    )
                }
            }

            val statsParts = buildList {
                currentExercisePR?.let { add("PR: ${it.reps ?: 0} × ${formatNumber(it.weight ?: 0.0)}") }
                if (sessionVolume > 0.0) add("Session volume: ${formatNumber(sessionVolume)}")
            }
            if (statsParts.isNotEmpty()) {
                Text(
                    statsParts.joinToString("   ·   "),
                    style = MaterialTheme.typography.bodySmall,
                    color = AppPalette.TextSoft,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }

            if (resting) {
                Column(
                    modifier = Modifier.fillMaxSize().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text("REST", fontSize = 14.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp, color = AppPalette.TextSoft)
                    RestRing(
                        totalSeconds = restTotalSeconds,
                        resetKey = restAnimKey,
                        remainingLabel = "${restRemaining}s",
                        modifier = Modifier.padding(vertical = 12.dp),
                    )
                    // markDone() already advances exerciseIndex/setIndex to the upcoming position
                    // before entering the resting state, so `exercise`/`setIndex` here already
                    // describe what's next, not what was just finished - no separate lookahead
                    // needed, and no "nothing next" fallback either, since the rest screen only
                    // ever shows when there IS a next set/exercise (see markDone's own guard).
                    Text(
                        "Up next: ${exercise.name} · Set ${setIndex + 1} of $totalSets",
                        color = AppPalette.TextSoft,
                        fontSize = 14.sp,
                        modifier = Modifier.padding(bottom = 12.dp),
                    )
                    Button(
                        onClick = { resting = false; onRestEnd() },
                        shape = RoundedCornerShape(999.dp),
                        modifier = Modifier.height(52.dp),
                    ) {
                        Text("Skip rest", fontWeight = FontWeight.Bold)
                    }
                }
            } else {
                Column(
                    modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        exercise.name,
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(top = 2.dp, bottom = 2.dp),
                    )

                    Row(
                        horizontalArrangement = Arrangement.Center,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                    ) {
                        for (i in 0 until totalSets) {
                            val done = setsForExercise.any { it.setIndex == i && it.completed }
                            SetDot(number = i + 1, done = done, current = i == setIndex, onClick = { setIndex = i })
                        }
                    }

                    // A duration set is only ever logged through DurationTimer's own Stop -> review
                    // flow, and it renders its own copy of this same ring internally - see
                    // MomentumRing/DurationTimer below - so there's nothing to render here for it
                    // beyond that one component call.
                    if (isDuration) {
                        // key(...), not a remember(exerciseIndex, setIndex) inside DurationTimer -
                        // forces a full remount (phase/elapsed/editing all reset) on every set
                        // change, mirroring WorkoutSessionView.jsx's <DurationTimer key={...}/>.
                        key(exerciseIndex, setIndex) {
                            DurationTimer(
                                targetSeconds = exercise.targetDurationSeconds ?: 0,
                                initialSeconds = loggedSet?.durationSeconds,
                                onLog = ::markDoneWithDuration,
                            )
                        }
                    } else {
                        MomentumRing(
                            modifier = Modifier.weight(1f),
                            fraction = setsForExercise.count { it.completed }.toFloat() / totalSets.toFloat(),
                            interactive = true,
                            onTap = ::markDone,
                        ) {
                            Text("${setIndex + 1}", fontSize = 48.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onBackground)
                            Text("of $totalSets", fontSize = 13.sp, letterSpacing = 1.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(6.dp))
                            Text("Tap ring to log", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            OutlinedTextField(
                                value = reps,
                                onValueChange = { reps = it },
                                label = { Text("Reps") },
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }

                    // Same label distinction as WorkoutSessionView.jsx's field-label span: a
                    // calisthenics exercise's field is "added weight" (a vest/belt worn on top
                    // of bodyweight), not the total lifted weight - both log into the identical
                    // `weight` field and feed the same prefill/regression/PR/volume pipeline, so
                    // there's no `isWeighted` gate on the block itself anymore, only the label.
                    Text(
                        if (isWeighted) "Weight (optional)" else "Added weight (optional)",
                        style = MaterialTheme.typography.bodySmall,
                        color = AppPalette.TextSoft,
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    )
                    if (isWeightRegression) {
                        Text(
                            "Lower than last time (${formatNumber(lastUsedWeight ?: 0.0)} kg)",
                            color = AppPalette.Bad,
                            fontWeight = FontWeight.Bold,
                            fontSize = 12.sp,
                            modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
                        )
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val weightBorderColor = if (isWeightRegression) AppPalette.Bad else null
                        Button(
                            onClick = { adjustWeight(-WEIGHT_STEP_KG) },
                            shape = CircleShape,
                            contentPadding = PaddingValues(0.dp),
                            modifier = Modifier.size(40.dp),
                        ) { Text("−") }
                        OutlinedTextField(
                            value = weightKgText,
                            onValueChange = ::handleKgChange,
                            label = { Text("kg") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            colors = if (weightBorderColor != null) {
                                OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = weightBorderColor,
                                    unfocusedBorderColor = weightBorderColor,
                                )
                            } else {
                                OutlinedTextFieldDefaults.colors()
                            },
                            modifier = Modifier.weight(1f),
                        )
                        OutlinedTextField(
                            value = weightLbText,
                            onValueChange = ::handleLbChange,
                            label = { Text("lb") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            colors = if (weightBorderColor != null) {
                                OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = weightBorderColor,
                                    unfocusedBorderColor = weightBorderColor,
                                )
                            } else {
                                OutlinedTextFieldDefaults.colors()
                            },
                            modifier = Modifier.weight(1f),
                        )
                        Button(
                            onClick = { adjustWeight(WEIGHT_STEP_KG) },
                            shape = CircleShape,
                            contentPadding = PaddingValues(0.dp),
                            modifier = Modifier.size(40.dp),
                        ) { Text("+") }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        BigNavButton(
                            symbol = "‹",
                            enabled = !(exerciseIndex == 0 && setIndex == 0),
                            onClick = { goPrev(); notifyProgressUpdate() },
                        )
                        Text(
                            "Tap the ring to log the set",
                            style = MaterialTheme.typography.bodySmall,
                            color = AppPalette.TextSoft,
                        )
                        BigNavButton(
                            symbol = "›",
                            enabled = !(exerciseIndex == exercises.size - 1 && setIndex == totalSets - 1),
                            onClick = { goNext(); notifyProgressUpdate() },
                        )
                    }
                }
            }
        }
    }
}

/** Radial rest-timer ring: a full-circle track visually depletes from full to empty over the rest
 * duration via a single linear Animatable tween (not a per-second redraw), matching the "smoothly
 * goes round" continuous-motion effect the web version achieves with a CSS transition on
 * strokeDashoffset (see .workout-rest-ring-fill in App.css - the same depletion, driven by the
 * platform's own animation system instead of a JS/Compose-state redraw loop in both cases).
 * Briefly blinks (an alpha pulse on the ring only, not the countdown number) once fully depleted,
 * mirroring the web version's workoutRestRingBlink keyframes, as the "indicated rest over when it
 * blinks back to where it started" signal from the original request. `resetKey` (not
 * `totalSeconds`) is the LaunchedEffect key so that two back-to-back rests with an identical
 * duration still restart the animation - see WorkoutSessionView.jsx's RestRing for the same
 * reasoning. */
@Composable
private fun RestRing(
    totalSeconds: Int,
    resetKey: Int,
    remainingLabel: String,
    modifier: Modifier = Modifier,
) {
    val fraction = remember { Animatable(1f) }
    val blinkAlpha = remember { Animatable(1f) }
    LaunchedEffect(resetKey) {
        blinkAlpha.snapTo(1f)
        fraction.snapTo(1f)
        if (totalSeconds > 0) {
            fraction.animateTo(0f, animationSpec = tween(totalSeconds * 1000, easing = LinearEasing))
            blinkAlpha.animateTo(0.15f, animationSpec = tween(240))
            blinkAlpha.animateTo(1f, animationSpec = tween(360))
        }
    }

    val ringColor = MaterialTheme.colorScheme.primary
    val trackColor = MaterialTheme.colorScheme.outlineVariant
    val numberColor = MaterialTheme.colorScheme.onBackground

    Box(modifier = modifier.size(200.dp), contentAlignment = Alignment.Center) {
        Canvas(modifier = Modifier.fillMaxSize().graphicsLayer { alpha = blinkAlpha.value }) {
            val stroke = 10.dp.toPx()
            val inset = stroke / 2f
            val arcTopLeft = Offset(inset, inset)
            val arcSize = Size(size.width - stroke, size.height - stroke)

            drawArc(
                color = trackColor,
                startAngle = -90f,
                sweepAngle = 360f,
                useCenter = false,
                topLeft = arcTopLeft,
                size = arcSize,
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )
            drawArc(
                color = ringColor,
                startAngle = -90f,
                sweepAngle = 360f * fraction.value.coerceIn(0f, 1f),
                useCenter = false,
                topLeft = arcTopLeft,
                size = arcSize,
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )
        }
        Text(remainingLabel, fontSize = 48.sp, fontWeight = FontWeight.ExtraBold, color = numberColor)
    }
}

/**
 * A live, auto-continuing timer for a duration-based set - the native counterpart of
 * WorkoutSessionView.jsx's DurationTimer. Counts down from the exercise's target duration, shown
 * in the same MomentumRing every other set type uses (filling up as elapsed time approaches the
 * target, rather than a separate depleting ring), then keeps counting up into overtime
 * automatically once it reaches zero - there is deliberately no "continue" button. The only
 * manual actions are Stop (moves to a review step letting the user log the full time, the target
 * only, or a typed custom value) and, from that review step, "Start again" (an explicit redo that
 * discards this attempt with nothing logged, for a mis-timed or aborted set). The caller wraps
 * this in `key(exerciseIndex, setIndex) { ... }` so its own phase/elapsed state never needs
 * resetting by hand when the user moves to a different set.
 */
@Composable
private fun DurationTimer(
    targetSeconds: Int,
    initialSeconds: Int?,
    onLog: (Int) -> Unit,
) {
    var phase by remember { mutableStateOf("idle") } // "idle" | "running" | "stopped"
    var elapsed by remember { mutableStateOf(0) }
    var editing by remember { mutableStateOf(false) }
    var customValue by remember { mutableStateOf("") }

    LaunchedEffect(phase, elapsed) {
        if (phase == "running") {
            delay(1000)
            elapsed += 1
        }
    }

    val hasTarget = targetSeconds > 0
    val overtime = if (hasTarget) maxOf(0, elapsed - targetSeconds) else 0
    val inOvertime = hasTarget && elapsed >= targetSeconds
    // Fills up toward 1 as elapsed approaches the target (mirroring how the same ring fills as
    // sets complete elsewhere), then just stays full through overtime rather than continuing
    // past a full circle.
    val fraction = if (phase != "idle" && hasTarget) (elapsed.toFloat() / targetSeconds.toFloat()).coerceAtMost(1f) else 0f

    fun start() {
        elapsed = 0
        editing = false
        phase = "running"
    }

    fun stop() {
        phase = "stopped"
        editing = false
        customValue = elapsed.toString()
    }

    if (phase == "stopped") {
        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            MomentumRing(modifier = Modifier.fillMaxWidth().height(230.dp), fraction = fraction, interactive = false) {
                Text("${elapsed}s", fontSize = 48.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onBackground)
                Text("Logged", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (hasTarget) {
                Text(
                    "Target: ${targetSeconds}s",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
            Text("${elapsed}s logged", fontWeight = FontWeight.Bold, color = AppPalette.TextMain, modifier = Modifier.padding(top = 10.dp))
            Spacer(Modifier.height(10.dp))
            if (editing) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = customValue,
                        onValueChange = { customValue = it },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.weight(1f),
                    )
                    Button(onClick = { onLog(customValue.toIntOrNull() ?: 0) }) { Text("Confirm") }
                }
            } else {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(
                        onClick = { onLog(elapsed) },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(999.dp),
                    ) {
                        Text(
                            if (overtime > 0) "Log full time (${elapsed}s)" else "Log time (${elapsed}s)",
                            fontWeight = FontWeight.Bold,
                        )
                    }
                    if (overtime > 0) {
                        Button(
                            onClick = { onLog(targetSeconds) },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(999.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = AppPalette.Accent.copy(alpha = 0.15f),
                                contentColor = AppPalette.Accent,
                            ),
                        ) {
                            Text("Log target only (${targetSeconds}s)", fontWeight = FontWeight.Bold)
                        }
                    }
                    // Sharing one row instead of each taking a full stacked row - on a real
                    // device, the review screen's extra content (ring + total + log buttons +
                    // these two) stacked taller than a normal set screen and could push the
                    // weight field below the visible viewport; this reclaims one row's height.
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { editing = true }, modifier = Modifier.weight(1f)) {
                            Text("Edit custom time", color = AppPalette.TextSoft)
                        }
                        TextButton(onClick = ::start, modifier = Modifier.weight(1f)) {
                            Text("Start again", color = AppPalette.TextSoft)
                        }
                    }
                }
            }
        }
        return
    }

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        MomentumRing(modifier = Modifier.fillMaxWidth().height(230.dp), fraction = fraction, interactive = false) {
            Text(
                text = when {
                    phase == "idle" -> "${initialSeconds ?: targetSeconds}s"
                    inOvertime -> "+${overtime}s"
                    else -> "${elapsed}s"
                },
                fontSize = 48.sp,
                fontWeight = FontWeight.ExtraBold,
                // Reached (or exceeded) the target duration - the same "achievement" hue as
                // streaks/PRs, since exceeding a target reads as a small win, not a warning.
                color = if (inOvertime) AppPalette.GoldInk else MaterialTheme.colorScheme.onBackground,
            )
            Text(
                when {
                    phase == "idle" -> "Ready"
                    inOvertime -> "Overtime"
                    hasTarget -> "Target"
                    else -> "Elapsed"
                },
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (hasTarget) {
            Text(
                "Target: ${targetSeconds}s",
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
        Button(
            onClick = if (phase == "idle") ::start else ::stop,
            shape = RoundedCornerShape(999.dp),
            modifier = Modifier.height(52.dp).padding(top = 10.dp),
            colors = if (phase == "running") {
                ButtonDefaults.buttonColors(containerColor = AppPalette.Bad.copy(alpha = 0.15f), contentColor = AppPalette.Bad)
            } else {
                ButtonDefaults.buttonColors()
            },
        ) {
            Text(if (phase == "idle") "Start" else "Stop", fontWeight = FontWeight.Bold)
        }
    }
}

/** The dominant, full-screen tap target for logging a set - the whole ring is the button, not a
 * small label inside it. Filling the ring uses a springy overshoot (not a linear tween) and pairs
 * with a brief scale bounce and an expanding, fading pulse ring on every tap, so completing a set
 * reads as a small reward rather than a flat state change. A contentDescription of "Mark set
 * done" is set deliberately (Compose merges a clickable's descendant semantics into one
 * accessibility node) so scripts/verify-workout-session-notification.mjs's existing loose
 * text-or-content-desc lookup for that exact phrase keeps working unchanged. */
@Composable
private fun MomentumRing(
    modifier: Modifier = Modifier,
    fraction: Float,
    interactive: Boolean = true,
    onTap: () -> Unit = {},
    centerContent: @Composable () -> Unit,
) {
    val targetFraction = fraction.coerceIn(0f, 1f)
    val animatedFraction = remember { Animatable(targetFraction) }
    LaunchedEffect(targetFraction) {
        animatedFraction.animateTo(
            targetFraction,
            animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow),
        )
    }

    val scale = remember { Animatable(1f) }
    val pulseAlpha = remember { Animatable(0f) }
    val pulseScale = remember { Animatable(1f) }
    val scope = rememberCoroutineScope()

    val ringColor = MaterialTheme.colorScheme.primary
    val trackColor = MaterialTheme.colorScheme.outlineVariant

    // BoxWithConstraints, not a fixed .size(230.dp) - the column that hosts this ring passes
    // Modifier.weight(1f), and a fixed size on top of a weight-derived height allocation lets
    // the two disagree: if the column's available height comes out less than 230dp (a shorter
    // screen, or more chips/fields taking room above it), the fixed size gets constrained down
    // in height only, while width stays at the full 230dp - producing an oval, not a circle.
    // Deriving the side length from whichever of the two available dimensions is smaller
    // guarantees a square regardless of how much space the surrounding layout actually grants.
    BoxWithConstraints(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        val ringSize = minOf(maxWidth, maxHeight, 230.dp)
        // A duration set is only ever logged through DurationTimer's own Stop -> review flow, so
        // this ring becomes a plain progress display for it - not a second, conflicting way to
        // mark the set done (see WorkoutSessionScreen's call site). No clickable modifier at all
        // when non-interactive, rather than an onClick that no-ops, so there's no stray click
        // target/ripple either.
        val tapModifier = if (interactive) {
            Modifier
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) {
                    onTap()
                    scope.launch {
                        scale.snapTo(1f)
                        scale.animateTo(1.08f, animationSpec = tween(140))
                        scale.animateTo(1f, animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy))
                    }
                    scope.launch {
                        pulseScale.snapTo(1f)
                        pulseAlpha.snapTo(0.7f)
                        pulseScale.animateTo(1.5f, animationSpec = tween(700))
                        pulseAlpha.animateTo(0f, animationSpec = tween(700))
                    }
                }
                .semantics { contentDescription = "Mark set done" }
        } else {
            Modifier
        }
        Box(
            modifier = Modifier
                .size(ringSize)
                .graphicsLayer { scaleX = scale.value; scaleY = scale.value }
                .then(tapModifier),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val stroke = 16.dp.toPx()
                val inset = stroke / 2f
                val arcTopLeft = Offset(inset, inset)
                val arcSize = Size(size.width - stroke, size.height - stroke)

                if (pulseAlpha.value > 0.001f) {
                    drawCircle(
                        color = ringColor.copy(alpha = pulseAlpha.value),
                        radius = (size.minDimension / 2f) * pulseScale.value,
                        style = Stroke(width = 3.dp.toPx()),
                    )
                }
                drawArc(
                    color = trackColor,
                    startAngle = -90f,
                    sweepAngle = 360f,
                    useCenter = false,
                    topLeft = arcTopLeft,
                    size = arcSize,
                    style = Stroke(width = stroke, cap = StrokeCap.Round),
                )
                drawArc(
                    color = ringColor,
                    startAngle = -90f,
                    sweepAngle = 360f * animatedFraction.value.coerceIn(0f, 1f),
                    useCenter = false,
                    topLeft = arcTopLeft,
                    size = arcSize,
                    style = Stroke(width = stroke, cap = StrokeCap.Round),
                )
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                centerContent()
            }
        }
    }
}

@Composable
private fun SetDot(number: Int, done: Boolean, current: Boolean, onClick: () -> Unit) {
    val background = when {
        done -> MaterialTheme.colorScheme.primary
        current -> MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
        else -> MaterialTheme.colorScheme.surface
    }
    val foreground = when {
        done -> Color.White
        current -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Box(
        modifier = Modifier
            .padding(horizontal = 4.dp)
            .size(36.dp)
            .clip(CircleShape)
            .background(background)
            .border(1.4.dp, if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text("$number", color = foreground, fontWeight = FontWeight.Bold, fontSize = 14.sp)
    }
}

/** A large, unmistakable tap target - replaces the default 48dp IconButton, per the request that
 * navigation controls read as full, deliberate buttons rather than small icons. */
@Composable
private fun BigNavButton(symbol: String, enabled: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.size(60.dp),
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            Text(
                symbol,
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold,
                color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.3f),
            )
        }
    }
}

/** Full-bleed green, deliberately outside the normal cream background/white-card roles - this is
 * the "main completion page" whose dominant color should match the rest of the app's accent
 * green rather than reading as a plain white Material dialog. */
@Composable
private fun WorkoutCompleteScreen(totalCompletedSets: Int, totalPlannedSets: Int, onClose: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppPalette.Accent)
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("✓", fontSize = 56.sp, fontWeight = FontWeight.Bold, color = Color.White)
        Spacer(Modifier.height(16.dp))
        Text("Workout complete", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Color.White, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text("$totalCompletedSets of $totalPlannedSets sets logged", fontSize = 15.sp, color = Color.White.copy(alpha = 0.85f))
        Spacer(Modifier.height(28.dp))
        Button(
            onClick = onClose,
            colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = AppPalette.AccentInk),
            shape = RoundedCornerShape(999.dp),
            modifier = Modifier.height(54.dp),
        ) {
            Text("Done", fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
    }
}

/** "60" for a whole number, "62.5" otherwise. */
private fun formatNumber(value: Double): String {
    val rounded = (value * 10).roundToInt() / 10.0
    return if (rounded == rounded.toLong().toDouble()) rounded.toLong().toString() else rounded.toString()
}
