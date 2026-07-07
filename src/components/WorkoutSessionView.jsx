import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { getExercisePR, getExerciseVolume, getLastUsedWeight, kgToLb, lbToKg } from '../utils/workouts';

/** "60" for a whole number, "62.5" otherwise. */
function formatNumber(value) {
  return String(Math.round(value * 10) / 10);
}

const WEIGHT_STEP_KG = 2.5;

function findNextPosition(exercises, logsForDate) {
  for (let ei = 0; ei < exercises.length; ei++) {
    const exercise = exercises[ei];
    const totalSets = Math.max(1, exercise.targetSets || 1);
    const sets = logsForDate?.[exercise.id] || [];
    for (let si = 0; si < totalSets; si++) {
      if (!sets.find((s) => s.setIndex === si && s.completed)) {
        return { exerciseIndex: ei, setIndex: si };
      }
    }
  }
  return null;
}

const RING_RADIUS = 80;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export default function WorkoutSessionView({ task, taskLogs, dateKey, logsForDate, onLogSet, onClose }) {
  const exercises = task.exercises || [];
  const start = findNextPosition(exercises, logsForDate) || { exerciseIndex: 0, setIndex: 0 };
  const [exerciseIndex, setExerciseIndex] = useState(start.exerciseIndex);
  const [setIndex, setSetIndex] = useState(start.setIndex);
  const [finished, setFinished] = useState(findNextPosition(exercises, logsForDate) === null);
  const [resting, setResting] = useState(false);
  const [restRemaining, setRestRemaining] = useState(0);
  const [ringAnimKey, setRingAnimKey] = useState(0);
  // A local, synchronously-updated mirror of today's logs - `onLogSet`'s persistence round-trip
  // through App.jsx is async (a SQLite write), so relying on the `logsForDate` prop alone would
  // leave the very set just logged invisible to this same render pass (e.g. the next set's
  // last-used-weight prefill would miss the set logged a moment ago). Seeded once from the prop;
  // native's WorkoutSessionScreen.kt uses the identical pattern (its own `logsByExercise` state).
  const [sessionLogs, setSessionLogs] = useState(logsForDate);

  const exercise = exercises[exerciseIndex];
  const isDuration = exercise?.unit === 'seconds';
  // Exercises saved before this field existed have no `type` at all - treating anything other
  // than an explicit 'calisthenics' as weighted preserves their old behavior (the weight input
  // used to always show), rather than needing a one-time backfill/migration.
  const isWeighted = exercise?.type !== 'calisthenics';
  const totalSets = Math.max(1, exercise?.targetSets || 1);
  const setsForExercise = sessionLogs?.[exercise?.id] || [];
  const loggedSet = setsForExercise.find((s) => s.setIndex === setIndex);
  const effectiveTaskLogs = { ...taskLogs, [dateKey]: sessionLogs };
  const lastUsedWeight =
    isWeighted && exercise ? getLastUsedWeight(effectiveTaskLogs, exercise.id, dateKey) : null;

  const [reps, setReps] = useState('');
  // Canonical value stays kg (see getLastUsedWeight/kgToLb docs in utils/workouts.js); lb is a
  // second, independently-typed field so editing one doesn't fight the other's rounding while
  // you're mid-keystroke - only the field you're NOT currently typing into gets recomputed.
  const [weightKgText, setWeightKgText] = useState('');
  const [weightLbText, setWeightLbText] = useState('');
  const [duration, setDuration] = useState('');

  useEffect(() => {
    setReps(loggedSet?.reps ?? exercise?.targetReps ?? '');
    const initialKg = loggedSet?.weight ?? lastUsedWeight ?? exercise?.targetWeight ?? '';
    setWeightKgText(initialKg === '' ? '' : String(initialKg));
    setWeightLbText(initialKg === '' ? '' : formatNumber(kgToLb(Number(initialKg))));
    setDuration(loggedSet?.durationSeconds ?? exercise?.targetDurationSeconds ?? '');
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
  const isWeightRegression =
    isWeighted && lastUsedWeight != null && currentWeightKg != null && currentWeightKg < lastUsedWeight;

  useEffect(() => {
    if (!resting) return undefined;
    if (restRemaining <= 0) {
      setResting(false);
      return undefined;
    }
    const t = setTimeout(() => setRestRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [resting, restRemaining]);

  if (!exercise) return null;

  const jumpTo = (ei) => {
    setExerciseIndex(ei);
    setSetIndex(0);
    setFinished(false);
    setResting(false);
  };

  const goNext = () => {
    if (setIndex + 1 < totalSets) {
      setSetIndex(setIndex + 1);
    } else if (exerciseIndex + 1 < exercises.length) {
      setExerciseIndex(exerciseIndex + 1);
      setSetIndex(0);
    }
  };

  const goPrev = () => {
    if (setIndex > 0) {
      setSetIndex(setIndex - 1);
    } else if (exerciseIndex > 0) {
      const prevExercise = exercises[exerciseIndex - 1];
      setExerciseIndex(exerciseIndex - 1);
      setSetIndex(Math.max(0, (prevExercise.targetSets || 1) - 1));
    }
  };

  const markDone = () => {
    const values = {
      reps: isDuration ? null : reps === '' ? null : Number(reps),
      weight: isWeighted && weightKgText !== '' ? Number(weightKgText) : null,
      durationSeconds: isDuration ? (duration === '' ? null : Number(duration)) : null,
      completed: true,
    };
    onLogSet(exercise, setIndex, values);
    setSessionLogs((prev) => ({
      ...prev,
      [exercise.id]: (prev?.[exercise.id] || []).filter((s) => s.setIndex !== setIndex).concat({ setIndex, ...values }),
    }));
    setRingAnimKey((k) => k + 1);
    const hasNextSet = setIndex + 1 < totalSets;
    const hasNextExercise = exerciseIndex + 1 < exercises.length;
    if ((hasNextSet || hasNextExercise) && exercise.restSeconds) {
      setRestRemaining(exercise.restSeconds);
      setResting(true);
    }
    if (hasNextSet || hasNextExercise) {
      goNext();
    } else {
      setFinished(true);
    }
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
        <button type="button" className="workout-complete-done-btn" onClick={onClose}>
          Done
        </button>
      </div>
    );
  }

  const completedCount = setsForExercise.filter((s) => s.completed).length;
  const ringFraction = completedCount / totalSets;
  const ringOffset = RING_CIRCUMFERENCE - ringFraction * RING_CIRCUMFERENCE;

  return (
    <div className="workout-session">
      <div className="workout-session-header">
        <span className="workout-session-title">{task.title}</span>
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
              }`}
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
          <span className="workout-rest-countdown">{restRemaining}s</span>
          <button type="button" className="workout-skip-rest-btn" onClick={() => setResting(false)}>
            Skip rest
          </button>
        </div>
      ) : (
        <div className="workout-set-panel">
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

          <button type="button" className="workout-ring-tap" onClick={markDone} aria-label="Mark set done">
            <span key={`pulse-${ringAnimKey}`} className="workout-ring-pulse" />
            <svg className="workout-ring-svg" viewBox="0 0 180 180">
              <circle className="workout-ring-track" cx="90" cy="90" r={RING_RADIUS} />
              <circle
                className="workout-ring-fill"
                cx="90"
                cy="90"
                r={RING_RADIUS}
                style={{ strokeDasharray: RING_CIRCUMFERENCE, strokeDashoffset: ringOffset }}
              />
            </svg>
            <span key={`center-${ringAnimKey}`} className="workout-ring-center">
              <span className="workout-ring-num">{setIndex + 1}</span>
              <span className="workout-ring-of">of {totalSets}</span>
              <span className="workout-ring-hint">Tap ring to log</span>
            </span>
          </button>

          <div className="inline-fields">
            {isDuration ? (
              <label>
                Duration (sec)
                <input
                  type="number"
                  min="0"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                />
              </label>
            ) : (
              <label>
                Reps
                <input type="number" min="0" value={reps} onChange={(e) => setReps(e.target.value)} />
              </label>
            )}
          </div>

          {isWeighted && (
            <div className="workout-weight-block">
              <span className="field-label">
                Weight (optional)
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
          )}

          <div className="workout-set-nav">
            <button
              type="button"
              className="workout-set-nav-btn"
              disabled={exerciseIndex === 0 && setIndex === 0}
              onClick={goPrev}
            >
              <ChevronLeft size={26} />
            </button>
            <span className="workout-set-nav-hint">Tap the ring to log the set</span>
            <button
              type="button"
              className="workout-set-nav-btn"
              disabled={exerciseIndex === exercises.length - 1 && setIndex === totalSets - 1}
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
