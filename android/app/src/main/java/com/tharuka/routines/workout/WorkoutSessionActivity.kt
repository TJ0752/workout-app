package com.tharuka.routines.workout

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.tharuka.routines.shared.workout.Exercise
import com.tharuka.routines.shared.workout.ExerciseIdentity
import com.tharuka.routines.shared.workout.LoggedSet
import com.tharuka.routines.shared.workout.WorkoutLogSource
import org.json.JSONArray
import org.json.JSONObject

class WorkoutSessionActivity : ComponentActivity() {
    companion object {
        const val EXTRA_PAYLOAD = "com.tharuka.routines.workout.PAYLOAD"
        const val EXTRA_RESULT = "com.tharuka.routines.workout.RESULT"
    }

    private var taskId: String? = null
    private var dateKey: String? = null
    private var pendingTimerStartTaskTitle: String? = null

    // Must be registered unconditionally before the Activity reaches STARTED - a class-level
    // property initializer (runs during construction, ahead of onCreate) is the standard way to
    // satisfy that. ComponentActivity's own onRequestPermissionsResult() is the modern
    // registerForActivityResult-backed one and isn't open to override with the legacy
    // ActivityCompat.requestPermissions()/onRequestPermissionsResult() pattern - this launcher is
    // the correct replacement.
    private val activityRecognitionPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val taskTitle = pendingTimerStartTaskTitle
            pendingTimerStartTaskTitle = null
            // If denied, the session still works fully without the live notification - it was
            // always an enhancement on top of the core set-logging flow, never a requirement.
            if (granted && taskTitle != null) {
                WorkoutTimerService.start(this, taskTitle)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val payloadJson = intent.getStringExtra(EXTRA_PAYLOAD)
        val payload = payloadJson?.let { JSONObject(it) }
        taskId = payload?.optString("taskId")
        dateKey = payload?.optString("dateKey")
        val taskTitle = payload?.optString("taskTitle") ?: ""
        // A quantity task set up as a timer (RoutineForm's "Input as: Timer" mode) launches this
        // same Activity/foreground-service/plugin with a much smaller payload - just a target,
        // no exercises/logs/workoutLogSources at all - and renders QuantityTimerScreen instead of
        // the full WorkoutSessionScreen. Reusing this host (rather than a plain in-WebView JS
        // timer) is what lets a long-running quantity timer survive backgrounding/screen-lock via
        // the same real foreground service + chronometer notification a workout session gets.
        val pureTimer = payload?.optBoolean("pureTimer", false) ?: false

        startTimerServiceOncePermitted(taskTitle)

        if (pureTimer) {
            val targetSeconds = payload?.optIntOrNull("targetSeconds") ?: 0
            val initialSeconds = payload?.optIntOrNull("initialSeconds")
            setContent {
                MaterialTheme(colorScheme = WorkoutColorScheme) {
                    Surface {
                        QuantityTimerScreen(
                            taskTitle = taskTitle,
                            targetSeconds = targetSeconds,
                            initialSeconds = initialSeconds,
                            onLog = { seconds ->
                                val event = JSObject()
                                event.put("taskId", taskId)
                                event.put("dateKey", dateKey)
                                event.put("seconds", seconds)
                                WorkoutSessionBridge.onQuantityTimerLogged?.invoke(event)
                                // A pure timer logs one value, not a sequence of sets - nothing
                                // more to do in this screen once it's logged, so close it the same
                                // way tapping the X does.
                                finishWithResult()
                            },
                            onClose = { finishWithResult() },
                        )
                    }
                }
            }
            return
        }

        val exercises = parseExercises(payload?.optJSONArray("exercises"))
        val logsForDate = parseLogsForDate(payload?.optJSONObject("logsForDate"))
        val workoutLogSources = parseWorkoutLogSources(payload?.optJSONArray("workoutLogSources"))

        setContent {
            MaterialTheme(colorScheme = WorkoutColorScheme) {
                Surface {
                    WorkoutSessionScreen(
                        taskId = taskId ?: "",
                        taskTitle = taskTitle,
                        exercises = exercises,
                        initialLogs = logsForDate,
                        workoutLogSources = workoutLogSources,
                        dateKey = dateKey ?: "",
                        onLogSet = { exercise, setIndex, values ->
                            val event = JSObject()
                            event.put("taskId", taskId)
                            event.put("dateKey", dateKey)
                            val exerciseJson = JSObject()
                            exerciseJson.put("id", exercise.id)
                            exerciseJson.put("name", exercise.name)
                            event.put("exercise", exerciseJson)
                            event.put("setIndex", setIndex)
                            val valuesJson = JSObject()
                            valuesJson.put("reps", values.reps)
                            valuesJson.put("weight", values.weight)
                            valuesJson.put("durationSeconds", values.durationSeconds)
                            valuesJson.put("completed", values.completed)
                            event.put("values", valuesJson)
                            WorkoutSessionBridge.onSetLogged?.invoke(event)
                        },
                        onRestStart = { restSeconds -> WorkoutTimerService.updateRest(this, restSeconds) },
                        onRestEnd = { WorkoutTimerService.clearRest(this) },
                        onProgressUpdate = { snapshot ->
                            WorkoutTimerService.updateProgress(
                                this,
                                snapshot.exerciseName,
                                snapshot.plannedSetsPerExercise,
                                snapshot.completedSetsPerExercise,
                                snapshot.currentExerciseIndex,
                                snapshot.lastSetSummary,
                                snapshot.isPR,
                            )
                        },
                        onClose = { finishWithResult() },
                    )
                }
            }
        }
    }

    private fun finishWithResult() {
        val result = JSONObject()
        result.put("taskId", taskId)
        result.put("dateKey", dateKey)
        val data = Intent().putExtra(EXTRA_RESULT, result.toString())
        setResult(RESULT_OK, data)
        finish()
    }

    /**
     * Android 16 (API 36) requires a `health`-typed foreground service to hold at least one of
     * ACTIVITY_RECOGNITION/HIGH_SAMPLING_RATE_SENSORS/a Health Connect read permission *in
     * addition to* FOREGROUND_SERVICE_HEALTH itself - confirmed from a real device's crash log
     * (`SecurityException: Starting FGS with type health ... requires permissions: all of
     * [FOREGROUND_SERVICE_HEALTH] any of [ACTIVITY_RECOGNITION, ...]`), which is what was
     * actually crashing every workout session on a real Android 16 device - unrelated to the
     * notification-id collision or the ProgressStyle notification found earlier.
     * CI's test emulator only runs API 30, where this extra requirement doesn't exist, so nothing
     * caught it before a real device did. ACTIVITY_RECOGNITION is the fitting choice here (an
     * activity/workout tracker is its documented use case) over the health-metric-reading
     * permissions this app has no other use for.
     *
     * Never calls `startForegroundService()` without the permission already confirmed granted -
     * once that call is made, the service is contractually required to call `startForeground()`
     * within a few seconds or Android kills it with a *different* crash
     * (`ForegroundServiceDidNotStartInTimeException`), so simply catching the SecurityException
     * inside the service after the fact isn't sufficient on its own.
     */
    private fun startTimerServiceOncePermitted(taskTitle: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED
        ) {
            WorkoutTimerService.start(this, taskTitle)
            return
        }
        pendingTimerStartTaskTitle = taskTitle
        activityRecognitionPermissionLauncher.launch(Manifest.permission.ACTIVITY_RECOGNITION)
    }

    override fun onDestroy() {
        super.onDestroy()
        WorkoutTimerService.stop(this)
    }

    private fun parseExercises(array: JSONArray?): List<Exercise> {
        if (array == null) return emptyList()
        val result = mutableListOf<Exercise>()
        for (i in 0 until array.length()) {
            val obj = array.getJSONObject(i)
            result.add(
                Exercise(
                    id = obj.getString("id"),
                    name = obj.optString("name", ""),
                    targetSets = obj.optIntOrNull("targetSets"),
                    targetReps = obj.optIntOrNull("targetReps"),
                    targetDurationSeconds = obj.optIntOrNull("targetDurationSeconds"),
                    unit = obj.optString("unit", "reps"),
                    restSeconds = obj.optIntOrNull("restSeconds"),
                    type = obj.optString("type", "weights"),
                    exerciseId = obj.optStringOrNull("exerciseId"),
                )
            )
        }
        return result
    }

    private fun parseLogsForDate(obj: JSONObject?): Map<String, List<LoggedSet>> {
        if (obj == null) return emptyMap()
        val result = mutableMapOf<String, List<LoggedSet>>()
        for (exerciseId in obj.keys()) {
            val sets = obj.getJSONArray(exerciseId)
            val list = mutableListOf<LoggedSet>()
            for (i in 0 until sets.length()) {
                val s = sets.getJSONObject(i)
                list.add(
                    LoggedSet(
                        setIndex = s.getInt("setIndex"),
                        reps = s.optIntOrNull("reps"),
                        weight = s.optDoubleOrNull("weight"),
                        durationSeconds = s.optIntOrNull("durationSeconds"),
                        completed = s.optBoolean("completed", false),
                        exerciseName = s.optString("exerciseName", null),
                        updatedAt = s.optString("updatedAt", null),
                    )
                )
            }
            result[exerciseId] = list
        }
        return result
    }

    /** Every date's logs for one task, not just today's - needed for getLastUsedWeight to look
     * back through prior sessions, the same way src/utils/workouts.js's JS counterpart does. */
    private fun parseLogsByDate(obj: JSONObject?): Map<String, Map<String, List<LoggedSet>>> {
        if (obj == null) return emptyMap()
        val result = mutableMapOf<String, Map<String, List<LoggedSet>>>()
        for (date in obj.keys()) {
            result[date] = parseLogsForDate(obj.getJSONObject(date))
        }
        return result
    }

    /** Every workout-type task's exercises + full log history across every routine, not just
     * this session's own task - the flattened shape getLastUsedWeight needs to search by
     * exerciseId across routines. Mirrors src/utils/workouts.js's buildWorkoutLogSources output
     * exactly (see nativeWorkoutSession.js for how this payload is built on the JS side). */
    private fun parseWorkoutLogSources(array: JSONArray?): List<WorkoutLogSource> {
        if (array == null) return emptyList()
        val result = mutableListOf<WorkoutLogSource>()
        for (i in 0 until array.length()) {
            val obj = array.getJSONObject(i)
            val exercisesArray = obj.optJSONArray("exercises")
            val identities = mutableListOf<ExerciseIdentity>()
            if (exercisesArray != null) {
                for (j in 0 until exercisesArray.length()) {
                    val exObj = exercisesArray.getJSONObject(j)
                    val exerciseId = exObj.optStringOrNull("exerciseId") ?: continue
                    identities.add(ExerciseIdentity(id = exObj.getString("id"), exerciseId = exerciseId))
                }
            }
            result.add(
                WorkoutLogSource(
                    taskId = obj.optString("taskId", ""),
                    exercises = identities,
                    logsByDate = parseLogsByDate(obj.optJSONObject("logsByDate")),
                )
            )
        }
        return result
    }
}

private fun JSONObject.optIntOrNull(name: String): Int? =
    if (has(name) && !isNull(name)) getInt(name) else null

private fun JSONObject.optStringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) getString(name) else null

private fun JSONObject.optDoubleOrNull(name: String): Double? =
    if (has(name) && !isNull(name)) getDouble(name) else null
