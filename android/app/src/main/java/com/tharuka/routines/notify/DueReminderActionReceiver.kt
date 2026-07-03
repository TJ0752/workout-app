package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles Mark-done/+N/Snooze taps on the due-by reminder. Stub for now - real JS bridging
 * (Mark-done/+N via a same-process singleton + MainActivity cold-start routing, Snooze handled
 * fully natively since it never touches completions) is a later stage.
 */
class DueReminderActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // TODO: route Mark-done/+N to JS; handle Snooze fully natively (later stage).
    }
}
