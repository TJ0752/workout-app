package com.tharuka.routines.notify

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class DueReminderEntry(
    val taskId: String,
    val routineId: String?,
    val title: String,
    val body: String,
    val days: List<Int>,
    val hour: Int,
    val minute: Int,
    val group: String?,
    val completionType: String,
    val quickAddAmounts: List<Int>,
    val awaitingCompletion: Boolean = false,
)

private const val PREFS_NAME = "native_notifications_due_reminders"

private fun JSONObject.optStringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) getString(name) else null

/**
 * One persisted entry per task, keyed by taskId - the source of truth for DueReminderScheduler,
 * DueReminderAlarmReceiver, DueReminderDismissReceiver, and (later) DueReminderBootReceiver, all
 * of which must work with the app process fully dead. SharedPreferences, not the app's SQLite
 * DB - native code must never touch that directly (see CLAUDE.md).
 */
object DueReminderStore {
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun save(context: Context, entry: DueReminderEntry) {
        val json = JSONObject()
        json.put("taskId", entry.taskId)
        json.put("routineId", entry.routineId)
        json.put("title", entry.title)
        json.put("body", entry.body)
        json.put("days", JSONArray(entry.days))
        json.put("hour", entry.hour)
        json.put("minute", entry.minute)
        json.put("group", entry.group)
        json.put("completionType", entry.completionType)
        json.put("quickAddAmounts", JSONArray(entry.quickAddAmounts))
        json.put("awaitingCompletion", entry.awaitingCompletion)
        prefs(context).edit().putString(entry.taskId, json.toString()).apply()
    }

    fun read(context: Context, taskId: String): DueReminderEntry? {
        val raw = prefs(context).getString(taskId, null) ?: return null
        return parse(raw)
    }

    fun readAll(context: Context): List<DueReminderEntry> {
        return prefs(context).all.values.mapNotNull { (it as? String)?.let(::parse) }
    }

    fun clear(context: Context, taskId: String) {
        prefs(context).edit().remove(taskId).apply()
    }

    fun setAwaitingCompletion(context: Context, taskId: String, awaiting: Boolean) {
        val entry = read(context, taskId) ?: return
        save(context, entry.copy(awaitingCompletion = awaiting))
    }

    private fun parse(raw: String): DueReminderEntry? {
        return try {
            val json = JSONObject(raw)
            val days = json.getJSONArray("days")
            val daysList = (0 until days.length()).map { days.getInt(it) }
            val amounts = json.optJSONArray("quickAddAmounts")
            val amountsList = amounts?.let { arr -> (0 until arr.length()).map { arr.getInt(it) } } ?: emptyList()
            DueReminderEntry(
                taskId = json.getString("taskId"),
                routineId = json.optStringOrNull("routineId"),
                title = json.getString("title"),
                body = json.getString("body"),
                days = daysList,
                hour = json.getInt("hour"),
                minute = json.getInt("minute"),
                group = json.optStringOrNull("group"),
                completionType = json.getString("completionType"),
                quickAddAmounts = amountsList,
                awaitingCompletion = json.optBoolean("awaitingCompletion", false),
            )
        } catch (e: org.json.JSONException) {
            null
        }
    }
}
