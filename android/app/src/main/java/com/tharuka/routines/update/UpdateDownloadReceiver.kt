package com.tharuka.routines.update

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat

/**
 * Human-readable text for DownloadManager's own STATUS_FAILED reason codes (COLUMN_REASON) - a
 * raw HTTP status code (>= 400) can also show up here per DownloadManager's own docs ("If an HTTP
 * error occurred, this will hold the HTTP status code"), so anything not matching a known
 * ERROR_* constant is reported as one instead of falling back to a meaningless raw int with no
 * context.
 */
private fun describeDownloadFailureReason(reason: Int): String = when (reason) {
    DownloadManager.ERROR_CANNOT_RESUME -> "cannot resume"
    DownloadManager.ERROR_DEVICE_NOT_FOUND -> "storage not found"
    DownloadManager.ERROR_FILE_ALREADY_EXISTS -> "destination file already exists"
    DownloadManager.ERROR_FILE_ERROR -> "storage error"
    DownloadManager.ERROR_HTTP_DATA_ERROR -> "network data error"
    DownloadManager.ERROR_INSUFFICIENT_SPACE -> "not enough storage space"
    DownloadManager.ERROR_TOO_MANY_REDIRECTS -> "too many redirects"
    DownloadManager.ERROR_UNHANDLED_HTTP_CODE -> "unexpected server response"
    DownloadManager.ERROR_UNKNOWN -> "unknown error"
    else -> if (reason >= 400) "HTTP $reason" else "error code $reason"
}

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
            val (succeeded, failureReason) = cursor.use {
                if (!it.moveToFirst()) return@use false to "download record not found"
                val statusIndex = it.getColumnIndex(DownloadManager.COLUMN_STATUS)
                val status = if (statusIndex >= 0) it.getInt(statusIndex) else -1
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    true to null
                } else {
                    val reasonIndex = it.getColumnIndex(DownloadManager.COLUMN_REASON)
                    val reasonCode = if (reasonIndex >= 0) it.getInt(reasonIndex) else -1
                    false to describeDownloadFailureReason(reasonCode)
                }
            }
            if (!succeeded) {
                // Previously cleared silently with zero signal anywhere - from the user's
                // perspective the "Downloading update…" toast just vanished with no explanation
                // and no install prompt ever showed up. Logged (visible via a real device bug
                // report, same diagnostic path used elsewhere in this app - see CLAUDE.md) and
                // forwarded to JS so UpdateChecker.jsx can show an actual error instead of
                // silently falling back to idle.
                Log.w("UpdateDownloadReceiver", "Update download failed: $failureReason")
                UpdateDownloadStore.clear(context)
                UpdateInstallerBridge.onFailed?.invoke(failureReason ?: "unknown error")
                return
            }

            val uri = downloadManager.getUriForDownloadedFile(completedId)
            if (uri == null) {
                UpdateDownloadStore.clear(context)
                UpdateInstallerBridge.onFailed?.invoke("downloaded file not found")
                return
            }
            UpdateDownloadStore.save(context, state.copy(status = STATUS_READY))
            ensureUpdateChannel(context)
            NotificationManagerCompat.from(context).notify(UPDATE_READY_NOTIFICATION_ID, buildUpdateReadyNotification(context, uri))
            UpdateInstallerBridge.onReady?.invoke(state.versionCode)
        } catch (e: Exception) {
            Log.w("UpdateDownloadReceiver", "Update download handling threw", e)
            UpdateDownloadStore.clear(context)
            UpdateInstallerBridge.onFailed?.invoke(e.message ?: "unexpected error")
        }
    }
}
