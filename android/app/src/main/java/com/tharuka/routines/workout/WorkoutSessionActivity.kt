package com.tharuka.routines.workout

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val payloadJson = intent.getStringExtra(EXTRA_PAYLOAD)
        val payload = payloadJson?.let { JSONObject(it) }
        taskId = payload?.optString("taskId")
        dateKey = payload?.optString("dateKey")
        val taskTitle = payload?.optString("taskTitle") ?: ""
        val exercises = parseExercises(payload?.optJSONArray("exercises"))
        val logsForDate = parseLogsForDate(payload?.optJSONObject("logsForDate"))

        setContent {
            MaterialTheme {
                Surface {
                    WorkoutSessionScreen(
                        taskTitle = taskTitle,
                        exercises = exercises,
                        initialLogs = logsForDate,
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
                        onRestStart = {},
                        onRestEnd = {},
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
                    targetWeight = obj.optDoubleOrNull("targetWeight"),
                    targetDurationSeconds = obj.optIntOrNull("targetDurationSeconds"),
                    unit = obj.optString("unit", "reps"),
                    restSeconds = obj.optIntOrNull("restSeconds"),
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
}

private fun JSONObject.optIntOrNull(name: String): Int? =
    if (has(name) && !isNull(name)) getInt(name) else null

private fun JSONObject.optDoubleOrNull(name: String): Double? =
    if (has(name) && !isNull(name)) getDouble(name) else null
