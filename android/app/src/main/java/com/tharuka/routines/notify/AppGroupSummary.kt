package com.tharuka.routines.notify

import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Every notification this app posts (due/extra reminders, routine group listings, the daily
 * summary, digests, streak-risk, background-sync) shares this one group key, so Android always
 * collapses them together into a single expandable stack in the shade - previously each
 * multi-task routine had its own separate group key (`"routine-$routineId"`), and several
 * notification kinds (daily summary, digests, background-sync) had no group key at all, which is
 * why grouping only ever seemed to happen "sometimes." A single flat app-wide group, not a
 * per-routine one, is the deliberate choice here - Android has no native concept of nested
 * groups, so "stack everything from this app together" and "stack this routine's own tasks
 * together" can't both be true with per-routine keys; routine identity is still communicated via
 * each notification's own title (see taskNotificationContent's `"{routine} · {task}"` format in
 * src/notifications.js), not via a separate OS-level grouping tier.
 */
internal const val APP_GROUP_KEY = "com.tharuka.routines.notifications"

// Disjoint from every other range in CLAUDE.md's notification-id table (450M/600M/700M are all
// hashToInt()-based ranges spanning +0..999,999 from their base, so this sits comfortably clear
// of all of them, as well as every fixed single id already in use).
internal const val APP_GROUP_SUMMARY_ID = 960_000_001

/**
 * The one notification in the group flagged `setGroupSummary(true)` - Android requires an
 * explicit summary for reliable, launcher-independent collapsing (without one, some launchers
 * only auto-generate a collapsed view once 4+ notifications share a group, which undersells the
 * "always grouped" intent here). Posted once per app-process start (from
 * NativeNotificationsPlugin.load(), alongside channel creation) - deliberately plain and
 * swipeable; if dismissed, the individual notifications underneath are unaffected and a fresh
 * app open reposts it.
 */
internal fun postAppGroupSummary(context: Context) {
    val notification = NotificationCompat.Builder(context, DUE_REMINDER_CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_recent_history)
        .setContentTitle("Daily Routines")
        .setContentText("Reminders and updates")
        .setGroup(APP_GROUP_KEY)
        .setGroupSummary(true)
        .setAutoCancel(true)
        // Content here never changes, so there's never a reason for a repost (once per app
        // process start) to re-sound - unlike the summary/group-summary notifications above,
        // this doesn't need a content-equality check since it's not called from a
        // resync-on-every-app-open path, just once per process.
        .setOnlyAlertOnce(true)
        .setContentIntent(notificationTapPendingIntent(context, APP_GROUP_SUMMARY_ID))
        .build()
    NotificationManagerCompat.from(context).notify(APP_GROUP_SUMMARY_ID, notification)
}
