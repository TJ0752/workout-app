package com.tharuka.routines.workout

import com.getcapacitor.JSObject

/**
 * Same-process mediator between WorkoutSessionActivity and WorkoutSessionPlugin: Capacitor's
 * @ActivityCallback only fires once, on Activity finish, so per-set events (0-N times during a
 * session) need a channel that isn't the PluginCall itself. No IPC needed - same classloader.
 */
object WorkoutSessionBridge {
    var onSetLogged: ((JSObject) -> Unit)? = null
}
