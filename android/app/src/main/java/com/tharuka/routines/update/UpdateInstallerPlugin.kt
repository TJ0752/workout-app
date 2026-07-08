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
import java.io.File

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

        // A real bug, found via a user's on-device report: every version downloads to the same
        // fixed destination filename (see assetNameFor's own doc comment in updateCheck.js - the
        // name is stable per flavor, only the file's *contents* change between versions), and
        // nothing ever deleted the previous download once it was installed. DownloadManager.
        // enqueue() fails outright ("the file already exists") the second time around as a
        // result - confirmed against Android's own DownloadManager issue tracker, a well-known
        // pitfall of reusing a destination path. The symptom matched exactly: the first update
        // (a fresh destination file) worked, every one after silently failed at enqueue() and
        // got swallowed by the catch block below, with no visible error beyond the "Downloading
        // update..." toast's own auto-hide timeout. DownloadManager.remove() clears both its own
        // bookkeeping row and the underlying file in one call, so this always leaves a clean
        // slate before enqueueing - covers a stale "ready" entry from an update that was already
        // installed, a stuck/failed prior download, and (the explicit file check, since a failed
        // download's row may already have been cleared by UpdateDownloadReceiver without
        // removing its partial file) any leftover file not tracked by the store at all.
        //
        // A real crash, found via a separate user's on-device bug report: an uncaught exception
        // here (e.g. the SecurityException DownloadManager.enqueue() threw before this app
        // declared android.permission.DOWNLOAD_WITHOUT_NOTIFICATION - see the manifest)
        // propagates all the way up through Capacitor's plugin-dispatch HandlerThread and
        // crashes the whole process, not just this one call - caught here so any future
        // unexpected failure rejects the JS promise instead of taking the app down.
        try {
            val downloadManager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            existing?.let { downloadManager.remove(it.downloadId) }
            val destinationFile = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName)
            if (destinationFile.exists()) destinationFile.delete()

            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle("Daily Routines update")
                .setMimeType("application/vnd.android.package-archive")
                // Hidden - buildUpdateReadyNotification posts our own notification once the
                // download completes instead, so the tap target is unambiguously this app.
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_HIDDEN)
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, fileName)

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
