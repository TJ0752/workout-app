package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.getcapacitor.JSObject
import com.tharuka.routines.MainActivity

internal const val EXTRA_PENDING_TASK_ID = "com.tharuka.routines.notify.PENDING_TASK_ID"
internal const val EXTRA_PENDING_ACTION_ID = "com.tharuka.routines.notify.PENDING_ACTION_ID"
internal const val EXTRA_PENDING_AMOUNT = "com.tharuka.routines.notify.PENDING_AMOUNT"

internal const val SNOOZE_MINUTES = 15

internal fun buildDueReminderActionData(taskId: String, actionId: String, amount: Int?): JSObject {
    val data = JSObject()
    data.put("taskId", taskId)
    data.put("actionId", actionId)
    if (amount != null) data.put("amount", amount)
    return data
}

/**
 * Handles Mark-done/+N/Snooze taps on the due-by reminder. Mark-done/+N never touch SQLite here
 * (native code must never touch the app's DB directly, see CLAUDE.md) - they only need to get
 * the tap to JS, which already has working setCompletion/addToCompletion handlers wired via
 * App.jsx's initActionListener. Snooze is the one action that needs no JS/bridge involvement at
 * all, since it never touches completions (same precedent as notifications.js's existing
 * scheduleSnooze) - it's handled by re-arming the same per-task alarm slot 15 minutes out.
 */
class DueReminderActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        when (intent.action) {
            ACTION_MARK_DONE -> dispatchDueReminderAction(context, taskId, "MARK_DONE", null)
            ACTION_ADD_QUANTITY -> {
                val amount = intent.getIntExtra(EXTRA_AMOUNT, 0)
                dispatchDueReminderAction(context, taskId, "ADD_QUANTITY", amount)
            }
            ACTION_SNOOZE -> {
                val triggerAtMillis = System.currentTimeMillis() + SNOOZE_MINUTES * 60_000L
                DueReminderScheduler.armAt(context, taskId, triggerAtMillis)
            }
        }
    }
}

/**
 * If the app process is alive (DueReminderBridge.onAction wired by
 * NativeNotificationsPlugin.load()), dispatch directly - no need to touch the Activity at
 * all; the app stays exactly where it was (background or whatever screen is open), the same
 * as it always has. If the process is dead, relaunch MainActivity carrying the action as plain
 * typed intent extras (not a JSON string - simpler and avoids a round-trip through org.json for
 * this one hop); NativeNotificationsPlugin.load() picks them up from the launch intent once
 * the bridge is ready, the same moment it would normally happen anyway. This is an accepted
 * v1 tradeoff: unlike the stock plugin's headless action handling, a cold-start tap visibly
 * brings the app forward - matches what already happens when tapping the notification body
 * itself, not a new class of behavior.
 *
 * Also carries the same EXTRA_OPEN_TASK_ID/EXTRA_OPEN_ROUTINE_ID extras a notification-body tap
 * already uses (see NotificationTapIntent.kt), read by the exact same existing code in
 * NativeNotificationsPlugin.load() - so a cold-start quick-add doesn't just bring the app
 * forward to whatever screen it last had open, it lands on Today scrolled to and highlighting
 * the task that was just updated, matching what a body tap already does. Only applies to the
 * cold-start path - a warm-process quick-add deliberately still doesn't interrupt whatever else
 * is on screen (the app never comes forward at all in that case).
 *
 * Top-level (not a method on DueReminderActionReceiver) so ExtraReminderActionReceiver's
 * Mark-done/+N handling can reuse it exactly - JS's "dueReminderAction" event handler
 * dispatches purely by actionId/taskId, with no notion of which native mechanism sent it.
 */
internal fun dispatchDueReminderAction(context: Context, taskId: String, actionId: String, amount: Int?) {
    val handler = DueReminderBridge.onAction
    if (handler != null) {
        handler.invoke(buildDueReminderActionData(taskId, actionId, amount))
        return
    }
    val routineId = DueReminderStore.read(context, taskId)?.routineId
    val relaunch = Intent(context, MainActivity::class.java)
    relaunch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    relaunch.putExtra(EXTRA_PENDING_TASK_ID, taskId)
    relaunch.putExtra(EXTRA_PENDING_ACTION_ID, actionId)
    if (amount != null) relaunch.putExtra(EXTRA_PENDING_AMOUNT, amount)
    relaunch.putExtra(EXTRA_OPEN_TASK_ID, taskId)
    if (routineId != null) relaunch.putExtra(EXTRA_OPEN_ROUTINE_ID, routineId)
    context.startActivity(relaunch)
}
