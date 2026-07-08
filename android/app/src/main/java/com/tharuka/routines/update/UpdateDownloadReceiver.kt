package com.tharuka.routines.update

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Dynamically registered (not manifest-declared) from UpdateInstallerPlugin.load() - a
 * runtime-registered receiver works for any broadcast, including system ones, and isn't subject
 * to Android 8+'s restriction on manifest-declared receivers for most implicit broadcasts. This
 * only needs to work while the app process is alive, which it already is thanks to
 * BackgroundSyncService keeping the process running (see CLAUDE.md's "Persistent background-sync
 * foreground service" section) - if the process is fully killed before the download finishes,
 * this simply never fires and the update silently isn't offered until the next check, an
 * accepted degradation matching this app's other native features' documented tradeoffs (e.g. the
 * workout session bridge losing at most one in-progress set on full process death).
 */
class UpdateDownloadReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
        val completedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
        val state = UpdateDownloadStore.read(context) ?: return
        if (completedId != state.downloadId) return

        // An uncaught exception in a BroadcastReceiver crashes the whole app process, not just
        // this one broadcast delivery - the exact failure mode a real crash (the boot receivers'
        // credential-storage IllegalStateException, and UpdateInstallerPlugin's own
        // DownloadManager SecurityException) has already hit twice elsewhere in this app.
        try {
            val downloadManager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val cursor = downloadManager.query(DownloadManager.Query().setFilterById(completedId))
            val succeeded = cursor.use {
                if (!it.moveToFirst()) return@use false
                val statusIndex = it.getColumnIndex(DownloadManager.COLUMN_STATUS)
                statusIndex >= 0 && it.getInt(statusIndex) == DownloadManager.STATUS_SUCCESSFUL
            }
            if (!succeeded) {
                // Cleared, not left "downloading" forever, so the next check can retry from
                // scratch rather than getting stuck thinking a (failed) download is in flight.
                UpdateDownloadStore.clear(context)
                return
            }

            val uri = downloadManager.getUriForDownloadedFile(completedId) ?: return
            UpdateDownloadStore.save(context, state.copy(status = STATUS_READY))
            ensureUpdateChannel(context)
            NotificationManagerCompat.from(context).notify(UPDATE_READY_NOTIFICATION_ID, buildUpdateReadyNotification(context, uri))
            UpdateInstallerBridge.onReady?.invoke(state.versionCode)
        } catch (e: Exception) {
            UpdateDownloadStore.clear(context)
        }
    }
}
