function plannedSetsFor(exercise) {
  return Math.max(1, exercise.targetSets || 1);
}

/**
 * A workout session's completion fraction (0-1): sets actually logged as
 * complete, divided by total sets planned across every exercise. Written to
 * `completions.value` exactly like a quantity task's actual/target, so the
 * rest of the fraction pipeline (getTaskFraction/getRoutineFraction/streaks)
 * needs no awareness that workouts exist - see utils/date.js.
 */
export function computeSessionFraction(exercises, logsForTaskDate) {
  if (!exercises?.length) return 0;
  let planned = 0;
  let completed = 0;
  for (const exercise of exercises) {
    planned += plannedSetsFor(exercise);
    const sets = logsForTaskDate?.[exercise.id] || [];
    completed += sets.filter((s) => s.completed).length;
  }
  if (planned === 0) return 0;
  return Math.min(1, completed / planned);
}

/** Total reps x weight across a set of logged sets (0 for duration-based sets, which have no weight). */
export function getExerciseVolume(logs) {
  return (logs || []).reduce((sum, set) => {
    if (!set.completed || !set.reps || !set.weight) return sum;
    return sum + set.reps * set.weight;
  }, 0);
}

/** Best set ever for an exercise: max weight lifted, tie-broken by reps. */
export function getExercisePR(logs) {
  let best = null;
  for (const set of logs || []) {
    if (!set.completed || !set.weight) continue;
    if (!best || set.weight > best.weight || (set.weight === best.weight && (set.reps || 0) > (best.reps || 0))) {
      best = set;
    }
  }
  return best;
}

/** Regroups a flat exercise-id -> sets map (one date's logs) back into a per-date session list, most recent first. */
export function getWorkoutSessionHistory(logsForTaskByDate, limit = 10) {
  const dates = Object.keys(logsForTaskByDate || {}).sort((a, b) => (a < b ? 1 : -1));
  return dates.slice(0, limit).map((date) => {
    const exerciseLogs = logsForTaskByDate[date];
    const allSets = Object.values(exerciseLogs).flat();
    return {
      date,
      completedSets: allSets.filter((s) => s.completed).length,
      totalSets: allSets.length,
      volume: allSets.reduce((sum, s) => (s.completed && s.reps && s.weight ? sum + s.reps * s.weight : sum), 0),
    };
  });
}

/**
 * Exercise-level stats for a workout task's Dashboard drill-down: per
 * exercise, its PR, volume across all logged dates, and recent sessions.
 * `logsForTask` is `workoutLogsByTask[task.id]` - `{ [date]: { [exerciseId]: [sets] } }`.
 */
export function getWorkoutStats(task, logsForTask) {
  const logsForTaskByDate = logsForTask || {};
  const byExercise = {};
  for (const exercise of task.exercises || []) {
    const allLogsForExercise = Object.values(logsForTaskByDate).flatMap((byExerciseId) => byExerciseId[exercise.id] || []);
    byExercise[exercise.id] = {
      exercise,
      pr: getExercisePR(allLogsForExercise),
      volume: getExerciseVolume(allLogsForExercise),
      setsLogged: allLogsForExercise.filter((s) => s.completed).length,
    };
  }
  return {
    byExercise,
    recentSessions: getWorkoutSessionHistory(logsForTaskByDate),
  };
}
