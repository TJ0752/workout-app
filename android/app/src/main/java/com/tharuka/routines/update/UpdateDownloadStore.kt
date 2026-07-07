package com.tharuka.routines.update

import android.content.Context

private const val PREFS_NAME = "update_installer"
private const val KEY_VERSION_CODE = "versionCode"
private const val KEY_DOWNLOAD_ID = "downloadId"
private const val KEY_STATUS = "status"

const val STATUS_DOWNLOADING = "downloading"
const val STATUS_READY = "ready"

data class UpdateDownloadState(val versionCode: Int, val downloadId: Long, val status: String)

/**
 * Persists the one in-flight/ready update download in SharedPreferences - native code must never
 * touch the app's SQLite DB directly (see CLAUDE.md) - keyed by a single entry since only one
 * update can ever be downloading or ready at a time. `versionCode` lets
 * UpdateInstallerPlugin.downloadUpdate() no-op a repeat call for a build that's already
 * downloading/ready, instead of re-enqueuing (and re-downloading) the identical APK every time
 * the app happens to be reopened before the user gets around to installing.
 */
object UpdateDownloadStore {
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun save(context: Context, state: UpdateDownloadState) {
        prefs(context)
            .edit()
            .putInt(KEY_VERSION_CODE, state.versionCode)
            .putLong(KEY_DOWNLOAD_ID, state.downloadId)
            .putString(KEY_STATUS, state.status)
            .apply()
    }

    fun read(context: Context): UpdateDownloadState? {
        val prefs = prefs(context)
        if (!prefs.contains(KEY_DOWNLOAD_ID)) return null
        val status = prefs.getString(KEY_STATUS, null) ?: return null
        return UpdateDownloadState(
            versionCode = prefs.getInt(KEY_VERSION_CODE, 0),
            downloadId = prefs.getLong(KEY_DOWNLOAD_ID, -1L),
            status = status,
        )
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
