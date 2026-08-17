import { useEffect, useRef, useState } from 'react';
import { formatHms, formatSpokenDuration } from '../utils/tasks';
import { playBeep } from '../utils/beep';
import { speak } from '../utils/speech';

export const RING_RADIUS = 80;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * The dominant, full-screen tap target for logging a set - the same circle shown whenever a
 * task/exercise is actively being worked. Three fill modes:
 * - Plain `fraction` (0-1): fills in step by step as `fraction` grows (a spring-like transition
 *   already defined on `.workout-ring-fill`) - used for the reps-tap flow (interactive) and
 *   DurationTimer's own idle/stopped states (static).
 * - `animateSeconds` (+ `animateKey` to restart it): fills smoothly via a single CSS transition
 *   spanning that many real wall-clock seconds, the same two-frame trick RestRing uses for its
 *   own depleting sweep, just filling instead - decoupled from React re-renders entirely, so it
 *   reads as continuous motion rather than the once-a-second steps a JS-driven `fraction` update
 *   would produce. Used by DurationTimer while actively running.
 * - `countdownMaxDegrees` (+ `countdownSeconds`): a capped-length arc anchored at the top (12
 *   o'clock), shrinking back into it - not a full lap. Used by DurationTimer's pre-start "get
 *   ready" countdown: the arc's clockwise (top) end never moves, only its anticlockwise (far) end
 *   retreats toward the top as the countdown ticks down, at the *same* seconds-to-degrees scale
 *   the running phase's own fill uses (`countdownMaxDegrees = countdownSeconds/targetSeconds *
 *   360`) - so the countdown reads as "the leading edge of where the real timer is about to
 *   start filling from," not an unrelated second animation. See the dasharray/dashoffset
 *   derivation below `offsetFor`-style reasoning: unlike the plain growing-from-top fill (which
 *   only ever needs to move `dashoffset`), pinning the *end* of a shrinking arc at a fixed point
 *   means both the dash length and its offset must animate together, since the visible segment's
 *   near edge is the one moving while its far edge stays put.
 */
export function MomentumRing({
  fraction,
  interactive,
  onClick,
  pulseKey = 0,
  hint,
  children,
  animateSeconds,
  animateKey = 0,
  countdownMaxDegrees,
  countdownSeconds = 0,
  // Red instead of the normal accent fill - used for DurationTimer's pre-start countdown, so it
  // reads as a distinct "get ready" moment rather than real progress.
  danger = false,
}) {
  const [animatedIn, setAnimatedIn] = useState(false);
  const [countdownAnimatedIn, setCountdownAnimatedIn] = useState(false);

  useEffect(() => {
    if (animateSeconds == null) return undefined;
    setAnimatedIn(false);
    const raf = requestAnimationFrame(() => setAnimatedIn(true));
    return () => cancelAnimationFrame(raf);
  }, [animateSeconds, animateKey]);

  useEffect(() => {
    if (countdownMaxDegrees == null) return undefined;
    setCountdownAnimatedIn(false);
    const raf = requestAnimationFrame(() => setCountdownAnimatedIn(true));
    return () => cancelAnimationFrame(raf);
  }, [countdownMaxDegrees, countdownSeconds, animateKey]);

  let ringStyle;
  if (countdownMaxDegrees != null) {
    // Arc length (in px along the circumference) representing the countdown window, at the same
    // degrees-per-second scale the running fill uses - capped at a full circle. `currentLength`
    // shrinks from that down to 0 as the countdown elapses; the arc's END stays pinned at the top
    // (offset always resolves so the dash's tail sits exactly at path-start) while its length
    // (and therefore its anticlockwise-most point) retreats toward the top.
    const maxLength = (Math.max(0, Math.min(360, countdownMaxDegrees)) / 360) * RING_CIRCUMFERENCE;
    const currentLength = countdownAnimatedIn ? 0 : maxLength;
    ringStyle = {
      strokeDasharray: `${currentLength} ${RING_CIRCUMFERENCE - currentLength}`,
      strokeDashoffset: currentLength - RING_CIRCUMFERENCE,
      transition: countdownAnimatedIn
        ? `stroke-dasharray ${countdownSeconds}s linear, stroke-dashoffset ${countdownSeconds}s linear`
        : 'none',
    };
  } else if (animateSeconds != null) {
    ringStyle = {
      strokeDasharray: RING_CIRCUMFERENCE,
      strokeDashoffset: animatedIn ? 0 : RING_CIRCUMFERENCE,
      transition: animatedIn ? `stroke-dashoffset ${animateSeconds}s linear` : 'none',
    };
  } else {
    ringStyle = {
      strokeDasharray: RING_CIRCUMFERENCE,
      strokeDashoffset: RING_CIRCUMFERENCE - Math.max(0, Math.min(1, fraction)) * RING_CIRCUMFERENCE,
    };
  }

  return (
    <button
      type="button"
      className={`workout-ring-tap ${interactive ? '' : 'non-interactive'}`}
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-label={hint}
    >
      <span key={`pulse-${pulseKey}`} className="workout-ring-pulse" />
      <svg className="workout-ring-svg" viewBox="0 0 180 180">
        <circle className="workout-ring-track" cx="90" cy="90" r={RING_RADIUS} />
        <circle
          className={`workout-ring-fill ${danger ? 'danger' : ''}`}
          cx="90"
          cy="90"
          r={RING_RADIUS}
          style={ringStyle}
        />
      </svg>
      <span key={`center-${pulseKey}`} className="workout-ring-center">
        {children}
      </span>
    </button>
  );
}

/**
 * A live, auto-continuing timer for a duration-based target - shared by the workout session's
 * duration exercises and the quantity-as-timer task type (the latter renders this with no
 * surrounding weight/reps chrome at all, since this component never touched those fields to
 * begin with). Counts DOWN from the target by default (remaining = target - elapsed) - matching
 * a normal kitchen-timer expectation - then keeps counting up into overtime automatically once
 * it hits zero: there is deliberately no "continue" button. The only manual actions are Stop
 * (moves to a review step letting the user log the full time, the target only, or a typed custom
 * value) and, from that review step, "Start again" (an explicit redo that discards this attempt
 * with nothing logged, for a mis-timed or aborted run). The parent remounts this via a `key` when
 * switching between independent targets (e.g. exerciseIndex/setIndex), so its own phase/elapsed
 * state never needs resetting by hand.
 *
 * The ring fills smoothly (see MomentumRing's animateSeconds) for the entire running phase -
 * once elapsed reaches the target, the CSS transition has already finished on its own (same real
 * clock), so the ring simply stays full through overtime with no extra logic needed.
 *
 * `preStartCountdownSeconds` (default 5, 0 disables it) inserts a "get ready" lead-in before the
 * real timer starts: tapping Start moves to a `countdown` phase first, showing a red arc anchored
 * at the top and shrinking back into it (MomentumRing's `countdownMaxDegrees`) rather than a full
 * lap - capped to the same seconds-to-degrees scale the running fill itself uses
 * (`preStartCountdownSeconds/targetSeconds * 360`), so the countdown reads as "the leading edge
 * of where the real fill is about to start from," not an unrelated second animation - and only
 * once it reaches the top does the real running phase (elapsed reset to 0, the actual clock)
 * begin. A beep fires once, exactly when `elapsed` first reaches `targetSeconds` (the moment
 * overtime begins), independent of the pre-start countdown - gated by `endToneEnabled` (default
 * true, a per-task/exercise setting, not global), so it can be silenced without touching the
 * countdown itself.
 *
 * `autoStart` skips the idle "Ready/Start" screen entirely and begins the running phase the
 * instant this mounts, with no countdown of its own - used by WorkoutSessionView when a duration
 * exercise's countdown was already carved out of the tail end of the preceding rest period (see
 * RestRing), so the real timer should pick up exactly where that countdown left off rather than
 * asking for a second Start tap and a second countdown. `onAutoStarted` fires once, right after,
 * so the parent can clear its own one-shot flag (this only ever applies to the exact position
 * that just came out of a rest countdown, never a later manual re-visit of the same set).
 *
 * `voiceAnnouncementsEnabled` (default true, a separate per-task/exercise setting from
 * `endToneEnabled`) speaks "Start" the moment the real timer begins, "3"/"2"/"1" on the
 * countdown's final ticks, the target duration reached (replacing the tone at that exact moment -
 * hearing both read as cluttered), a repeat announcement every `targetSeconds/2` seconds further
 * into overtime, and "Timer stopped" when the user taps Stop. See utils/speech.js.
 */
export function DurationTimer({
  targetSeconds,
  initialSeconds,
  preStartCountdownSeconds = 5,
  endToneEnabled = true,
  voiceAnnouncementsEnabled = true,
  autoStart = false,
  onAutoStarted,
  onLog,
}) {
  const [phase, setPhase] = useState('idle'); // 'idle' | 'countdown' | 'running' | 'stopped'
  const [elapsed, setElapsed] = useState(0);
  const [countdownRemaining, setCountdownRemaining] = useState(0);
  const [editing, setEditing] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const [runId, setRunId] = useState(0);
  const beepedRef = useRef(false);
  // The next overtime threshold (in seconds) due a repeat voice announcement - null until a run
  // actually starts. Set to targetSeconds + one half-target interval in start() (not
  // targetSeconds itself, which the target-reached effect below already announces on its own),
  // then advanced by one interval each time it fires, so the two announcement mechanisms never
  // both speak for the same instant.
  const nextVoiceAnnounceAtRef = useRef(null);

  useEffect(() => {
    if (phase !== 'running') return undefined;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // The pre-start lead-in's own numeric countdown (5, 4, 3, ...) - deliberately a separate,
  // once-a-second JS tick decoupled from the ring's own smooth CSS sweep, the same relationship
  // RestRing's remaining-seconds label already has with its own ring.
  useEffect(() => {
    if (phase !== 'countdown') return undefined;
    if (countdownRemaining <= 0) {
      setElapsed(0);
      beepedRef.current = false;
      setPhase('running');
      // The running phase's ring restarts its own fill animation off `animateSeconds` changing
      // value (countdown's -> target's), which normally already forces a restart - bumping
      // `runId` too is a second, independent guarantee that holds even if the two seconds values
      // happen to coincide, so the ring never inherits an already-finished countdown animation.
      setRunId((n) => n + 1);
      return undefined;
    }
    // Only the final 3 ticks get spoken, regardless of how long the configured countdown is -
    // "5... 4..." reading aloud this far ahead of the real start would be noise, not a cue.
    if (voiceAnnouncementsEnabled && countdownRemaining <= 3) {
      speak(String(countdownRemaining));
    }
    const t = setTimeout(() => setCountdownRemaining((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdownRemaining, voiceAnnouncementsEnabled]);

  // Speaks "Start" the instant the real timer begins running - whether that's from this
  // component's own countdown finishing, a skipped countdown, or `autoStart` mounting straight
  // into 'running' (in which case this fires right after the rest period's own "3, 2, 1" tail,
  // since the two are sequential, not overlapping - see WorkoutSessionView.jsx).
  useEffect(() => {
    if (phase === 'running' && voiceAnnouncementsEnabled) speak('Start');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const hasTarget = targetSeconds > 0;
  const overtime = hasTarget ? Math.max(0, elapsed - targetSeconds) : 0;
  const inOvertime = hasTarget && elapsed >= targetSeconds;
  const remaining = hasTarget ? Math.max(0, targetSeconds - elapsed) : elapsed;
  // Also true while 'stopped' (the review screen) so its ring shows the real elapsed/target
  // ratio instead of always rendering empty - only 'countdown' (which uses its own
  // countdownMaxDegrees arc, not this fraction at all) and 'idle' fall back to 0.
  const fraction = (phase === 'running' || phase === 'stopped') && hasTarget ? Math.min(1, elapsed / targetSeconds) : 0;
  // Same seconds-to-degrees scale the running fill itself uses (360deg == targetSeconds) - caps
  // at a full lap for the degenerate case where the countdown is configured longer than the
  // target itself. Falls back to a full circle if there's no real target at all (shouldn't
  // normally happen - both call sites always have a target - but keeps the arc well-defined).
  const countdownMaxDegrees = hasTarget ? Math.min(360, (preStartCountdownSeconds / targetSeconds) * 360) : 360;

  // Fires exactly once, right as the target is first reached - not on every tick throughout
  // overtime (inOvertime stays true the whole time). beepedRef still latches even when both the
  // tone and voice are disabled, so flipping a setting mid-run can't retroactively fire anything
  // for a moment that's already passed. Voice replaces the tone at this exact instant (hearing
  // both back to back read as cluttered) but the two toggles are otherwise fully independent -
  // voice's own repeat overtime announcements below have no tone equivalent at all.
  useEffect(() => {
    if (phase === 'running' && hasTarget && elapsed === targetSeconds && !beepedRef.current) {
      beepedRef.current = true;
      if (voiceAnnouncementsEnabled) {
        speak(`${formatSpokenDuration(targetSeconds)} reached`);
      } else if (endToneEnabled) {
        playBeep();
      }
    }
  }, [phase, elapsed, hasTarget, targetSeconds, endToneEnabled, voiceAnnouncementsEnabled]);

  // Repeats the "reached" announcement every half-target seconds further into overtime (a target
  // of 2:00 announces again at 3:00, 4:00, ...) - a `while` loop rather than a plain `if` so a
  // dropped/delayed tick (the tab backgrounded for a moment, etc.) can't silently skip a
  // threshold; each iteration both speaks and advances the ref before checking again.
  useEffect(() => {
    if (phase !== 'running' || !hasTarget || !voiceAnnouncementsEnabled) return;
    const intervalSeconds = Math.max(1, Math.round(targetSeconds / 2));
    while (nextVoiceAnnounceAtRef.current != null && elapsed >= nextVoiceAnnounceAtRef.current) {
      speak(`${formatSpokenDuration(nextVoiceAnnounceAtRef.current)} reached`);
      nextVoiceAnnounceAtRef.current += intervalSeconds;
    }
  }, [phase, elapsed, hasTarget, targetSeconds, voiceAnnouncementsEnabled]);

  const start = (skipCountdown = false) => {
    setEditing(false);
    setRunId((n) => n + 1);
    // The first repeat announcement lands one half-target interval *past* the target itself -
    // the target-reached effect above already owns that exact moment, so this deliberately skips
    // it to avoid both effects speaking for the same instant.
    const intervalSeconds = hasTarget ? Math.max(1, Math.round(targetSeconds / 2)) : null;
    nextVoiceAnnounceAtRef.current = hasTarget ? targetSeconds + intervalSeconds : null;
    if (!skipCountdown && preStartCountdownSeconds > 0) {
      setCountdownRemaining(preStartCountdownSeconds);
      setPhase('countdown');
    } else {
      setElapsed(0);
      beepedRef.current = false;
      setPhase('running');
    }
  };

  // Mount-only, matching the "parent remounts via key" contract every other piece of this
  // component's state already relies on - autoStart is a one-shot instruction for this exact
  // mount, not something that should re-fire on a later re-render.
  useEffect(() => {
    if (autoStart) {
      start(true);
      onAutoStarted?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => {
    if (voiceAnnouncementsEnabled) speak('Timer stopped');
    setPhase('stopped');
    setEditing(false);
    setCustomValue(String(elapsed));
  };

  if (phase === 'stopped') {
    return (
      <>
        <MomentumRing fraction={fraction} interactive={false} hint="Duration set progress">
          <span className="workout-ring-num">{formatHms(elapsed)}</span>
          <span className="workout-ring-hint">Logged</span>
        </MomentumRing>
        <div className="workout-duration-review">
          {hasTarget && <span className="workout-duration-target">Target: {formatHms(targetSeconds)}</span>}
          <span className="workout-duration-review-total">{formatHms(elapsed)} logged</span>
          {editing ? (
            <div className="workout-duration-review-edit">
              <input
                type="number"
                min="0"
                autoFocus
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
              />
              <button
                type="button"
                className="workout-duration-btn primary"
                onClick={() => onLog(customValue === '' ? 0 : Number(customValue))}
              >
                Confirm
              </button>
            </div>
          ) : (
            <div className="workout-duration-review-actions">
              <button type="button" className="workout-duration-btn primary" onClick={() => onLog(elapsed)}>
                {overtime > 0 ? `Log full time (${formatHms(elapsed)})` : `Log time (${formatHms(elapsed)})`}
              </button>
              {overtime > 0 && (
                <button type="button" className="workout-duration-btn" onClick={() => onLog(targetSeconds)}>
                  Log target only ({formatHms(targetSeconds)})
                </button>
              )}
              <div className="workout-duration-review-secondary">
                <button type="button" className="workout-duration-btn ghost" onClick={() => setEditing(true)}>
                  Edit custom time
                </button>
                <button type="button" className="workout-duration-btn ghost" onClick={() => start()}>
                  Start again
                </button>
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <MomentumRing
        fraction={fraction}
        interactive={false}
        hint={phase === 'countdown' ? 'Get ready' : 'Duration timer'}
        animateSeconds={phase === 'running' && hasTarget ? targetSeconds : undefined}
        animateKey={runId}
        countdownMaxDegrees={phase === 'countdown' ? countdownMaxDegrees : undefined}
        countdownSeconds={preStartCountdownSeconds}
        danger={phase === 'countdown'}
      >
        {phase === 'countdown' ? (
          <>
            <span className="workout-ring-num countdown">{countdownRemaining}</span>
            <span className="workout-ring-hint">Get ready</span>
          </>
        ) : (
          <>
            <span className={`workout-ring-num ${inOvertime ? 'overtime' : ''}`}>
              {phase === 'idle'
                ? formatHms(initialSeconds ?? targetSeconds ?? 0)
                : inOvertime
                  ? `+${formatHms(overtime)}`
                  : formatHms(remaining)}
            </span>
            <span className="workout-ring-hint">
              {phase === 'idle' ? 'Ready' : inOvertime ? 'Overtime' : hasTarget ? 'Remaining' : 'Elapsed'}
            </span>
          </>
        )}
      </MomentumRing>
      {hasTarget && <div className="workout-duration-target">Target: {formatHms(targetSeconds)}</div>}
      <div className="workout-duration-timer">
        {phase === 'idle' ? (
          <button type="button" className="workout-duration-btn primary" onClick={() => start()}>
            Start
          </button>
        ) : phase === 'countdown' ? (
          <button type="button" className="workout-duration-btn stop" onClick={() => setPhase('idle')}>
            Cancel
          </button>
        ) : (
          <button type="button" className="workout-duration-btn stop" onClick={stop}>
            Stop
          </button>
        )}
      </div>
    </>
  );
}
