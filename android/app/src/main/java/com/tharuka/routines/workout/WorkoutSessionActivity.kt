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
import com.tharuka.routines.shared.workout.LoggedSet
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
        val exercises = parseExercises(payload?.optJSONArray("exercises"))
        val logsForDate = parseLogsForDate(payload?.optJSONObject("logsForDate"))
        val logsByDate = parseLogsByDate(payload?.optJSONObject("logsByDate"))

        startTimerServiceOncePermitted(taskTitle)

        setContent {
            MaterialTheme(colorScheme = WorkoutColorScheme) {
                Surface {
                    WorkoutSessionScreen(
                        taskTitle = taskTitle,
                        exercises = exercises,
                        initialLogs = logsForDate,
                        logsByDate = logsByDate,
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

    /** Every date's logs for this task, not just today's - needed for getLastUsedWeight to look
     * back through prior sessions, the same way src/utils/workouts.js's JS counterpart does. */
    private fun parseLogsByDate(obj: JSONObject?): Map<String, Map<String, List<LoggedSet>>> {
        if (obj == null) return emptyMap()
        val result = mutableMapOf<String, Map<String, List<LoggedSet>>>()
        for (date in obj.keys()) {
            result[date] = parseLogsForDate(obj.getJSONObject(date))
        }
        return result
    }
}

private fun JSONObject.optIntOrNull(name: String): Int? =
    if (has(name) && !isNull(name)) getInt(name) else null

private fun JSONObject.optDoubleOrNull(name: String): Double? =
    if (has(name) && !isNull(name)) getDouble(name) else null
