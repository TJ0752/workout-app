/**
 * Thin wrapper over the Web Speech API's SpeechSynthesis, the web/dev-loop counterpart of native
 * DurationTimer's SpeechHelper.kt (Android TextToSpeech). Best-effort - wrapped in try/catch,
 * silently no-ops on failure or on a browser with no speechSynthesis at all - since a missed
 * announcement shouldn't break the timer itself, matching beep.js's own established pattern.
 *
 * `speechSynthesis.cancel()` before every `speak()` call is what makes rapid-fire announcements
 * (the "3, 2, 1" countdown tick) land "exactly to the time" rather than queuing up and reading
 * increasingly behind real time - without it, a slightly-slow-to-finish "3" would delay "2" by
 * however long "3" took to finish speaking, instead of "2" cutting it off and speaking right on
 * its own second. rate is bumped above the 1.0 default for the same "snappy" reason - the default
 * rate reads noticeably sluggish for a one-word cue meant to land inside a single second.
 */
export function speak(text) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.15;
    synth.speak(utterance);
  } catch {
    // Best-effort only - see this module's own doc comment.
  }
}
