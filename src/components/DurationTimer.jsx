import { useEffect, useRef, useState } from 'react';
import { formatHms } from '../utils/tasks';
import { playBeep } from '../utils/beep';

export const RING_RADIUS = 80;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * The dominant, full-screen tap target for logging a set - the same circle shown whenever a
 * task/exercise is actively being worked. Two fill modes:
 * - Plain `fraction` (0-1): fills in step by step as `fraction` grows (a spring-like transition
 *   already defined on `.workout-ring-fill`) - used for the reps-tap flow (interactive) and
 *   DurationTimer's own idle/stopped states (static).
 * - `animateSeconds` (+ `animateKey` to restart it): fills smoothly via a single CSS transition
 *   spanning that many real wall-clock seconds, the same two-frame trick RestRing uses for its
 *   own depleting sweep, just filling instead - decoupled from React re-renders entirely, so it
 *   reads as continuous motion rather than the once-a-second steps a JS-driven `fraction` update
 *   would produce. Used by DurationTimer while actively running.
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
  // Red instead of the normal accent fill - used for DurationTimer's pre-start countdown, so it
  // reads as a distinct "get ready" moment rather than real progress.
  danger = false,
}) {
  const [animatedIn, setAnimatedIn] = useState(false);

  useEffect(() => {
    if (animateSeconds == null) return undefined;
    setAnimatedIn(false);
    const raf = requestAnimationFrame(() => setAnimatedIn(true));
    return () => cancelAnimationFrame(raf);
  }, [animateSeconds, animateKey]);

  const ringStyle =
    animateSeconds != null
      ? {
          strokeDasharray: RING_CIRCUMFERENCE,
          strokeDashoffset: animatedIn ? 0 : RING_CIRCUMFERENCE,
          transition: animatedIn ? `stroke-dashoffset ${animateSeconds}s linear` : 'none',
        }
      : {
          strokeDasharray: RING_CIRCUMFERENCE,
          strokeDashoffset: RING_CIRCUMFERENCE - Math.max(0, Math.min(1, fraction)) * RING_CIRCUMFERENCE,
        };

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
 * real timer starts: tapping Start moves to a `countdown` phase first, showing a red arc growing
 * clockwise from the top - the *same* animateSeconds fill mechanic the running ring already uses,
 * just red and counting a fixed short window down to zero - and only once that completes does the
 * real running phase (elapsed reset to 0, the actual clock) begin. A beep fires once, exactly when
 * `elapsed` first reaches `targetSeconds` (the moment overtime begins), independent of the
 * pre-start countdown.
 *
 * `autoStart` skips the idle "Ready/Start" screen entirely and begins the running phase the
 * instant this mounts, with no countdown of its own - used by WorkoutSessionView when a duration
 * exercise's countdown was already carved out of the tail end of the preceding rest period (see
 * RestRing), so the real timer should pick up exactly where that countdown left off rather than
 * asking for a second Start tap and a second countdown. `onAutoStarted` fires once, right after,
 * so the parent can clear its own one-shot flag (this only ever applies to the exact position
 * that just came out of a rest countdown, never a later manual re-visit of the same set).
 */
export function DurationTimer({
  targetSeconds,
  initialSeconds,
  preStartCountdownSeconds = 5,
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
      return undefined;
    }
    const t = setTimeout(() => setCountdownRemaining((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdownRemaining]);

  const hasTarget = targetSeconds > 0;
  const overtime = hasTarget ? Math.max(0, elapsed - targetSeconds) : 0;
  const inOvertime = hasTarget && elapsed >= targetSeconds;
  const remaining = hasTarget ? Math.max(0, targetSeconds - elapsed) : elapsed;
  const fraction = phase === 'running' && hasTarget ? Math.min(1, elapsed / targetSeconds) : 0;

  // Fires exactly once, right as the target is first reached - not on every tick throughout
  // overtime (inOvertime stays true the whole time).
  useEffect(() => {
    if (phase === 'running' && hasTarget && elapsed === targetSeconds && !beepedRef.current) {
      beepedRef.current = true;
      playBeep();
    }
  }, [phase, elapsed, hasTarget, targetSeconds]);

  const start = (skipCountdown = false) => {
    setEditing(false);
    setRunId((n) => n + 1);
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
        animateSeconds={
          phase === 'running' && hasTarget ? targetSeconds : phase === 'countdown' ? preStartCountdownSeconds : undefined
        }
        animateKey={runId}
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
