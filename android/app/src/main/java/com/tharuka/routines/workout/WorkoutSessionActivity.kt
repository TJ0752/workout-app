package com.tharuka.routines.workout

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import org.json.JSONObject

class WorkoutSessionActivity : ComponentActivity() {
    companion object {
        const val EXTRA_PAYLOAD = "com.tharuka.routines.workout.PAYLOAD"
        const val EXTRA_RESULT = "com.tharuka.routines.workout.RESULT"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val payloadJson = intent.getStringExtra(EXTRA_PAYLOAD)
        val payload = payloadJson?.let { JSONObject(it) }
        val taskId = payload?.optString("taskId")
        val dateKey = payload?.optString("dateKey")

        setContent {
            MaterialTheme {
                Surface {
                    Text("hello", modifier = androidx.compose.ui.Modifier.clickable {
                        finishWithResult(taskId, dateKey)
                    })
                }
            }
        }
    }

    private fun finishWithResult(taskId: String?, dateKey: String?) {
        val result = JSONObject()
        result.put("taskId", taskId)
        result.put("dateKey", dateKey)
        val data = Intent().putExtra(EXTRA_RESULT, result.toString())
        setResult(RESULT_OK, data)
        finish()
    }
}
