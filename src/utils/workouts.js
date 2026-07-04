import { dateToKey } from './date';

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

/** Epley formula: a lifter's estimated 1-rep max from any logged weight x reps pair - lets
 * "how strong am I" be compared across different rep ranges, rather than only ever comparing
 * the single heaviest set at any one rep count the way getExercisePR does. */
export function epley1RM(weight, reps) {
  if (!weight || !reps) return 0;
  return weight * (1 + reps / 30);
}

/** Best estimated 1-rep max across a set of logged sets. A heavier single and a slightly
 * lighter set for more reps can trade places once normalized this way - that's the point of
 * tracking e1RM instead of just the raw top weight. */
export function getExerciseE1RM(logs) {
  let best = null;
  for (const set of logs || []) {
    if (!set.completed || !set.weight || !set.reps) continue;
    const e1rm = epley1RM(set.weight, set.reps);
    if (!best || e1rm > best.e1rm) best = { e1rm, weight: set.weight, reps: set.reps };
  }
  return best;
}

/** Bodyweight/reps-based equivalent of getExercisePR - most reps completed in a single set,
 * for exercises with no weight (push-ups, pull-ups). getExercisePR itself never considers
 * these sets, since it requires set.weight. */
export function getExerciseRepPR(logs) {
  let best = null;
  for (const set of logs || []) {
    if (!set.completed || set.weight || !set.reps) continue;
    if (!best || set.reps > best.reps) best = set;
  }
  return best;
}

/** Total reps across a set of logged sets, for bodyweight/reps-based exercises - the
 * reps-denominated equivalent of getExerciseVolume's weight x reps total, since a bodyweight
 * exercise has no weight to multiply by. */
export function getExerciseTotalReps(logs) {
  return (logs || []).reduce((sum, set) => (set.completed && !set.weight && set.reps ? sum + set.reps : sum), 0);
}

/** Duration-based equivalent of getExercisePR - the longest single hold (plank, wall-sit). */
export function getExerciseDurationPR(logs) {
  let best = null;
  for (const set of logs || []) {
    if (!set.completed || !set.durationSeconds) continue;
    if (!best || set.durationSeconds > best.durationSeconds) best = set;
  }
  return best;
}

/** Total time under tension across a set of logged sets - the duration-denominated equivalent
 * of getExerciseVolume. */
export function getExerciseTotalDuration(logs) {
  return (logs || []).reduce((sum, set) => (set.completed && set.durationSeconds ? sum + set.durationSeconds : sum), 0);
}

/**
 * Per-session (per-date) summary for one exercise across every date it was trained - the
 * series a trend chart iterates over, since getWorkoutStats's byExercise only exposes an
 * all-time total, not per-session values. Includes every metric; callers pick whichever field
 * fits the exercise's type (e1rm for weighted, totalReps for bodyweight, totalDuration for
 * duration-based).
 */
export function getExerciseSessionSeries(logsForTaskByDate, exerciseId) {
  const dates = Object.keys(logsForTaskByDate || {}).sort();
  const series = [];
  for (const date of dates) {
    const sets = logsForTaskByDate[date]?.[exerciseId];
    const completedSets = (sets || []).filter((s) => s.completed);
    if (completedSets.length === 0) continue;
    series.push({
      date,
      e1rm: getExerciseE1RM(completedSets)?.e1rm || 0,
      volume: getExerciseVolume(completedSets),
      totalReps: getExerciseTotalReps(completedSets),
      totalDuration: getExerciseTotalDuration(completedSets),
    });
  }
  return series;
}

function mondayOf(dateKeyStr) {
  const d = new Date(`${dateKeyStr}T00:00:00`);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return dateToKey(d);
}

/**
 * Weekly calisthenics-vs-weightlifting session mix across a task's full logged history. A
 * session counts as "weighted" if any set logged that day had a weight - mixed sessions are
 * common, and this tracks overall training style rather than requiring set-level purity.
 * Percentages, not raw kg-vs-reps totals, since those two units aren't directly comparable
 * (the actual reason this is a session-count/percentage chart and not a dual-axis one).
 */
export function getSessionMixByWeek(logsForTaskByDate) {
  const dates = Object.keys(logsForTaskByDate || {}).sort();
  const weeks = new Map();
  for (const date of dates) {
    const exerciseLogs = logsForTaskByDate[date] || {};
    const allSets = Object.values(exerciseLogs).flat();
    if (!allSets.some((s) => s.completed)) continue;
    const weighted = allSets.some((s) => s.completed && s.weight);
    const weekStart = mondayOf(date);
    const bucket = weeks.get(weekStart) || { weekStart, weighted: 0, bodyweight: 0 };
    if (weighted) bucket.weighted += 1;
    else bucket.bodyweight += 1;
    weeks.set(weekStart, bucket);
  }
  return Array.from(weeks.values())
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1))
    .map((w) => ({
      ...w,
      weightedPct: Math.round((w.weighted / (w.weighted + w.bodyweight)) * 100),
    }));
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
    const isWeighted = allLogsForExercise.some((s) => s.completed && s.weight);
    byExercise[exercise.id] = {
      exercise,
      isWeighted,
      pr: getExercisePR(allLogsForExercise),
      volume: getExerciseVolume(allLogsForExercise),
      e1rm: getExerciseE1RM(allLogsForExercise),
      repPR: getExerciseRepPR(allLogsForExercise),
      totalReps: getExerciseTotalReps(allLogsForExercise),
      durationPR: getExerciseDurationPR(allLogsForExercise),
      totalDuration: getExerciseTotalDuration(allLogsForExercise),
      setsLogged: allLogsForExercise.filter((s) => s.completed).length,
      series: getExerciseSessionSeries(logsForTaskByDate, exercise.id),
    };
  }
  return {
    byExercise,
    recentSessions: getWorkoutSessionHistory(logsForTaskByDate),
    sessionMix: getSessionMixByWeek(logsForTaskByDate),
  };
}

/**
 * Aggregates fitness stats across every workout-type task in the app, merging exercises by
 * name so the same real-world exercise (e.g. "Bench Press") logged from different routines
 * combines into one PR/trend rather than being siloed per routine - getWorkoutStats alone
 * only ever looks at a single task. Backs the Fitness Stats screen: an adaptive overview (only
 * a weighted-PR tile if any weighted exercise exists, only a bodyweight-PR tile if any
 * bodyweight exercise exists), the calisthenics-vs-weightlifting mix, and a per-exercise list
 * where each entry already carries whichever metric actually fits its type.
 */
export function getFitnessOverview(routines, workoutLogsByTask) {
  const workoutTasks = [];
  for (const routine of routines || []) {
    for (const task of routine.tasks || []) {
      if (task.completionType === 'workout') workoutTasks.push(task);
    }
  }

  const byName = new Map();
  for (const task of workoutTasks) {
    const logsForTask = workoutLogsByTask?.[task.id] || {};
    for (const exercise of task.exercises || []) {
      const name = exercise.name || 'Exercise';
      const entry = byName.get(name) || { name, logs: [], seriesByDate: {} };
      for (const [date, byExerciseId] of Object.entries(logsForTask)) {
        const sets = byExerciseId[exercise.id];
        if (!sets || sets.length === 0) continue;
        entry.logs.push(...sets);
        entry.seriesByDate[date] = (entry.seriesByDate[date] || []).concat(sets);
      }
      byName.set(name, entry);
    }
  }

  const exercises = Array.from(byName.values())
    .map((entry) => {
      const isWeighted = entry.logs.some((s) => s.completed && s.weight);
      const series = Object.keys(entry.seriesByDate)
        .sort()
        .map((date) => {
          const completedSets = entry.seriesByDate[date].filter((s) => s.completed);
          return {
            date,
            e1rm: getExerciseE1RM(completedSets)?.e1rm || 0,
            totalReps: getExerciseTotalReps(completedSets),
            totalDuration: getExerciseTotalDuration(completedSets),
          };
        })
        .filter((s) => s.e1rm || s.totalReps || s.totalDuration);
      return {
        name: entry.name,
        isWeighted,
        pr: getExercisePR(entry.logs),
        e1rm: getExerciseE1RM(entry.logs),
        volume: getExerciseVolume(entry.logs),
        repPR: getExerciseRepPR(entry.logs),
        totalReps: getExerciseTotalReps(entry.logs),
        durationPR: getExerciseDurationPR(entry.logs),
        totalDuration: getExerciseTotalDuration(entry.logs),
        series,
      };
    })
    .filter((e) => e.series.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const mixWeeks = new Map();
  for (const task of workoutTasks) {
    const logsForTask = workoutLogsByTask?.[task.id] || {};
    for (const w of getSessionMixByWeek(logsForTask)) {
      const bucket = mixWeeks.get(w.weekStart) || { weekStart: w.weekStart, weighted: 0, bodyweight: 0 };
      bucket.weighted += w.weighted;
      bucket.bodyweight += w.bodyweight;
      mixWeeks.set(w.weekStart, bucket);
    }
  }
  const sessionMix = Array.from(mixWeeks.values())
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1))
    .map((w) => ({ ...w, weightedPct: Math.round((w.weighted / (w.weighted + w.bodyweight)) * 100) }));

  const weightedExercises = exercises.filter((e) => e.isWeighted && e.e1rm);
  const bodyweightExercises = exercises.filter((e) => !e.isWeighted && (e.repPR || e.durationPR));

  const topWeightedPR = weightedExercises.reduce((best, e) => (!best || e.e1rm.e1rm > best.e1rm.e1rm ? e : best), null);
  const topBodyweightPR = bodyweightExercises.reduce(
    (best, e) => (!best || (e.repPR?.reps || 0) > (best.repPR?.reps || 0) ? e : best),
    null
  );

  return {
    hasWorkouts: exercises.length > 0,
    exercises,
    sessionMix,
    topWeightedPR,
    topBodyweightPR,
  };
}
