package com.tharuka.routines.update

import android.app.DownloadManager
import android.content.Context
import android.content.IntentFilter
import android.net.Uri
import android.os.Environment
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Downloads a release APK via Android's own DownloadManager (not a browser round-trip) and, once
 * complete, posts a tap-to-install notification (UpdateDownloadReceiver/buildUpdateReadyNotification)
 * - the closest a sideloaded (non-Play-Store) app can get to Play Store's silent auto-update.
 * Android has no permission that lets a regular app skip the system's own install confirmation
 * dialog entirely - that's reserved for privileged installers (Play Store itself, or root) - so a
 * single tap on that dialog is the unavoidable floor, not a gap in this implementation.
 */
@CapacitorPlugin(name = "UpdateInstaller")
class UpdateInstallerPlugin : Plugin() {

    override fun load() {
        super.load()
        // Dynamically registered, not manifest-declared - see UpdateDownloadReceiver's own doc
        // comment for why. ACTION_DOWNLOAD_COMPLETE is a protected system broadcast (sent by the
        // DownloadManager system service, a different process), so RECEIVER_EXPORTED is the
        // correct flag here - RECEIVER_NOT_EXPORTED is for broadcasts this app sends to itself.
        ContextCompat.registerReceiver(
            context,
            UpdateDownloadReceiver(),
            IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED,
        )
        UpdateInstallerBridge.onReady = { versionCode ->
            val data = JSObject()
            data.put("versionCode", versionCode)
            notifyListeners("updateReady", data, true)
        }
    }

    /**
     * No-ops (resolves immediately without re-enqueuing) if this exact versionCode is already
     * downloading or ready - JS calls this on every silent app-open check that finds an update
     * available, and without this guard a repeat check (the common case: the user reopens the
     * app before getting around to installing) would re-download the identical APK from scratch
     * every time.
     */
    @PluginMethod
    fun downloadUpdate(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        val fileName = call.getString("fileName") ?: return call.reject("fileName is required")
        val versionCode = call.getInt("versionCode") ?: return call.reject("versionCode is required")

        val existing = UpdateDownloadStore.read(context)
        if (existing != null && existing.versionCode == versionCode) {
            call.resolve(JSObject().apply { put("status", existing.status) })
            return
        }

        // A real crash, found via a user's on-device bug report: an uncaught exception here
        // (e.g. the SecurityException DownloadManager.enqueue() threw before this app declared
        // android.permission.DOWNLOAD_WITHOUT_NOTIFICATION - see the manifest) propagates all
        // the way up through Capacitor's plugin-dispatch HandlerThread and crashes the whole
        // process, not just this one call - caught here so any future unexpected failure
        // rejects the JS promise instead of taking the app down.
        try {
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle("Daily Routines update")
                .setMimeType("application/vnd.android.package-archive")
                // Hidden - buildUpdateReadyNotification posts our own notification once the
                // download completes instead, so the tap target is unambiguously this app.
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_HIDDEN)
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, fileName)

            val downloadManager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val downloadId = downloadManager.enqueue(request)
            UpdateDownloadStore.save(context, UpdateDownloadState(versionCode, downloadId, STATUS_DOWNLOADING))

            call.resolve(JSObject().apply { put("status", STATUS_DOWNLOADING) })
        } catch (e: Exception) {
            call.reject("Failed to enqueue update download", e)
        }
    }

    /**
     * Re-fires the same install intent as tapping the "Update ready" notification - lets in-app
     * UI offer a retry if that notification was dismissed or missed. Called directly from a
     * user's in-app button tap, so (unlike UpdateDownloadReceiver's own launch) there's no
     * background-activity-start concern here at all - the Activity is already in the foreground.
     */
    @PluginMethod
    fun installReadyUpdate(call: PluginCall) {
        val state = UpdateDownloadStore.read(context)
        if (state == null || state.status != STATUS_READY) {
            call.resolve(JSObject().apply { put("installed", false) })
            return
        }
        try {
            val downloadManager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val uri = downloadManager.getUriForDownloadedFile(state.downloadId)
            if (uri == null) {
                call.resolve(JSObject().apply { put("installed", false) })
                return
            }
            context.startActivity(installIntentFor(uri))
            call.resolve(JSObject().apply { put("installed", true) })
        } catch (e: Exception) {
            call.reject("Failed to launch install intent", e)
        }
    }
}
