package com.tharuka.routines.notify

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.tharuka.routines.MainActivity

internal const val EXTRA_OPEN_TASK_ID = "com.tharuka.routines.notify.OPEN_TASK_ID"
internal const val EXTRA_OPEN_ROUTINE_ID = "com.tharuka.routines.notify.OPEN_ROUTINE_ID"

/**
 * Builds the tap (content) PendingIntent every notification in the app uses to deep-link into
 * the Today screen instead of just opening the app to whatever state it was last in -
 * App.jsx/TodayView.jsx resolve these extras to scroll to and highlight the exact task, or (for
 * a routine-level notification with no single task, e.g. the group summary) expand and scroll to
 * its group. `taskId`/`routineId` are both nullable since not every notification kind is
 * task-specific (the daily summary, digests, background-sync just open to Today generally).
 *
 * `requestCode` must be the same id already used for the notification itself (dueReminderNotificationId,
 * groupSummaryNotificationId, etc.) - PendingIntent.FLAG_UPDATE_CURRENT reuses/overwrites a
 * PendingIntent's extras when its requestCode+Intent-filter already matches an existing one, so a
 * shared/colliding requestCode across two different tasks' content intents would let one task's
 * already-posted notification silently start opening a different task once the second is built.
 * MainActivity is declared `singleTask` in the manifest, so FLAG_ACTIVITY_NEW_TASK here reuses the
 * existing instance (routed through onNewIntent) rather than creating a second one.
 */
internal fun notificationTapPendingIntent(
    context: Context,
    requestCode: Int,
    taskId: String? = null,
    routineId: String? = null,
): PendingIntent {
    val intent = Intent(context, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addCategory(Intent.CATEGORY_LAUNCHER)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK
        if (taskId != null) putExtra(EXTRA_OPEN_TASK_ID, taskId)
        if (routineId != null) putExtra(EXTRA_OPEN_ROUTINE_ID, routineId)
    }
    return PendingIntent.getActivity(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}
