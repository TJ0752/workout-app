package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The setDeleteIntent() target for the due-by reminder. Stub for now, mirroring
 * DueReminderAlarmReceiver's earlier staging - real repost-on-dismiss logic (checking
 * awaitingCompletion, same pattern as SummaryDismissReceiver) is the next stage.
 */
class DueReminderDismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // TODO: repost from DueReminderStore if still awaitingCompletion (next stage).
    }
}
