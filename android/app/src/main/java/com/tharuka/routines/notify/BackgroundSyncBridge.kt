package com.tharuka.routines.notify

/**
 * Same-process singleton bridging BackgroundSyncService's periodic tick to
 * NativeNotificationsPlugin's notifyListeners() call - the exact pattern already used twice
 * (DueReminderBridge, WorkoutSessionBridge).
 */
object BackgroundSyncBridge {
    var onTick: (() -> Unit)? = null
}
