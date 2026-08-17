package com.tharuka.routines.workout

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/**
 * Thin wrapper over Android's built-in TextToSpeech, the native counterpart of the web/dev-loop
 * path's utils/speech.js. A same-process singleton, not a per-call instance - constructing a
 * TextToSpeech engine has a real, noticeable init latency (typically 200-500ms for the engine to
 * report READY), which would violate "exactly to the time" if paid on every single utterance (a
 * "3, 2, 1" countdown tick can't afford that lag between each number). `init()` is called once
 * from WorkoutSessionActivity.onCreate() to pay that cost up front, well before the first
 * countdown tick could ever need it; `shutdown()` releases it from onDestroy(), mirroring
 * WorkoutTimerService's own start/stop lifecycle discipline for the exact same reason (a leaked
 * native engine handle is exactly the kind of resource this codebase has already been burned by
 * forgetting to release once - see ToneGenerator's own release-after-use in playBeep()).
 *
 * Best-effort throughout - wrapped in try/catch and null-checked, silently no-ops on any failure
 * (engine unavailable, no voice data installed, etc.) since a missed announcement shouldn't break
 * the timer itself, matching beep.js/playBeep's own established pattern.
 */
object SpeechHelper {
    private var tts: TextToSpeech? = null
    private var ready = false

    fun init(context: Context) {
        if (tts != null) return
        try {
            tts = TextToSpeech(context.applicationContext) { status ->
                ready = status == TextToSpeech.SUCCESS
                if (ready) {
                    tts?.language = Locale.getDefault()
                    // Bumped above the 1.0 default - a plain-word cue meant to land inside a
                    // single second (the "3, 2, 1" countdown tick) reads as noticeably sluggish
                    // at the default rate.
                    tts?.setSpeechRate(1.15f)
                }
            }
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) {}
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {}
            })
        } catch (e: Exception) {
            // Best-effort only - see this object's own doc comment.
        }
    }

    /**
     * QUEUE_FLUSH, not QUEUE_ADD - this is what makes rapid-fire announcements land "exactly to
     * the time" rather than queuing up and reading increasingly behind real time: without it, a
     * slightly-slow-to-finish "3" would delay "2" by however long "3" took to finish speaking,
     * instead of "2" cutting it off and speaking right on its own second.
     */
    fun speak(text: String) {
        val engine = tts ?: return
        if (!ready) return
        try {
            engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, text.hashCode().toString())
        } catch (e: Exception) {
            // Best-effort only - see this object's own doc comment.
        }
    }

    fun shutdown() {
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (e: Exception) {
            // Best-effort only - see this object's own doc comment.
        }
        tts = null
        ready = false
    }
}
