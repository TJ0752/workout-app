import { useEffect, useState } from 'react';
import { formatHms } from '../utils/tasks';

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
        <circle className="workout-ring-fill" cx="90" cy="90" r={RING_RADIUS} style={ringStyle} />
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
 */
export function DurationTimer({ targetSeconds, initialSeconds, onLog }) {
  const [phase, setPhase] = useState('idle'); // 'idle' | 'running' | 'stopped'
  const [elapsed, setElapsed] = useState(0);
  const [editing, setEditing] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    if (phase !== 'running') return undefined;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const hasTarget = targetSeconds > 0;
  const overtime = hasTarget ? Math.max(0, elapsed - targetSeconds) : 0;
  const inOvertime = hasTarget && elapsed >= targetSeconds;
  const remaining = hasTarget ? Math.max(0, targetSeconds - elapsed) : elapsed;
  const fraction = phase === 'idle' ? 0 : hasTarget ? Math.min(1, elapsed / targetSeconds) : 0;

  const start = () => {
    setElapsed(0);
    setEditing(false);
    setPhase('running');
    setRunId((n) => n + 1);
  };

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
                <button type="button" className="workout-duration-btn ghost" onClick={start}>
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
        hint="Duration timer"
        animateSeconds={phase === 'running' && hasTarget ? targetSeconds : undefined}
        animateKey={runId}
      >
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
      </MomentumRing>
      {hasTarget && <div className="workout-duration-target">Target: {formatHms(targetSeconds)}</div>}
      <div className="workout-duration-timer">
        {phase === 'idle' ? (
          <button type="button" className="workout-duration-btn primary" onClick={start}>
            Start
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
