package com.tharuka.routines.notify

import android.content.Intent
import com.getcapacitor.JSObject

/**
 * Same-process mediator between MainActivity.onNewIntent (the warm-start case - the app process
 * and bridge are already alive, so a tapped notification arrives as a new Intent on the existing
 * singleTask Activity instance rather than a fresh process launch) and
 * NativeNotificationsPlugin's notifyListeners(), same idiom as DueReminderBridge/
 * WorkoutSessionBridge. The cold-start case doesn't need this at all - NativeNotificationsPlugin.load()
 * reads the launch Intent's extras directly, the same pattern already used for pending due-reminder
 * actions.
 */
object NotificationTapBridge {
    var onOpenTarget: ((JSObject) -> Unit)? = null
}

internal fun buildNotificationTapData(taskId: String?, routineId: String?): JSObject {
    val data = JSObject()
    if (taskId != null) data.put("taskId", taskId)
    if (routineId != null) data.put("routineId", routineId)
    return data
}

/**
 * Called from MainActivity.onNewIntent (Java) - not `internal`, since Kotlin mangles internal
 * member names on the JVM specifically to discourage direct Java access, which would make this
 * awkward to call from there. Extracted as a standalone top-level function (rather than inlining
 * the extras-parsing in MainActivity itself) so MainActivity.java only needs one clean call.
 */
fun dispatchNotificationTapFromIntent(intent: Intent) {
    val taskId = intent.getStringExtra(EXTRA_OPEN_TASK_ID)
    val routineId = intent.getStringExtra(EXTRA_OPEN_ROUTINE_ID)
    if (taskId == null && routineId == null) return
    NotificationTapBridge.onOpenTarget?.invoke(buildNotificationTapData(taskId, routineId))
}
