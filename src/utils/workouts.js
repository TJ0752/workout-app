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

/**
 * Flattens every workout-type task across every routine into the {taskId, exercises,
 * logsByDate} "sources" list getLastUsedWeight scans - not just the one task currently being
 * logged, so a last-used-weight search by exerciseId can find the same real-world exercise
 * wherever it was last logged (see CLAUDE.md's "Exercise repository" section for exerciseId
 * itself, the cross-routine identity this merges by). Kept as its own step, exported separately
 * from getLastUsedWeight, because the native companion needs this exact flattened shape
 * serialized once into its session-start payload (see nativeWorkoutSession.js) -
 * WorkoutSessionActivity.kt has no Routine/Task object model at all, only ever receiving flat
 * exercises/logs shapes across the plugin bridge - so both platforms scan the identical shape
 * with the identical algorithm in getLastUsedWeight below.
 */
export function buildWorkoutLogSources(routines, workoutLogsByTask) {
  const sources = [];
  for (const routine of routines || []) {
    for (const task of routine.tasks || []) {
      if (task.completionType !== 'workout') continue;
      sources.push({
        taskId: task.id,
        exercises: (task.exercises || []).map((ex) => ({ id: ex.id, exerciseId: ex.exerciseId || ex.name })),
        logsByDate: workoutLogsByTask?.[task.id] || {},
      });
    }
  }
  return sources;
}

/**
 * The most recently logged weight for an exercise, across every routine/task that logs it -
 * matched by exerciseId (the cross-routine exercise-repository identity), not scoped to the one
 * task currently being logged, so the same real-world exercise logged under two different
 * routines shares one last-used-weight/regression-warning baseline. `sources` is the flat shape
 * buildWorkoutLogSources produces (or, on the native side, the equivalent payload built at
 * session-start - see :shared's WorkoutLogic.kt). Looks back through every date on or before a
 * cutoff across every source whose exercises include a matching exerciseId (including sets
 * already logged earlier the same day, so a set's own later sets prefill with what was just
 * used), picking whichever (date, setIndex) pair is latest overall.
 */
export function getLastUsedWeight(sources, exerciseId, onOrBeforeDateKey) {
  if (!exerciseId) return null;
  let best = null;
  for (const source of sources || []) {
    const localIds = (source.exercises || []).filter((ex) => ex.exerciseId === exerciseId).map((ex) => ex.id);
    if (localIds.length === 0) continue;
    const logsByDate = source.logsByDate || {};
    for (const date of Object.keys(logsByDate)) {
      if (date > onOrBeforeDateKey) continue;
      for (const localId of localIds) {
        const sets = (logsByDate[date]?.[localId] || []).filter((s) => s.completed && s.weight != null);
        for (const s of sets) {
          if (!best || date > best.date || (date === best.date && s.setIndex > best.setIndex)) {
            best = { date, setIndex: s.setIndex, weight: s.weight };
          }
        }
      }
    }
  }
  return best ? best.weight : null;
}

const KG_PER_LB = 0.45359237;

/** kg -> lb, for the dual-unit weight field. Canonical storage stays kg (matching every
 * already-logged weight in the app before this field existed) - lb is a display/entry
 * convenience only, never a second stored value. */
export function kgToLb(kg) {
  return kg / KG_PER_LB;
}

/** lb -> kg, the inverse of kgToLb. */
export function lbToKg(lb) {
  return lb * KG_PER_LB;
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
 * `exerciseId` - the stable, cross-routine exercise-repository identity (see CLAUDE.md and
 * storage.js's resolveExerciseId) - so the same real-world exercise (e.g. "Bench Press") logged
 * from different routines combines into one PR/trend rather than being siloed per routine.
 * Falls back to the exercise's own name if `exerciseId` is somehow missing (shouldn't happen
 * post-migration, but keeps this from silently dropping an exercise's history if it ever is).
 * getWorkoutStats alone only ever looks at a single task. Backs the Fitness Stats screen: an
 * adaptive overview (only a weighted-PR tile if any weighted exercise exists, only a
 * bodyweight-PR tile if any bodyweight exercise exists), the calisthenics-vs-weightlifting mix,
 * and a per-exercise list where each entry already carries whichever metric actually fits its
 * type.
 */
export function getFitnessOverview(routines, workoutLogsByTask) {
  const workoutTasks = [];
  for (const routine of routines || []) {
    for (const task of routine.tasks || []) {
      if (task.completionType === 'workout') workoutTasks.push(task);
    }
  }

  const entriesById = new Map();
  for (const task of workoutTasks) {
    const logsForTask = workoutLogsByTask?.[task.id] || {};
    for (const exercise of task.exercises || []) {
      const name = exercise.name || 'Exercise';
      const key = exercise.exerciseId || name;
      const entry = entriesById.get(key) || { name, logs: [], seriesByDate: {} };
      entry.name = name; // keep the most-recently-seen spelling if it was ever renamed
      for (const [date, logsByExerciseId] of Object.entries(logsForTask)) {
        const sets = logsByExerciseId[exercise.id];
        if (!sets || sets.length === 0) continue;
        entry.logs.push(...sets);
        entry.seriesByDate[date] = (entry.seriesByDate[date] || []).concat(sets);
      }
      entriesById.set(key, entry);
    }
  }

  const exercises = Array.from(entriesById.values())
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
  const repExercises = exercises.filter((e) => !e.isWeighted && e.repPR);
  const durationExercises = exercises.filter((e) => !e.isWeighted && e.durationPR);

  const topWeightedPR = weightedExercises.reduce((best, e) => (!best || e.e1rm.e1rm > best.e1rm.e1rm ? e : best), null);
  const topRepPR = repExercises.reduce((best, e) => (!best || e.repPR.reps > best.repPR.reps ? e : best), null);
  const topDurationPR = durationExercises.reduce(
    (best, e) => (!best || e.durationPR.durationSeconds > best.durationPR.durationSeconds ? e : best),
    null
  );

  return {
    hasWorkouts: exercises.length > 0,
    exercises,
    sessionMix,
    topWeightedPR,
    topRepPR,
    topDurationPR,
  };
}
