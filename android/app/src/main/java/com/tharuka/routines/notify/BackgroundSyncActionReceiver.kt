package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The "Stop" action on the background-sync notification - stops the service for this app
 * session only. Reopening the app restarts it via NativeNotificationsPlugin.load() again;
 * there's no persisted "disabled" flag for v1.
 */
class BackgroundSyncActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        BackgroundSyncService.stop(context)
    }
}
