package com.tharuka.routines.update

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import com.tharuka.routines.notify.APP_GROUP_KEY

// Own channel, created lazily here rather than in notify/NotificationChannels.kt - only this one
// notification ever posts to it, mirroring BackgroundSyncService's identical own-channel choice
// (see CLAUDE.md: channels only shared across multiple posters belong in the shared helper).
private const val CHANNEL_ID = "app-updates"

// Fixed - exactly one update-ready notification ever exists. A fresh, disjoint value against
// every other range documented in CLAUDE.md's "Notification-id ranges" list.
internal const val UPDATE_READY_NOTIFICATION_ID = 970_000_001

internal fun ensureUpdateChannel(context: Context) {
    val channel = NotificationChannel(CHANNEL_ID, "App updates", NotificationManager.IMPORTANCE_DEFAULT)
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
}

/** Shared by the notification's content intent below and UpdateInstallerPlugin.installReadyUpdate()'s
 * direct startActivity() call, so both routes launch the installer identically. */
internal fun installIntentFor(apkUri: Uri): Intent {
    return Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(apkUri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}

internal fun installPendingIntent(context: Context, apkUri: Uri): PendingIntent {
    return PendingIntent.getActivity(
        context,
        UPDATE_READY_NOTIFICATION_ID,
        installIntentFor(apkUri),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

/**
 * Plain, dismissible - tapping it fires the install confirmation directly. Deliberately routed
 * through a real notification tap (a genuine user gesture) rather than auto-launching the install
 * Activity the instant the download completes: Android's background-activity-start restrictions
 * make an unprompted startActivity() call from a BroadcastReceiver unreliable once the app isn't
 * in the foreground, while a notification's PendingIntent is always exempt from that restriction
 * regardless of the app's foreground/background state - the one mechanism in this flow that's
 * guaranteed to work every time, not just when the user happens to still be looking at the app.
 */
internal fun buildUpdateReadyNotification(context: Context, apkUri: Uri): Notification {
    return NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setContentTitle("Update ready")
        .setContentText("Tap to install the latest version of Daily Routines")
        .setAutoCancel(true)
        .setGroup(APP_GROUP_KEY)
        .setContentIntent(installPendingIntent(context, apkUri))
        .build()
}
