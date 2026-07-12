package com.tharuka.routines.workout

import android.content.Intent
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

@CapacitorPlugin(name = "WorkoutSession")
class WorkoutSessionPlugin : Plugin() {

    override fun load() {
        super.load()
        WorkoutSessionBridge.onSetLogged = { data ->
            notifyListeners("workoutSetLogged", data, true)
        }
        // Fired by the "pure timer" (quantity-as-timer) flow - see WorkoutSessionActivity's
        // pureTimer branch and QuantityTimerScreen. Same start()/plugin registration as a real
        // workout session; only the payload shape and this one extra listener differ.
        WorkoutSessionBridge.onQuantityTimerLogged = { data ->
            notifyListeners("quantityTimerLogged", data, true)
        }
        WorkoutSessionBridge.onRestartRequested = { data ->
            notifyListeners("workoutSessionRestarted", data, true)
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val intent = Intent(context, WorkoutSessionActivity::class.java)
        intent.putExtra(WorkoutSessionActivity.EXTRA_PAYLOAD, call.data.toString())
        startActivityForResult(call, intent, "handleSessionResult")
    }

    @ActivityCallback
    private fun handleSessionResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val ret = JSObject()
        ret.put("closed", true)
        val resultJson = result.data?.getStringExtra(WorkoutSessionActivity.EXTRA_RESULT)
        if (resultJson != null) {
            val parsed = JSONObject(resultJson)
            ret.put("taskId", parsed.optString("taskId", null))
            ret.put("dateKey", parsed.optString("dateKey", null))
        }
        call.resolve(ret)
    }
}
