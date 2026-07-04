package com.tharuka.routines.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * A persistent, low-priority foreground service that keeps the app process (and its JS engine)
 * alive indefinitely once the app has been opened, ticking periodically so digest/summary/
 * streak-risk content stays fresh without requiring the user to reopen the app. Native code
 * can't compute this content itself (it needs SQLite completions data, and native code must
 * never touch the app's DB directly - see CLAUDE.md) - this service exists purely to keep JS
 * alive long enough to periodically re-run the same sync it already runs on every app open and
 * completion change (see initBackgroundSyncListener in src/nativeNotifications.js).
 *
 * Uses the `specialUse` foreground service type, not the more semantically-obvious `dataSync` -
 * confirmed via Android's official docs that `dataSync` (and `mediaProcessing`) are capped at 6
 * cumulative hours per 24-hour period on Android 15+ (this app's targetSdkVersion is 36), after
 * which the system calls Service.onTimeout() and requires stopSelf() within seconds or throws a
 * fatal RemoteServiceException - which would have silently killed this exact feature (staying
 * alive for many hours while backgrounded) a few hours into any day the app isn't reopened.
 * `specialUse` has no such limit - see the manifest's PROPERTY_SPECIAL_USE_FGS_SUBTYPE
 * declaration for the required justification string.
 */
class BackgroundSyncService : Service() {

    companion object {
        private const val CHANNEL_ID = "background-sync"
        private const val NOTIFICATION_ID = 950_000_001
        private const val ACTION_START = "com.tharuka.routines.notify.action.BG_SYNC_START"
        private const val ACTION_STOP = "com.tharuka.routines.notify.action.BG_SYNC_STOP"
        private const val TICK_INTERVAL_MS = 15 * 60 * 1000L

        fun start(context: Context) {
            val intent = Intent(context, BackgroundSyncService::class.java).apply { action = ACTION_START }
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, BackgroundSyncService::class.java).apply { action = ACTION_STOP }
            context.startService(intent)
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val tickRunnable = object : Runnable {
        override fun run() {
            BackgroundSyncBridge.onTick?.invoke()
            handler.postDelayed(this, TICK_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                handler.removeCallbacks(tickRunnable)
                // Relying on implicit cleanup via onDestroy() isn't reliable across Android
                // versions (same lesson as WorkoutTimerService) - explicitly detach and remove
                // the notification before stopping.
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            else -> {
                ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
                // The first tick fires 15 minutes out, not immediately - an immediate tick would
                // just duplicate the sync App.jsx already runs on its own app-open effect.
                handler.removeCallbacks(tickRunnable)
                handler.postDelayed(tickRunnable, TICK_INTERVAL_MS)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(tickRunnable)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, BackgroundSyncActionReceiver::class.java)
        val stopPendingIntent = PendingIntent.getBroadcast(
            this,
            NOTIFICATION_ID,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_recent_history)
            .setContentTitle("Daily Routines")
            .setContentText("Keeping reminders and summaries up to date")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "Stop", stopPendingIntent)
            .build()
    }

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "Background sync", NotificationManager.IMPORTANCE_MIN)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
}
