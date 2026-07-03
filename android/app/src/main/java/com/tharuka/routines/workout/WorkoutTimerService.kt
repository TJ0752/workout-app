package com.tharuka.routines.workout

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
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
        private const val ACTION_UPDATE_PROGRESS = "com.tharuka.routines.workout.action.UPDATE_PROGRESS"
        private const val ACTION_STOP = "com.tharuka.routines.workout.action.STOP"
        private const val EXTRA_TASK_TITLE = "taskTitle"
        private const val EXTRA_REST_SECONDS = "restSeconds"
        private const val EXTRA_EXERCISE_NAME = "exerciseName"
        private const val EXTRA_PLANNED_SETS = "plannedSetsPerExercise"
        private const val EXTRA_COMPLETED_SETS = "completedSetsPerExercise"
        private const val EXTRA_EXERCISE_INDEX = "exerciseIndex"
        private const val EXTRA_LAST_SET_SUMMARY = "lastSetSummary"
        private const val EXTRA_IS_PR = "isPR"

        // Matches src/index.css's --accent (current exercise) and a muted neutral (not yet
        // reached), used to color Notification.ProgressStyle's per-exercise segments on API 36+.
        private const val ACCENT_COLOR = 0xFF0A9764.toInt()
        private const val NEUTRAL_COLOR = 0xFF9E9689.toInt()

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

        /**
         * Feeds the live exercise/progress/PR state shown by the API-36+ ProgressStyle
         * notification (see buildProgressStyleNotification) - called from WorkoutSessionScreen on
         * every navigation and every logged set, the same way updateRest/clearRest already are.
         * A no-op below API 36, since buildNotification only reads these fields on that branch.
         */
        fun updateProgress(
            context: Context,
            exerciseName: String,
            plannedSetsPerExercise: List<Int>,
            completedSetsPerExercise: List<Int>,
            currentExerciseIndex: Int,
            lastSetSummary: String?,
            isPR: Boolean,
        ) {
            val intent = Intent(context, WorkoutTimerService::class.java).apply {
                action = ACTION_UPDATE_PROGRESS
                putExtra(EXTRA_EXERCISE_NAME, exerciseName)
                putExtra(EXTRA_PLANNED_SETS, plannedSetsPerExercise.toIntArray())
                putExtra(EXTRA_COMPLETED_SETS, completedSetsPerExercise.toIntArray())
                putExtra(EXTRA_EXERCISE_INDEX, currentExerciseIndex)
                putExtra(EXTRA_LAST_SET_SUMMARY, lastSetSummary)
                putExtra(EXTRA_IS_PR, isPR)
            }
            context.startService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, WorkoutTimerService::class.java).apply { action = ACTION_STOP }
            context.startService(intent)
        }
    }

    private var taskTitle: String = "Workout"
    private var sessionStartMs: Long = System.currentTimeMillis()
    private var isResting: Boolean = false
    private var currentExerciseName: String = ""
    private var plannedSetsPerExercise: List<Int> = emptyList()
    private var completedSetsPerExercise: List<Int> = emptyList()
    private var currentExerciseIndex: Int = 0
    private var lastSetSummary: String? = null
    private var isPR: Boolean = false

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
                isResting = true
                val restSeconds = intent.getIntExtra(EXTRA_REST_SECONDS, 0)
                val restEndMs = System.currentTimeMillis() + restSeconds * 1000L
                postNotification(buildNotification(resting = true, restEndMs = restEndMs))
            }
            ACTION_CLEAR_REST -> {
                isResting = false
                postNotification(buildNotification(resting = false, restEndMs = 0L))
            }
            ACTION_UPDATE_PROGRESS -> {
                currentExerciseName = intent.getStringExtra(EXTRA_EXERCISE_NAME) ?: currentExerciseName
                intent.getIntArrayExtra(EXTRA_PLANNED_SETS)?.let { plannedSetsPerExercise = it.toList() }
                intent.getIntArrayExtra(EXTRA_COMPLETED_SETS)?.let { completedSetsPerExercise = it.toList() }
                currentExerciseIndex = intent.getIntExtra(EXTRA_EXERCISE_INDEX, currentExerciseIndex)
                lastSetSummary = intent.getStringExtra(EXTRA_LAST_SET_SUMMARY)
                isPR = intent.getBooleanExtra(EXTRA_IS_PR, false)
                // Rest's countdown notification takes priority for its duration - clearRest()
                // rebuilds with these freshly-stored fields once it ends.
                if (!isResting) postNotification(buildNotification(resting = false, restEndMs = 0L))
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
        // The rich progress bar only applies while actively logging sets - during rest the plain
        // chronometer-countdown notification below already covers that concern well, and rest
        // naturally pauses "current exercise progress" conceptually anyway.
        if (Build.VERSION.SDK_INT >= 36 && !resting) {
            return buildProgressStyleNotification()
        }

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

    /**
     * Android 16+ (API 36) Notification.ProgressStyle - one segment per exercise (sized by its
     * planned set count, current exercise highlighted), with a live chronometer, the current
     * exercise's last logged set, and a "New PR!" callout, all built from the fields
     * updateProgress() feeds in. Marked EXTRA_REQUEST_PROMOTED_ONGOING for the higher shelf/lock-
     * screen prominence "Live Updates" get - purely cosmetic prominence, not a dismiss-blocker
     * (confirmed via Android's own docs); the genuine swipe-resistance here still comes from this
     * being a real foreground service, exactly as on every other Android version.
     */
    private fun buildProgressStyleNotification(): Notification {
        val segments = if (plannedSetsPerExercise.isEmpty()) {
            listOf(Notification.ProgressStyle.Segment(1))
        } else {
            plannedSetsPerExercise.mapIndexed { index, planned ->
                val color = if (index == currentExerciseIndex) ACCENT_COLOR else NEUTRAL_COLOR
                Notification.ProgressStyle.Segment(maxOf(1, planned)).setColor(color)
            }
        }
        val totalPlanned = segments.sumOf { it.length }
        val progress = completedSetsPerExercise.sum().coerceIn(0, totalPlanned)
        val progressStyle = Notification.ProgressStyle()
            .setProgressSegments(segments)
            .setProgress(progress)

        val exerciseLabel = currentExerciseName.ifBlank { taskTitle }
        val contentText = if (lastSetSummary.isNullOrBlank()) {
            exerciseLabel
        } else {
            "$exerciseLabel — last set: $lastSetSummary"
        }

        val builder = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_recent_history)
            .setContentTitle(taskTitle)
            .setContentText(contentText)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setUsesChronometer(true)
            .setWhen(sessionStartMs)
            .setStyle(progressStyle)

        if (isPR) {
            builder.setSubText("🏆 New PR!")
        }

        val notification = builder.build()
        notification.putExtra(Notification.EXTRA_REQUEST_PROMOTED_ONGOING, true)
        return notification
    }

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "Workout session timer", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
}
