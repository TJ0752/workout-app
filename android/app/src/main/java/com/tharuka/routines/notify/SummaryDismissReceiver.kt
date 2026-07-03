package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The setDeleteIntent() target for the summary notification - this is the actual
 * "reappear on dismiss" mechanism. If SummaryNotificationStore still has content (an organic
 * user swipe of a notification the app still wants showing), immediately repost it; if the
 * store is empty (cancelSummary already cleared it because nothing's due), do nothing.
 */
class SummaryDismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val content = SummaryNotificationStore.read(context) ?: return
        buildAndPostSummaryNotification(context, content)
    }
}
