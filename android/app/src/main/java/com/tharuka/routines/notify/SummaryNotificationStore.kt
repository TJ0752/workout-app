package com.tharuka.routines.notify

import android.content.Context

private const val PREFS_NAME = "native_notifications_summary"
private const val KEY_TITLE = "title"
private const val KEY_BODY = "body"
private const val KEY_ONGOING = "ongoing"

data class SummaryContent(val title: String, val body: String, val ongoing: Boolean)

/**
 * Persists the last-posted summary notification content in SharedPreferences - not the app's
 * SQLite DB, which native code must never touch directly (see CLAUDE.md) - so
 * SummaryDismissReceiver can rebuild and repost it without the JS/Capacitor bridge being alive.
 * `showSummary` writes here *before* posting; `cancelSummary` clears it *before* cancelling -
 * that ordering is what lets the dismiss receiver tell an organic user-swipe (entry still
 * present -> repost) apart from a legitimate JS-driven cancel (entry absent -> no-op) without a
 * race between the two.
 */
object SummaryNotificationStore {
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun save(context: Context, content: SummaryContent) {
        prefs(context)
            .edit()
            .putString(KEY_TITLE, content.title)
            .putString(KEY_BODY, content.body)
            .putBoolean(KEY_ONGOING, content.ongoing)
            .apply()
    }

    fun read(context: Context): SummaryContent? {
        val prefs = prefs(context)
        val title = prefs.getString(KEY_TITLE, null) ?: return null
        val body = prefs.getString(KEY_BODY, null) ?: return null
        return SummaryContent(title, body, prefs.getBoolean(KEY_ONGOING, false))
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
