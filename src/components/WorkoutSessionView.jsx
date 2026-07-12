import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Check, RotateCcw } from 'lucide-react';
import { getExercisePR, getExerciseVolume, getLastUsedWeight, kgToLb, lbToKg } from '../utils/workouts';
import {
  findNextSupersetPosition,
  nextSupersetPosition,
  prevSupersetPosition,
  shouldRestAfter,
  supersetGroupLabels,
} from '../utils/supersets';
import { MomentumRing, DurationTimer } from './DurationTimer';
import { formatHms } from '../utils/tasks';

/** "60" for a whole number, "62.5" otherwise. */
function formatNumber(value) {
  return String(Math.round(value * 10) / 10);
}

const WEIGHT_STEP_KG = 2.5;

const REST_RING_RADIUS = 70;
const REST_RING_CIRCUMFERENCE = 2 * Math.PI * REST_RING_RADIUS;

/**
 * A ring of light that smoothly depletes back to its starting point over the rest duration - a
 * genuine CSS transition (not a per-second JS-driven redraw, which would look like discrete
 * ticks rather than a smooth sweep), so this is deliberately decoupled from the numeric
 * `restRemaining` countdown ticking alongside it. Rendered fully "lit" (no stroke-dashoffset)
 * for exactly one frame, then transitioned to fully depleted over `totalSeconds` - the
 * two-frame trick CSS transitions need, since a property can't visibly transition from a value
 * it's *initially rendered at* in the same paint. `resetKey` forces the two-frame sequence to
 * replay for every new rest period, even back-to-back ones with an identical duration (a plain
 * `totalSeconds` dependency wouldn't change in that case, so the effect wouldn't rerun).
 */
function RestRing({ totalSeconds, resetKey }) {
  const [depleted, setDepleted] = useState(false);
  const [justFinished, setJustFinished] = useState(false);

  useEffect(() => {
    setDepleted(false);
    setJustFinished(false);
    const raf = requestAnimationFrame(() => setDepleted(true));
    return () => cancelAnimationFrame(raf);
  }, [resetKey]);

  return (
    <svg className="workout-rest-ring-svg" viewBox="0 0 160 160">
      <circle className="workout-rest-ring-track" cx="80" cy="80" r={REST_RING_RADIUS} />
      <circle
        className={`workout-rest-ring-fill ${justFinished ? 'workout-rest-ring-blink' : ''}`}
        cx="80"
        cy="80"
        r={REST_RING_RADIUS}
        style={{
          strokeDasharray: REST_RING_CIRCUMFERENCE,
          strokeDashoffset: depleted ? REST_RING_CIRCUMFERENCE : 0,
          transition: depleted ? `stroke-dashoffset ${totalSeconds}s linear` : 'none',
        }}
        onTransitionEnd={() => setJustFinished(true)}
      />
    </svg>
  );
}

export default function WorkoutSessionView({ task, workoutLogSources, dateKey, logsForDate, onLogSet, onRestartWorkout, onClose }) {
  const exercises = task.exercises || [];
  const start = findNextSupersetPosition(exercises, logsForDate) || { exerciseIndex: 0, setIndex: 0 };
  const [exerciseIndex, setExerciseIndex] = useState(start.exerciseIndex);
  const [setIndex, setSetIndex] = useState(start.setIndex);
  const [finished, setFinished] = useState(findNextSupersetPosition(exercises, logsForDate) === null);
  const [resting, setResting] = useState(false);
  const [restRemaining, setRestRemaining] = useState(0);
  // Live, upward-ticking total session time - counts from when this session screen was opened
  // (or last restarted), not a true cross-session "time spent on this workout ever" figure,
  // since nothing tracks that across separate app opens. Reset alongside every other piece of
  // session state on Restart (handleRestart below).
  const [sessionStartedAt, setSessionStartedAt] = useState(() => Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Captured separately from `exercise.restSeconds` because markDone() calls goNext() right
  // after starting a rest, which reassigns `exercise` to the *upcoming* one - reading
  // restSeconds from it later (e.g. at render time) would use the wrong exercise's configured
  // rest duration whenever the two differ.
  const [restTotalSeconds, setRestTotalSeconds] = useState(0);
  const [restAnimKey, setRestAnimKey] = useState(0);
  const [ringAnimKey, setRingAnimKey] = useState(0);
  // A local, synchronously-updated mirror of today's logs - `onLogSet`'s persistence round-trip
  // through App.jsx is async (a SQLite write), so relying on the `logsForDate` prop alone would
  // leave the very set just logged invisible to this same render pass (e.g. the next set's
  // last-used-weight prefill would miss the set logged a moment ago). Seeded once from the prop;
  // native's WorkoutSessionScreen.kt uses the identical pattern (its own `logsByExercise` state).
  const [sessionLogs, setSessionLogs] = useState(logsForDate);

  const groupLabels = supersetGroupLabels(exercises);
  const exercise = exercises[exerciseIndex];
  const isDuration = exercise?.unit === 'seconds';
  // Purely a label/framing choice now (see the weight block below) - a calisthenics exercise's
  // weight field is "added weight" (a vest/belt worn on top of bodyweight) rather than "weight",
  // but both are logged into the same `weight` field and feed the identical
  // prefill/regression/PR/volume pipeline. Exercises saved before `type` existed have no field
  // at all - treating anything other than an explicit 'calisthenics' as weighted preserves their
  // old "Weight" labeling, rather than needing a one-time backfill/migration.
  const isWeighted = exercise?.type !== 'calisthenics';
  const totalSets = Math.max(1, exercise?.targetSets || 1);
  const setsForExercise = sessionLogs?.[exercise?.id] || [];
  const loggedSet = setsForExercise.find((s) => s.setIndex === setIndex);
  // This task's own source (if present in workoutLogSources) gets its logsByDate overridden with
  // the live sessionLogs mirror, so a set logged a moment ago in this same session is visible to
  // the lookup below even though App.jsx's copy hasn't finished its async persistence round-trip
  // yet - every *other* task's source is used as-is, since only the current task is being edited
  // this session.
  const effectiveSources = (workoutLogSources || []).map((s) =>
    s.taskId === task.id ? { ...s, logsByDate: { ...s.logsByDate, [dateKey]: sessionLogs } } : s
  );
  const exerciseId = exercise?.exerciseId || exercise?.name;
  const lastUsedWeight = exercise ? getLastUsedWeight(effectiveSources, exerciseId, dateKey) : null;

  const [reps, setReps] = useState('');
  // Canonical value stays kg (see getLastUsedWeight/kgToLb docs in utils/workouts.js); lb is a
  // second, independently-typed field so editing one doesn't fight the other's rounding while
  // you're mid-keystroke - only the field you're NOT currently typing into gets recomputed.
  const [weightKgText, setWeightKgText] = useState('');
  const [weightLbText, setWeightLbText] = useState('');

  useEffect(() => {
    setReps(loggedSet?.reps ?? exercise?.targetReps ?? '');
    const initialKg = loggedSet?.weight ?? lastUsedWeight ?? '';
    setWeightKgText(initialKg === '' ? '' : String(initialKg));
    setWeightLbText(initialKg === '' ? '' : formatNumber(kgToLb(Number(initialKg))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseIndex, setIndex]);

  const handleKgChange = (value) => {
    setWeightKgText(value);
    setWeightLbText(value === '' ? '' : formatNumber(kgToLb(Number(value))));
  };

  const handleLbChange = (value) => {
    setWeightLbText(value);
    setWeightKgText(value === '' ? '' : formatNumber(lbToKg(Number(value))));
  };

  const adjustWeight = (deltaKg) => {
    const next = Math.max(0, Math.round(((Number(weightKgText) || 0) + deltaKg) * 100) / 100);
    handleKgChange(String(next));
  };

  const currentWeightKg = weightKgText === '' ? null : Number(weightKgText);
  const isWeightRegression = lastUsedWeight != null && currentWeightKg != null && currentWeightKg < lastUsedWeight;

  useEffect(() => {
    if (!resting) return undefined;
    if (restRemaining <= 0) {
      setResting(false);
      return undefined;
    }
    const t = setTimeout(() => setRestRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [resting, restRemaining]);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - sessionStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [sessionStartedAt]);

  if (!exercise) return null;

  // Discards today's logged sets for this task and starts over from the first exercise/set - the
  // whole-session analog of DurationTimer's own "Start again" for one set. onRestartWorkout does
  // the actual destructive DB write (resetWorkoutSessionForToday, App.jsx); every piece of this
  // screen's own local state resets immediately, synchronously, rather than waiting on that async
  // round-trip - the same reasoning sessionLogs itself already exists for.
  const handleRestart = () => {
    if (!window.confirm(`Restart "${task.title}"? All sets logged today for it will be cleared.`)) return;
    onRestartWorkout?.();
    setSessionLogs({});
    setExerciseIndex(0);
    setSetIndex(0);
    setFinished(false);
    setResting(false);
    setSessionStartedAt(Date.now());
    setElapsedSeconds(0);
    setRingAnimKey((k) => k + 1);
  };

  const jumpTo = (ei) => {
    setExerciseIndex(ei);
    setSetIndex(0);
    setFinished(false);
    setResting(false);
  };

  // Round-robins within a linked superset group (every member's set N before any member's set
  // N+1) instead of finishing one exercise before starting the next - a solo, ungrouped
  // exercise is just a group of one, so this is the exact same traversal every exercise used
  // before supersets existed. See utils/supersets.js.
  const goNext = () => {
    const next = nextSupersetPosition(exercises, { exerciseIndex, setIndex });
    if (next) {
      setExerciseIndex(next.exerciseIndex);
      setSetIndex(next.setIndex);
    }
  };

  const goPrev = () => {
    const prev = prevSupersetPosition(exercises, { exerciseIndex, setIndex });
    if (prev) {
      setExerciseIndex(prev.exerciseIndex);
      setSetIndex(prev.setIndex);
    }
  };

  const logSetValues = (values) => {
    onLogSet(exercise, setIndex, values);
    setSessionLogs((prev) => ({
      ...prev,
      [exercise.id]: (prev?.[exercise.id] || []).filter((s) => s.setIndex !== setIndex).concat({ setIndex, ...values }),
    }));
    setRingAnimKey((k) => k + 1);
    const next = nextSupersetPosition(exercises, { exerciseIndex, setIndex });
    // No rest mid-superset - completing one group member's set chains straight into the next
    // member's own set at the same round, regardless of this exercise's own restSeconds. Rest
    // only applies once the *last* member of a group finishes a round (or for a plain,
    // ungrouped exercise, exactly as before this feature existed).
    if (next && exercise.restSeconds && shouldRestAfter(exercises, exerciseIndex)) {
      setRestRemaining(exercise.restSeconds);
      setRestTotalSeconds(exercise.restSeconds);
      setRestAnimKey((k) => k + 1);
      setResting(true);
    }
    if (next) {
      goNext();
    } else {
      setFinished(true);
    }
  };

  const markDone = () => {
    logSetValues({
      reps: reps === '' ? null : Number(reps),
      weight: weightKgText !== '' ? Number(weightKgText) : null,
      durationSeconds: null,
      completed: true,
    });
  };

  // The DurationTimer's Stop-then-review flow is the only way a duration set gets logged now -
  // finalSeconds is whatever the user chose there (full time, target-only, or a typed custom
  // value), not anything read back out of component state here.
  const markDoneWithDuration = (finalSeconds) => {
    logSetValues({
      reps: null,
      weight: weightKgText !== '' ? Number(weightKgText) : null,
      durationSeconds: finalSeconds,
      completed: true,
    });
  };

  const totalCompletedSets = exercises.reduce((sum, ex) => {
    const sets = sessionLogs?.[ex.id] || [];
    return sum + sets.filter((s) => s.completed).length;
  }, 0);
  const totalPlannedSets = exercises.reduce((sum, ex) => sum + Math.max(1, ex.targetSets || 1), 0);

  const currentExercisePR = getExercisePR(setsForExercise);
  const sessionVolume = exercises.reduce((sum, ex) => sum + getExerciseVolume(sessionLogs?.[ex.id] || []), 0);
  const statsParts = [];
  if (currentExercisePR) statsParts.push(`PR: ${currentExercisePR.reps || 0} × ${formatNumber(currentExercisePR.weight)}`);
  if (sessionVolume > 0) statsParts.push(`Session volume: ${formatNumber(sessionVolume)}`);

  if (finished) {
    return (
      <div className="workout-complete-screen">
        <Check size={52} strokeWidth={2.5} />
        <h3>Workout complete</h3>
        <p>
          {totalCompletedSets} of {totalPlannedSets} sets logged
        </p>
        <p className="workout-complete-time">Total time: {formatHms(elapsedSeconds)}</p>
        <button type="button" className="workout-complete-done-btn" onClick={onClose}>
          Done
        </button>
      </div>
    );
  }

  const completedCount = setsForExercise.filter((s) => s.completed).length;
  const ringFraction = completedCount / totalSets;

  return (
    <div className="workout-session">
      <div className="workout-session-header">
        <span className="workout-session-title">{task.title}</span>
        <span className="workout-session-timer">{formatHms(elapsedSeconds)}</span>
        <button type="button" className="workout-session-restart" onClick={handleRestart} aria-label="Restart workout">
          <RotateCcw size={16} />
        </button>
        <button type="button" className="workout-session-close" onClick={onClose} aria-label="Close">
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <div className="workout-exercise-nav">
        {exercises.map((ex, i) => {
          const sets = sessionLogs?.[ex.id] || [];
          const doneCount = sets.filter((s) => s.completed).length;
          const exTotal = Math.max(1, ex.targetSets || 1);
          return (
            <button
              type="button"
              key={ex.id}
              className={`workout-exercise-chip ${i === exerciseIndex ? 'active' : ''} ${
                doneCount >= exTotal ? 'complete' : ''
              } ${groupLabels[ex.id] ? 'superset-grouped' : ''}`}
              onClick={() => jumpTo(i)}
            >
              {ex.name || 'Exercise'}
              <span className="workout-exercise-chip-count">
                {doneCount}/{exTotal}
              </span>
            </button>
          );
        })}
      </div>

      {statsParts.length > 0 && <div className="workout-stats-bar">{statsParts.join('   ·   ')}</div>}

      {resting ? (
        <div className="workout-rest-screen">
          <span className="workout-rest-label">Rest</span>
          <div className="workout-rest-ring-wrap">
            <RestRing totalSeconds={restTotalSeconds} resetKey={restAnimKey} />
            <span className="workout-rest-countdown">{restRemaining}s</span>
          </div>
          {/* markDone() already advances exerciseIndex/setIndex to the upcoming position before
              entering the resting state, so `exercise`/`setIndex` here already describe what's
              next, not what was just finished - no separate lookahead needed. The rest screen
              only ever shows when there IS a next set/exercise (see markDone's own guard), so
              this never needs a "nothing next" fallback either. */}
          <span className="workout-rest-next">
            Up next: <strong>{exercise.name}</strong> · Set {setIndex + 1} of {totalSets}
          </span>
          <button type="button" className="workout-skip-rest-btn" onClick={() => setResting(false)}>
            Skip rest
          </button>
        </div>
      ) : (
        <div className="workout-set-panel">
          {groupLabels[exercise.id] && <span className="superset-group-label">Superset {groupLabels[exercise.id]}</span>}
          <h3 className="workout-exercise-name">{exercise.name}</h3>

          <div className="workout-set-dots">
            {Array.from({ length: totalSets }).map((_, i) => {
              const done = setsForExercise.find((s) => s.setIndex === i && s.completed);
              return (
                <button
                  type="button"
                  key={i}
                  className={`workout-set-dot ${done ? 'done' : ''} ${i === setIndex ? 'current' : ''}`}
                  onClick={() => setSetIndex(i)}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>

          {/* A duration set is only ever logged through DurationTimer's own Stop -> review flow
              (it renders its own copy of this same ring), so there's nothing to render here for
              it beyond that component itself. */}
          {isDuration ? (
            <DurationTimer
              key={`${exerciseIndex}-${setIndex}`}
              targetSeconds={Number(exercise.targetDurationSeconds) || 0}
              initialSeconds={loggedSet?.durationSeconds ?? null}
              onLog={markDoneWithDuration}
            />
          ) : (
            <>
              <MomentumRing fraction={ringFraction} interactive onClick={markDone} pulseKey={ringAnimKey} hint="Mark set done">
                <span className="workout-ring-num">{setIndex + 1}</span>
                <span className="workout-ring-of">of {totalSets}</span>
                <span className="workout-ring-hint">Tap ring to log</span>
              </MomentumRing>
              <div className="inline-fields">
                <label>
                  Reps
                  <input type="number" min="0" value={reps} onChange={(e) => setReps(e.target.value)} />
                </label>
              </div>
            </>
          )}

          <div className="workout-weight-block">
            <span className="field-label">
              {isWeighted ? 'Weight' : 'Added weight'} (optional)
              {isWeightRegression && (
                <span className="workout-weight-warning-label"> — lower than last time ({formatNumber(lastUsedWeight)} kg)</span>
              )}
            </span>
            <div className={`workout-weight-row ${isWeightRegression ? 'warning' : ''}`}>
              <button
                type="button"
                className="workout-weight-stepper-btn"
                onClick={() => adjustWeight(-WEIGHT_STEP_KG)}
                aria-label="Decrease weight"
              >
                −
              </button>
              <div className="workout-weight-inputs">
                <label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={weightKgText}
                    onChange={(e) => handleKgChange(e.target.value)}
                  />
                  kg
                </label>
                <label>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={weightLbText}
                    onChange={(e) => handleLbChange(e.target.value)}
                  />
                  lb
                </label>
              </div>
              <button
                type="button"
                className="workout-weight-stepper-btn"
                onClick={() => adjustWeight(WEIGHT_STEP_KG)}
                aria-label="Increase weight"
              >
                +
              </button>
            </div>
          </div>

          <div className="workout-set-nav">
            <button
              type="button"
              className="workout-set-nav-btn"
              disabled={!prevSupersetPosition(exercises, { exerciseIndex, setIndex })}
              onClick={goPrev}
            >
              <ChevronLeft size={26} />
            </button>
            <span className="workout-set-nav-hint">{isDuration ? 'Use the timer above' : 'Tap the ring to log the set'}</span>
            <button
              type="button"
              className="workout-set-nav-btn"
              disabled={!nextSupersetPosition(exercises, { exerciseIndex, setIndex })}
              onClick={goNext}
            >
              <ChevronRight size={26} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
