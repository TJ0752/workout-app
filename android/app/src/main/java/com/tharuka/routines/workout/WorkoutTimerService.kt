package com.tharuka.routines.workout

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * A real foreground service, unlike @capacitor/local-notifications (which only ever calls
 * NotificationManagerCompat.notify(), never startForeground()) - this is what actually makes the
 * pinned notification swipe-resistant on Android 8+, and enables setUsesChronometer(), which the
 * JS plugin doesn't expose at all.
 */
class WorkoutTimerService : Service() {

    companion object {
        private const val CHANNEL_ID = "workout-session-timer"
        // Was 800000001 - an exact collision with notify.SummaryNotificationBuilder's
        // SUMMARY_NOTIFICATION_ID (also 800_000_001), picked independently during the native
        // notifications migration with no cross-reference to this already-hardcoded id. Since
        // updateSummaryNotification fires on every completion change - including every set
        // logged during a workout - the two notifications fought over one raw id for the entire
        // duration of any session (this service's startForeground() vs. the summary's plain
        // notify()/cancel() on the same id), which is exactly the kind of foreground-service
        // notification-identity mismatch Android can crash on. See CLAUDE.md's notification-id
        // range table - 850,000,001 sits clear of every other range (JS's up to ~900,000,004,
        // native due-reminder's ~600,000,000-600,999,999, group-summary's
        // ~700,000,000-700,999,999, and the summary's exact 800,000,001).
        private const val NOTIFICATION_ID = 850_000_001
        private const val ACTION_START = "com.tharuka.routines.workout.action.START"
        private const val ACTION_UPDATE_REST = "com.tharuka.routines.workout.action.UPDATE_REST"
        private const val ACTION_CLEAR_REST = "com.tharuka.routines.workout.action.CLEAR_REST"
        private const val ACTION_STOP = "com.tharuka.routines.workout.action.STOP"
        private const val EXTRA_TASK_TITLE = "taskTitle"
        private const val EXTRA_REST_SECONDS = "restSeconds"

        fun start(context: Context, taskTitle: String) {
            val intent = Intent(context, WorkoutTimerService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TASK_TITLE, taskTitle)
            }
            context.startForegroundService(intent)
        }

        fun updateRest(context: Context, restSeconds: Int) {
            val intent = Intent(context, WorkoutTimerService::class.java).apply {
                action = ACTION_UPDATE_REST
                putExtra(EXTRA_REST_SECONDS, restSeconds)
            }
            context.startService(intent)
        }

        fun clearRest(context: Context) {
            val intent = Intent(context, WorkoutTimerService::class.java).apply { action = ACTION_CLEAR_REST }
            context.startService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, WorkoutTimerService::class.java).apply { action = ACTION_STOP }
            context.startService(intent)
        }
    }

    private var taskTitle: String = "Workout"
    private var sessionStartMs: Long = System.currentTimeMillis()

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                taskTitle = intent.getStringExtra(EXTRA_TASK_TITLE) ?: taskTitle
                sessionStartMs = System.currentTimeMillis()
                ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    buildNotification(resting = false, restEndMs = 0L),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH,
                )
            }
            ACTION_UPDATE_REST -> {
                val restSeconds = intent.getIntExtra(EXTRA_REST_SECONDS, 0)
                val restEndMs = System.currentTimeMillis() + restSeconds * 1000L
                postNotification(buildNotification(resting = true, restEndMs = restEndMs))
            }
            ACTION_CLEAR_REST -> {
                postNotification(buildNotification(resting = false, restEndMs = 0L))
            }
            ACTION_STOP -> {
                // Relying on implicit cleanup via onDestroy() isn't reliable across Android
                // versions - stopSelf() alone can leave the notification pinned. Explicitly
                // detach and remove it first.
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun postNotification(notification: Notification) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(resting: Boolean, restEndMs: Long): Notification {
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_recent_history)
            .setContentTitle(taskTitle)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setUsesChronometer(true)

        if (resting) {
            builder.setContentText("Resting")
            builder.setWhen(restEndMs)
            builder.setChronometerCountDown(true)
        } else {
            builder.setContentText("Workout in progress")
            builder.setWhen(sessionStartMs)
            builder.setChronometerCountDown(false)
        }
        return builder.build()
    }

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "Workout session timer", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
}
