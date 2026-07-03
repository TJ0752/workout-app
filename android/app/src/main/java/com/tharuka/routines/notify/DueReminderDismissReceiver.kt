package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * The setDeleteIntent() target for the due-by reminder - the actual "reappear on dismiss"
 * mechanism, same pattern as SummaryDismissReceiver. If the stored entry is still
 * awaitingCompletion (an organic user swipe of a still-pending reminder), immediately rebuild
 * and repost it; if that flag is already false (cleared elsewhere once the task is marked done),
 * no-op. Reads from DueReminderStore, not app memory, so this works with the process fully dead.
 */
class DueReminderDismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(EXTRA_TASK_ID) ?: return
        val entry = DueReminderStore.read(context, taskId) ?: return
        if (!entry.awaitingCompletion) return
        val notification = buildDueReminderNotification(context, entry)
        NotificationManagerCompat.from(context).notify(dueReminderNotificationId(taskId), notification)
    }
}
