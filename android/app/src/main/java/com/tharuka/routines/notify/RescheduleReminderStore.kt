package com.tharuka.routines.notify

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class RescheduleReminderEntry(
    val taskId: String,
    val newDate: String, // 'YYYY-MM-DD' - the date task_reschedules moved this occurrence to
    val routineId: String?,
    val title: String,
    val body: String,
    val hour: Int,
    val minute: Int,
    val completionType: String,
    val quickAddAmounts: List<Int>,
)

private const val PREFS_NAME = "native_notifications_reschedule_reminders"

private fun JSONObject.optStringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) getString(name) else null

private fun rescheduleReminderKey(taskId: String, newDate: String) = "$taskId:$newDate"

/**
 * One persisted entry per (task, newDate) - a task can have more than one active reschedule at
 * once (different weeks' occurrences moved to different dates), so this is keyed the same way
 * ExtraReminderStore keys by (task, slot) rather than DueReminderStore's plain per-task key.
 * Plain SharedPreferences, not the app's SQLite DB - native code must never touch that directly
 * (see CLAUDE.md).
 */
object RescheduleReminderStore {
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun save(context: Context, entry: RescheduleReminderEntry) {
        val json = JSONObject()
        json.put("taskId", entry.taskId)
        json.put("newDate", entry.newDate)
        json.put("routineId", entry.routineId)
        json.put("title", entry.title)
        json.put("body", entry.body)
        json.put("hour", entry.hour)
        json.put("minute", entry.minute)
        json.put("completionType", entry.completionType)
        json.put("quickAddAmounts", JSONArray(entry.quickAddAmounts))
        prefs(context).edit().putString(rescheduleReminderKey(entry.taskId, entry.newDate), json.toString()).apply()
    }

    fun read(context: Context, taskId: String, newDate: String): RescheduleReminderEntry? {
        val raw = prefs(context).getString(rescheduleReminderKey(taskId, newDate), null) ?: return null
        return parse(raw)
    }

    fun readAll(context: Context): List<RescheduleReminderEntry> {
        return prefs(context).all.values.mapNotNull { (it as? String)?.let(::parse) }
    }

    fun readAllForTask(context: Context, taskId: String): List<RescheduleReminderEntry> {
        return readAll(context).filter { it.taskId == taskId }
    }

    fun clear(context: Context, taskId: String, newDate: String) {
        prefs(context).edit().remove(rescheduleReminderKey(taskId, newDate)).apply()
    }

    fun clearAllForTask(context: Context, taskId: String) {
        val editor = prefs(context).edit()
        for (entry in readAllForTask(context, taskId)) {
            editor.remove(rescheduleReminderKey(entry.taskId, entry.newDate))
        }
        editor.apply()
    }

    private fun parse(raw: String): RescheduleReminderEntry? {
        return try {
            val json = JSONObject(raw)
            val amounts = json.optJSONArray("quickAddAmounts")
            val amountsList = amounts?.let { arr -> (0 until arr.length()).map { arr.getInt(it) } } ?: emptyList()
            RescheduleReminderEntry(
                taskId = json.getString("taskId"),
                newDate = json.getString("newDate"),
                routineId = json.optStringOrNull("routineId"),
                title = json.getString("title"),
                body = json.getString("body"),
                hour = json.getInt("hour"),
                minute = json.getInt("minute"),
                completionType = json.getString("completionType"),
                quickAddAmounts = amountsList,
            )
        } catch (e: org.json.JSONException) {
            null
        }
    }
}
