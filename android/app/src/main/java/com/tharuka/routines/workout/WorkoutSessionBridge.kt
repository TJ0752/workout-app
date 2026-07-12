package com.tharuka.routines.workout

import com.getcapacitor.JSObject

/**
 * Same-process mediator between WorkoutSessionActivity and WorkoutSessionPlugin: Capacitor's
 * @ActivityCallback only fires once, on Activity finish, so per-set events (0-N times during a
 * session) need a channel that isn't the PluginCall itself. No IPC needed - same classloader.
 */
object WorkoutSessionBridge {
    var onSetLogged: ((JSObject) -> Unit)? = null

    // Fired once when a "pure timer" (quantity-as-timer) session logs its one value - see
    // WorkoutSessionActivity's pureTimer branch. A separate field rather than reusing onSetLogged
    // since a pure timer has no Exercise/setIndex at all, just {taskId, dateKey, seconds}.
    var onQuantityTimerLogged: ((JSObject) -> Unit)? = null

    // Fired when the user confirms "Restart workout" - the actual destructive DB write
    // (resetWorkoutSessionForToday) must happen JS-side, same reasoning as onSetLogged: native
    // code must never touch the app's SQLite file directly. The screen's own local state resets
    // synchronously regardless of whether this round-trip has finished (see
    // WorkoutSessionScreen.kt's handleRestart).
    var onRestartRequested: ((JSObject) -> Unit)? = null
}
