package com.tharuka.routines.notify

import android.app.NotificationManager
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject
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
        createNotificationChannels(context)
        postAppGroupSummary(context)

        DueReminderBridge.onAction = { data -> notifyListeners("dueReminderAction", data, true) }
        NotificationTapBridge.onOpenTarget = { data -> notifyListeners("notificationTapped", data, true) }

        // Fires once per app-process/bridge lifecycle, independent of Activity
        // foreground/background state - matches "as long as the app is running," not tied to
        // one Activity instance. See BackgroundSyncService.kt for why this exists at all.
        BackgroundSyncBridge.onTick = { notifyListeners("backgroundSyncTick", JSObject(), true) }
        BackgroundSyncService.start(context)

        val launchIntent = activity.intent

        // Cold-start deep-link case: the notification's content intent launched MainActivity
        // (and this bridge/plugin) fresh, rather than delivering to an already-running instance
        // via onNewIntent - consume the extras here once, the same moment a warm start would have
        // dispatched via NotificationTapBridge.
        val openTaskId = launchIntent.getStringExtra(EXTRA_OPEN_TASK_ID)
        val openRoutineId = launchIntent.getStringExtra(EXTRA_OPEN_ROUTINE_ID)
        if (openTaskId != null || openRoutineId != null) {
            launchIntent.removeExtra(EXTRA_OPEN_TASK_ID)
            launchIntent.removeExtra(EXTRA_OPEN_ROUTINE_ID)
            notifyListeners("notificationTapped", buildNotificationTapData(openTaskId, openRoutineId), true)
        }

        // Cold-start case: DueReminderActionReceiver relaunched MainActivity because the app
        // process (and this bridge) wasn't alive to dispatch directly - the action arrived as
        // plain typed extras on the launch intent rather than through DueReminderBridge. Consume
        // them once here so a later config-change recreate doesn't refire the same action.
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

    /**
     * No-ops (skips both the SharedPreferences write and the notify() call) if the content is
     * identical to what's already posted - this is what's called on every app open, every
     * completion change, and every ~15min background-sync tick (see updateSummaryNotification in
     * src/notifications.js), and NotificationCompat re-alerts (sound/vibration) on every notify()
     * call by default - without this check, simply reopening the app with nothing actually
     * changed would re-sound the persistent summary notification every single time.
     */
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
        if (SummaryNotificationStore.read(context) == content) {
            call.resolve()
            return
        }
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
        val skipDatesArray = call.getArray("skipDates")
        val skipDates = skipDatesArray?.let { arr -> (0 until arr.length()).map { arr.getString(it) } } ?: emptyList()

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
            skipDates = skipDates,
            windowStartHour = call.getInt("windowStartHour"),
            windowStartMinute = call.getInt("windowStartMinute"),
        )
        val isDoneToday = call.getBoolean("isDoneToday", false) ?: false
        DueReminderScheduler.schedule(context, entry, isDoneToday)
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

    /**
     * Called once a task is marked done. Clears awaitingCompletion (the flag
     * DueReminderDismissReceiver checks) so a swipe no longer reappears it - but if the reminder
     * was already visibly showing (awaitingCompletion was true - it had fired at least once
     * today, via the due-time alarm, a windowStart post, or overdue catch-up), it's rebuilt as a
     * plain, silent, swipeable "final state" notification instead of being cancelled outright, so
     * the user can still glance at the value they just logged (see buildDueReminderNotification's
     * `completed` mode). A task completed well before its reminder ever appeared (the common
     * case for most completions) still just no-ops via cancel(), matching the old behavior - this
     * is deliberately scoped to "the notification you were just looking at," not "every
     * completion anywhere spawns a new notification."
     */
    @PluginMethod
    fun dismissDueReminderToday(call: PluginCall) {
        val taskId = call.getString("taskId")
        if (taskId == null) {
            call.reject("taskId is required")
            return
        }
        val entry = DueReminderStore.read(context, taskId)
        val wasShowing = entry?.awaitingCompletion == true
        DueReminderStore.setAwaitingCompletion(context, taskId, false)
        if (wasShowing && entry != null) {
            val notification = buildDueReminderNotification(context, entry, silent = true, completed = true)
            NotificationManagerCompat.from(context).notify(dueReminderNotificationId(taskId), notification)
        } else {
            NotificationManagerCompat.from(context).cancel(dueReminderNotificationId(taskId))
        }
        call.resolve()
    }

    @PluginMethod
    fun scheduleExtraReminder(call: PluginCall) {
        val taskId = call.getString("taskId")
        val slot = call.getInt("slot")
        val title = call.getString("title")
        val body = call.getString("body")
        val daysArray = call.getArray("days")
        val hour = call.getInt("hour")
        val minute = call.getInt("minute")
        if (taskId == null || slot == null || title == null || body == null || daysArray == null || hour == null || minute == null) {
            call.reject("taskId, slot, title, body, days, hour, and minute are required")
            return
        }
        val days = (0 until daysArray.length()).map { daysArray.getInt(it) }
        val amountsArray = call.getArray("quickAddAmounts")
        val quickAddAmounts = amountsArray?.let { arr -> (0 until arr.length()).map { arr.getInt(it) } } ?: emptyList()

        val entry = ExtraReminderEntry(
            taskId = taskId,
            slot = slot,
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
        ExtraReminderScheduler.schedule(context, entry)
        call.resolve()
    }

    /**
     * Called when a task's reminder-time count shrinks (an excess slot is dropped, not just
     * rescheduled) - cancels the pending alarm *and* whatever's already showing for this slot,
     * matching cancelGroupSummary/cancelSummary/dismissDueReminderToday's already-established
     * "cancel means fully retract, not just stop future recurrence" pattern elsewhere in this
     * plugin. Without this, a since-removed reminder slot that had already fired once would
     * linger in the shade indefinitely (autoCancel only clears it on a user tap, never
     * automatically) even though nothing would ever schedule it again.
     */
    @PluginMethod
    fun cancelExtraReminderSlot(call: PluginCall) {
        val taskId = call.getString("taskId")
        val slot = call.getInt("slot")
        if (taskId == null || slot == null) {
            call.reject("taskId and slot are required")
            return
        }
        ExtraReminderScheduler.cancel(context, taskId, slot)
        NotificationManagerCompat.from(context).cancel(extraReminderNotificationId(taskId, slot))
        call.resolve()
    }

    @PluginMethod
    fun cancelExtraReminders(call: PluginCall) {
        val taskId = call.getString("taskId")
        if (taskId == null) {
            call.reject("taskId is required")
            return
        }
        ExtraReminderScheduler.cancelAllForTask(context, taskId)
        val notificationManager = NotificationManagerCompat.from(context)
        for (slot in 0 until MAX_EXTRA_REMINDERS) {
            notificationManager.cancel(extraReminderNotificationId(taskId, slot))
        }
        call.resolve()
    }

    /**
     * Clears whichever extra-reminder slots are currently showing for this task, for today
     * only - called once a task is marked done, mirroring the due reminder's own
     * dismissDueReminderToday. Since each (task, slot) alarm reschedules to its next occurrence
     * immediately after firing, cancelling by its fixed id only ever clears something that was
     * genuinely posted today; a slot that hasn't fired yet today has nothing shown to cancel.
     * Unlike the due reminder, there's no persisted "awaitingCompletion" flag to clear here -
     * extra reminders were never pinned/reappearing.
     */
    @PluginMethod
    fun dismissExtraRemindersToday(call: PluginCall) {
        val taskId = call.getString("taskId")
        if (taskId == null) {
            call.reject("taskId is required")
            return
        }
        val notificationManager = NotificationManagerCompat.from(context)
        for (slot in 0 until MAX_EXTRA_REMINDERS) {
            notificationManager.cancel(extraReminderNotificationId(taskId, slot))
        }
        call.resolve()
    }

    /**
     * Schedules a genuine one-shot reminder for a single rescheduled occurrence (see
     * RescheduleReminderScheduler.kt) - fires exactly once on the specific calendar date
     * task_reschedules moved this occurrence to, unlike every other scheduler in this file, which
     * only ever knows a recurring set of weekdays.
     */
    @PluginMethod
    fun scheduleRescheduleReminder(call: PluginCall) {
        val taskId = call.getString("taskId")
        val newDate = call.getString("newDate")
        val title = call.getString("title")
        val body = call.getString("body")
        val hour = call.getInt("hour")
        val minute = call.getInt("minute")
        if (taskId == null || newDate == null || title == null || body == null || hour == null || minute == null) {
            call.reject("taskId, newDate, title, body, hour, and minute are required")
            return
        }
        val amountsArray = call.getArray("quickAddAmounts")
        val quickAddAmounts = amountsArray?.let { arr -> (0 until arr.length()).map { arr.getInt(it) } } ?: emptyList()

        val entry = RescheduleReminderEntry(
            taskId = taskId,
            newDate = newDate,
            routineId = call.getString("routineId"),
            title = title,
            body = body,
            hour = hour,
            minute = minute,
            completionType = call.getString("completionType") ?: "boolean",
            quickAddAmounts = quickAddAmounts,
        )
        RescheduleReminderScheduler.schedule(context, entry)
        call.resolve()
    }

    /**
     * Full teardown of every pending one-shot reschedule reminder for a task - called
     * unconditionally on every notification sync before re-scheduling whatever's currently
     * active (see scheduleTaskNotifications in src/notifications.js), safe because a one-shot
     * alarm has no persisted awaitingCompletion/reappear-on-dismiss state a destructive
     * cancel+rearm could lose, unlike the due reminder.
     */
    @PluginMethod
    fun cancelRescheduleReminders(call: PluginCall) {
        val taskId = call.getString("taskId")
        if (taskId == null) {
            call.reject("taskId is required")
            return
        }
        val notificationManager = NotificationManagerCompat.from(context)
        for (entry in RescheduleReminderStore.readAllForTask(context, taskId)) {
            notificationManager.cancel(rescheduleReminderNotificationId(taskId, entry.newDate))
        }
        RescheduleReminderScheduler.cancelAllForTask(context, taskId)
        call.resolve()
    }

    @PluginMethod
    fun updateGroupSummary(call: PluginCall) {
        val routineId = call.getString("routineId")
        val title = call.getString("title")
        val pendingTitlesArray = call.getArray("pendingTaskTitles")
        if (routineId == null || title == null || pendingTitlesArray == null) {
            call.reject("routineId, title, and pendingTaskTitles are required")
            return
        }
        val pendingTaskTitles = (0 until pendingTitlesArray.length()).map { pendingTitlesArray.getString(it) }
        buildAndPostGroupSummaryNotification(context, routineId, title, pendingTaskTitles)
        call.resolve()
    }

    @PluginMethod
    fun cancelGroupSummary(call: PluginCall) {
        val routineId = call.getString("routineId")
        if (routineId == null) {
            call.reject("routineId is required")
            return
        }
        clearGroupSummaryContentCache(routineId)
        NotificationManagerCompat.from(context).cancel(groupSummaryNotificationId(routineId))
        call.resolve()
    }

    @PluginMethod
    fun scheduleDailyDigest(call: PluginCall) {
        val kind = call.getString("kind")
        val title = call.getString("title")
        val body = call.getString("body")
        val hour = call.getInt("hour")
        val minute = call.getInt("minute")
        if (kind == null || title == null || body == null || hour == null || minute == null) {
            call.reject("kind, title, body, hour, and minute are required")
            return
        }
        val entry = DailyDigestEntry(kind = kind, title = title, body = body, hour = hour, minute = minute)
        DailyDigestScheduler.schedule(context, entry)
        call.resolve()
    }

    /**
     * Streak-risk is the one digest kind this is ever called for (see
     * updateStreakRiskNotification in src/notifications.js) - once a streak is no longer at
     * risk, this needs to actively remove whatever's currently showing, not just stop tomorrow's
     * recurrence, since the alarm that would otherwise refresh/clear it isn't due for another
     * 24h. Mirrors cancelGroupSummary/cancelSummary's already-established pattern.
     */
    @PluginMethod
    fun cancelDailyDigest(call: PluginCall) {
        val kind = call.getString("kind")
        if (kind == null) {
            call.reject("kind is required")
            return
        }
        DailyDigestScheduler.cancel(context, kind)
        NotificationManagerCompat.from(context).cancel(dailyDigestNotificationId(kind))
        call.resolve()
    }

    /**
     * Test-only hook: fires a background-sync tick immediately instead of waiting for the real
     * 15-minute interval, so the emulator verification script doesn't need to wait real minutes
     * in CI.
     */
    @PluginMethod
    fun triggerBackgroundSyncTick(call: PluginCall) {
        BackgroundSyncBridge.onTick?.invoke()
        call.resolve()
    }

    /**
     * Test-only hook for scripts/verify-workout-session-notification.mjs's swipe-resistance
     * check - clears every currently-posted notification except the given channel (the workout
     * timer's own "workout-session-timer" channel) so a blind coordinate-based swipe can't
     * accidentally land on a leftover notification from another verify script's test routine and
     * get mistaken for a swipe-resistance failure (this exact failure mode is documented in
     * CLAUDE.md - it happened for real once, with a stray tap on a re-synced group-summary
     * notification). This replaces the pre-migration cleanup call to the stock plugin's
     * `LocalNotifications.removeAllDeliveredNotifications()`, which stopped clearing anything
     * relevant once every notification in this app moved off that plugin.
     * `NotificationManager.getActiveNotifications()` is a self-inspection API (no
     * NotificationListenerService needed) - any app can enumerate its own currently-posted
     * notifications this way.
     */
    @PluginMethod
    fun clearAllExceptChannel(call: PluginCall) {
        val keepChannelId = call.getString("channelId")
        val manager = context.getSystemService(NotificationManager::class.java)
        for (sbn in manager.activeNotifications) {
            if (sbn.notification.channelId != keepChannelId) {
                manager.cancel(sbn.id)
            }
        }
        call.resolve()
    }
}
