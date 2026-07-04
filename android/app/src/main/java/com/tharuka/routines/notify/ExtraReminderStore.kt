package com.tharuka.routines.notify

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

// Mirrors src/utils/tasks.js's MAX_EXTRA_REMINDERS - the cap on how many extra nudge times a
// task can have in addition to its main due-by reminder (see DueReminderStore).
internal const val MAX_EXTRA_REMINDERS = 5

data class ExtraReminderEntry(
    val taskId: String,
    val slot: Int,
    val routineId: String?,
    val title: String,
    val body: String,
    val days: List<Int>,
    val hour: Int,
    val minute: Int,
    val group: String?,
    val completionType: String,
    val quickAddAmounts: List<Int>,
)

private const val PREFS_NAME = "native_notifications_extra_reminders"

private fun JSONObject.optStringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) getString(name) else null

private fun extraReminderKey(taskId: String, slot: Int) = "$taskId:$slot"

/**
 * One persisted entry per (task, slot) - a task can have up to MAX_EXTRA_REMINDERS extra nudge
 * times in addition to its main due-by reminder. Plain SharedPreferences, not the app's SQLite
 * DB - native code must never touch that directly (see CLAUDE.md).
 */
object ExtraReminderStore {
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun save(context: Context, entry: ExtraReminderEntry) {
        val json = JSONObject()
        json.put("taskId", entry.taskId)
        json.put("slot", entry.slot)
        json.put("routineId", entry.routineId)
        json.put("title", entry.title)
        json.put("body", entry.body)
        json.put("days", JSONArray(entry.days))
        json.put("hour", entry.hour)
        json.put("minute", entry.minute)
        json.put("group", entry.group)
        json.put("completionType", entry.completionType)
        json.put("quickAddAmounts", JSONArray(entry.quickAddAmounts))
        prefs(context).edit().putString(extraReminderKey(entry.taskId, entry.slot), json.toString()).apply()
    }

    fun read(context: Context, taskId: String, slot: Int): ExtraReminderEntry? {
        val raw = prefs(context).getString(extraReminderKey(taskId, slot), null) ?: return null
        return parse(raw)
    }

    fun readAll(context: Context): List<ExtraReminderEntry> {
        return prefs(context).all.values.mapNotNull { (it as? String)?.let(::parse) }
    }

    fun clear(context: Context, taskId: String, slot: Int) {
        prefs(context).edit().remove(extraReminderKey(taskId, slot)).apply()
    }

    fun clearAllForTask(context: Context, taskId: String) {
        val editor = prefs(context).edit()
        for (slot in 0 until MAX_EXTRA_REMINDERS) {
            editor.remove(extraReminderKey(taskId, slot))
        }
        editor.apply()
    }

    private fun parse(raw: String): ExtraReminderEntry? {
        return try {
            val json = JSONObject(raw)
            val days = json.getJSONArray("days")
            val daysList = (0 until days.length()).map { days.getInt(it) }
            val amounts = json.optJSONArray("quickAddAmounts")
            val amountsList = amounts?.let { arr -> (0 until arr.length()).map { arr.getInt(it) } } ?: emptyList()
            ExtraReminderEntry(
                taskId = json.getString("taskId"),
                slot = json.getInt("slot"),
                routineId = json.optStringOrNull("routineId"),
                title = json.getString("title"),
                body = json.getString("body"),
                days = daysList,
                hour = json.getInt("hour"),
                minute = json.getInt("minute"),
                group = json.optStringOrNull("group"),
                completionType = json.getString("completionType"),
                quickAddAmounts = amountsList,
            )
        } catch (e: org.json.JSONException) {
            null
        }
    }
}
