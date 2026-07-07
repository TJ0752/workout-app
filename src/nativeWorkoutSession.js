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
 * `logsByDate` is the task's *full* logged history (every date, not just today) - needed for the
 * native getLastUsedWeight (see :shared's WorkoutLogic.kt) to look back through prior sessions
 * for its last-used-weight prefill/regression-warning, the same way the web companion's
 * WorkoutSessionView.jsx already does via its own `taskLogs` prop.
 */
export async function startNativeWorkoutSession(task, dateKey, logsForDate, logsByDate) {
  if (!WorkoutSession) return null;
  return WorkoutSession.start({
    taskId: task.id,
    taskTitle: task.title,
    dateKey,
    exercises: task.exercises || [],
    logsForDate,
    logsByDate,
  });
}

export function initWorkoutSetListener(onSetLogged) {
  if (!WorkoutSession) return null;
  return WorkoutSession.addListener('workoutSetLogged', (event) => {
    onSetLogged(event.taskId, event.dateKey, event.exercise, event.setIndex, event.values);
  });
}
