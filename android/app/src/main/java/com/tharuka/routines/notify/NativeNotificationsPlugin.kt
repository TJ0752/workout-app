package com.tharuka.routines.notify

import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Owns presentation for notifications that need to "reappear if swiped away before they're
 * supposed to be dismissed" - unreachable via @capacitor/local-notifications, which builds its
 * notifications natively with no exposed hook for a custom setDeleteIntent() (confirmed by
 * reading its source; see CLAUDE.md). Covers the daily summary notification and the per-task
 * due-by reminder.
 */
@CapacitorPlugin(name = "NativeNotifications")
class NativeNotificationsPlugin : Plugin() {

    override fun load() {
        super.load()
        DueReminderBridge.onAction = { data -> notifyListeners("dueReminderAction", data, true) }

        // Cold-start case: DueReminderActionReceiver relaunched MainActivity because the app
        // process (and this bridge) wasn't alive to dispatch directly - the action arrived as
        // plain typed extras on the launch intent rather than through DueReminderBridge. Consume
        // them once here so a later config-change recreate doesn't refire the same action.
        val launchIntent = activity.intent
        val taskId = launchIntent.getStringExtra(EXTRA_PENDING_TASK_ID) ?: return
        val actionId = launchIntent.getStringExtra(EXTRA_PENDING_ACTION_ID) ?: return
        val amount = if (launchIntent.hasExtra(EXTRA_PENDING_AMOUNT)) {
            launchIntent.getIntExtra(EXTRA_PENDING_AMOUNT, 0)
        } else {
            null
        }
        launchIntent.removeExtra(EXTRA_PENDING_TASK_ID)
        launchIntent.removeExtra(EXTRA_PENDING_ACTION_ID)
        launchIntent.removeExtra(EXTRA_PENDING_AMOUNT)
        notifyListeners("dueReminderAction", buildDueReminderActionData(taskId, actionId, amount), true)
    }

    @PluginMethod
    fun showSummary(call: PluginCall) {
        val title = call.getString("title")
        val body = call.getString("body")
        if (title == null || body == null) {
            call.reject("title and body are required")
            return
        }
        val ongoing = call.getBoolean("ongoing", false) ?: false
        val content = SummaryContent(title, body, ongoing)
        SummaryNotificationStore.save(context, content)
        buildAndPostSummaryNotification(context, content)
        call.resolve()
    }

    @PluginMethod
    fun cancelSummary(call: PluginCall) {
        SummaryNotificationStore.clear(context)
        NotificationManagerCompat.from(context).cancel(SUMMARY_NOTIFICATION_ID)
        call.resolve()
    }

    @PluginMethod
    fun scheduleDueReminder(call: PluginCall) {
        val taskId = call.getString("taskId")
        val title = call.getString("title")
        val body = call.getString("body")
        val daysArray = call.getArray("days")
        val hour = call.getInt("hour")
        val minute = call.getInt("minute")
        if (taskId == null || title == null || body == null || daysArray == null || hour == null || minute == null) {
            call.reject("taskId, title, body, days, hour, and minute are required")
            return
        }
        val days = (0 until daysArray.length()).map { daysArray.getInt(it) }
        val amountsArray = call.getArray("quickAddAmounts")
        val quickAddAmounts = amountsArray?.let { arr -> (0 until arr.length()).map { arr.getInt(it) } } ?: emptyList()

        val entry = DueReminderEntry(
            taskId = taskId,
            routineId = call.getString("routineId"),
            title = title,
            body = body,
            days = days,
            hour = hour,
            minute = minute,
            group = call.getString("group"),
            completionType = call.getString("completionType") ?: "boolean",
            quickAddAmounts = quickAddAmounts,
        )
        DueReminderScheduler.schedule(context, entry)
        call.resolve()
    }

    @PluginMethod
    fun cancelDueReminder(call: PluginCall) {
        val taskId = call.getString("taskId")
        if (taskId == null) {
            call.reject("taskId is required")
            return
        }
        DueReminderScheduler.cancel(context, taskId)
        call.resolve()
    }
}
