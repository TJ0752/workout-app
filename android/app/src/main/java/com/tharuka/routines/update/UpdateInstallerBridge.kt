package com.tharuka.routines.update

/**
 * Same-process singleton bridging UpdateDownloadReceiver -> UpdateInstallerPlugin, the same
 * `var on... = ...` idiom already used by DueReminderBridge/WorkoutSessionBridge/
 * BackgroundSyncBridge for exactly this "native component fires an event, plugin forwards it to
 * JS" shape.
 */
object UpdateInstallerBridge {
    var onReady: ((Int) -> Unit)? = null
    var onFailed: ((String) -> Unit)? = null
}
