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
 * reading its source; see CLAUDE.md). Currently covers the daily summary notification; the
 * per-task due-by reminder joins later in this same migration.
 */
@CapacitorPlugin(name = "NativeNotifications")
class NativeNotificationsPlugin : Plugin() {

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
}
