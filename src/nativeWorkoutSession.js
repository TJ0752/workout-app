import { Capacitor, registerPlugin } from '@capacitor/core';

const WorkoutSession = Capacitor.isNativePlatform() ? registerPlugin('WorkoutSession') : null;

export function isNativeWorkoutSessionAvailable() {
  return Capacitor.isNativePlatform();
}

/**
 * Launches the native Compose workout session screen. The returned promise only resolves once
 * the user closes the session (Capacitor's @ActivityCallback fires once, on Activity finish) -
 * per-set progress arrives separately via the workoutSetLogged listener below.
 *
 * `workoutLogSources` is buildWorkoutLogSources's flattened output (utils/workouts.js) - every
 * workout-type task across every routine, not just this one - needed for the native
 * getLastUsedWeight (see :shared's WorkoutLogic.kt) to search by exerciseId across routines the
 * same way the web companion's WorkoutSessionView.jsx already does via its own
 * `workoutLogSources` prop, so the same real-world exercise logged under a different routine
 * still prefills/warns against its true last-used weight.
 */
export async function startNativeWorkoutSession(task, dateKey, logsForDate, workoutLogSources) {
  if (!WorkoutSession) return null;
  return WorkoutSession.start({
    taskId: task.id,
    taskTitle: task.title,
    dateKey,
    exercises: task.exercises || [],
    logsForDate,
    workoutLogSources,
  });
}

export function initWorkoutSetListener(onSetLogged) {
  if (!WorkoutSession) return null;
  return WorkoutSession.addListener('workoutSetLogged', (event) => {
    onSetLogged(event.taskId, event.dateKey, event.exercise, event.setIndex, event.values);
  });
}
