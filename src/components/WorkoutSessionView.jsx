import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, Check } from 'lucide-react';

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

export default function WorkoutSessionView({ task, logsForDate, onLogSet, onClose }) {
  const exercises = task.exercises || [];
  const start = findNextPosition(exercises, logsForDate) || { exerciseIndex: 0, setIndex: 0 };
  const [exerciseIndex, setExerciseIndex] = useState(start.exerciseIndex);
  const [setIndex, setSetIndex] = useState(start.setIndex);
  const [finished, setFinished] = useState(findNextPosition(exercises, logsForDate) === null);
  const [resting, setResting] = useState(false);
  const [restRemaining, setRestRemaining] = useState(0);

  const exercise = exercises[exerciseIndex];
  const isDuration = exercise?.unit === 'seconds';
  const totalSets = Math.max(1, exercise?.targetSets || 1);
  const setsForExercise = logsForDate?.[exercise?.id] || [];
  const loggedSet = setsForExercise.find((s) => s.setIndex === setIndex);

  const [reps, setReps] = useState('');
  const [weight, setWeight] = useState('');
  const [duration, setDuration] = useState('');

  useEffect(() => {
    setReps(loggedSet?.reps ?? exercise?.targetReps ?? '');
    setWeight(loggedSet?.weight ?? exercise?.targetWeight ?? '');
    setDuration(loggedSet?.durationSeconds ?? exercise?.targetDurationSeconds ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseIndex, setIndex]);

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
    onLogSet(exercise, setIndex, {
      reps: isDuration ? null : reps === '' ? null : Number(reps),
      weight: weight === '' ? null : Number(weight),
      durationSeconds: isDuration ? (duration === '' ? null : Number(duration)) : null,
      completed: true,
    });
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
    const sets = logsForDate?.[ex.id] || [];
    return sum + sets.filter((s) => s.completed).length;
  }, 0);
  const totalPlannedSets = exercises.reduce((sum, ex) => sum + Math.max(1, ex.targetSets || 1), 0);

  return (
    <div className="workout-session">
      <div className="workout-session-header">
        <span className="workout-session-title">{task.title}</span>
        <button type="button" className="workout-session-close" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
      </div>

      <div className="workout-exercise-nav">
        {exercises.map((ex, i) => {
          const sets = logsForDate?.[ex.id] || [];
          const doneCount = sets.filter((s) => s.completed).length;
          const exTotal = Math.max(1, ex.targetSets || 1);
          return (
            <button
              type="button"
              key={ex.id}
              className={`workout-exercise-chip ${i === exerciseIndex && !finished ? 'active' : ''} ${
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

      {finished ? (
        <div className="workout-finished-screen">
          <Check size={48} className="workout-finished-icon" />
          <h3>Workout complete</h3>
          <p>
            {totalCompletedSets} of {totalPlannedSets} sets logged
          </p>
          <button type="button" className="qty-btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : resting ? (
        <div className="workout-rest-screen">
          <span className="workout-rest-label">Rest</span>
          <span className="workout-rest-countdown">{restRemaining}s</span>
          <button type="button" className="qty-btn" onClick={() => setResting(false)}>
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
            <label>
              Weight (optional)
              <input
                type="number"
                min="0"
                step="0.5"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
              />
            </label>
          </div>

          <div className="workout-set-nav">
            <button
              type="button"
              className="workout-set-nav-btn"
              disabled={exerciseIndex === 0 && setIndex === 0}
              onClick={goPrev}
            >
              <ChevronLeft size={18} />
            </button>
            <button type="button" className="qty-btn primary workout-mark-done-btn" onClick={markDone}>
              Mark set done
            </button>
            <button
              type="button"
              className="workout-set-nav-btn"
              disabled={exerciseIndex === exercises.length - 1 && setIndex === totalSets - 1}
              onClick={goNext}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
