package com.tharuka.routines.notify

import android.content.Context
import org.json.JSONObject

data class DailyDigestEntry(
    val kind: String,
    val title: String,
    val body: String,
    val hour: Int,
    val minute: Int,
)

private const val PREFS_NAME = "native_notifications_daily_digest"

/**
 * One persisted entry per kind ("morning", "evening", "streak-risk") - all three are
 * structurally identical (single computed title/body, fires at one daily hour:minute, no
 * actions, plain dismissible) so they share this one mechanism instead of three near-duplicate
 * file sets, unlike extra reminders (which need actions) or the due reminder (which needs
 * reappear-on-dismiss).
 */
object DailyDigestStore {
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun save(context: Context, entry: DailyDigestEntry) {
        val json = JSONObject()
        json.put("kind", entry.kind)
        json.put("title", entry.title)
        json.put("body", entry.body)
        json.put("hour", entry.hour)
        json.put("minute", entry.minute)
        prefs(context).edit().putString(entry.kind, json.toString()).apply()
    }

    fun read(context: Context, kind: String): DailyDigestEntry? {
        val raw = prefs(context).getString(kind, null) ?: return null
        return parse(raw)
    }

    fun readAll(context: Context): List<DailyDigestEntry> {
        return prefs(context).all.values.mapNotNull { (it as? String)?.let(::parse) }
    }

    fun clear(context: Context, kind: String) {
        prefs(context).edit().remove(kind).apply()
    }

    private fun parse(raw: String): DailyDigestEntry? {
        return try {
            val json = JSONObject(raw)
            DailyDigestEntry(
                kind = json.getString("kind"),
                title = json.getString("title"),
                body = json.getString("body"),
                hour = json.getInt("hour"),
                minute = json.getInt("minute"),
            )
        } catch (e: org.json.JSONException) {
            null
        }
    }
}
