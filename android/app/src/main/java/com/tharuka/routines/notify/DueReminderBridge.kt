package com.tharuka.routines.notify

import com.getcapacitor.JSObject

/**
 * Same-process mediator between DueReminderActionReceiver and NativeNotificationsPlugin, same
 * idiom as android/.../workout/WorkoutSessionBridge - a native BroadcastReceiver has no direct
 * route to a Capacitor plugin's notifyListeners() otherwise. Null whenever the app process isn't
 * alive (or the bridge hasn't loaded yet), which DueReminderActionReceiver uses as its signal to
 * relaunch MainActivity instead of dispatching directly.
 */
object DueReminderBridge {
    var onAction: ((JSObject) -> Unit)? = null
}
