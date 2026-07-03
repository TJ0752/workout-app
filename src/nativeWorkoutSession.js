import { Capacitor, registerPlugin } from '@capacitor/core';

const WorkoutSession = Capacitor.isNativePlatform() ? registerPlugin('WorkoutSession') : null;

export function isNativeWorkoutSessionAvailable() {
  return Capacitor.isNativePlatform();
}

/**
 * Launches the native Compose workout session screen. The returned promise only resolves once
 * the user closes the session (Capacitor's @ActivityCallback fires once, on Activity finish) -
 * per-set progress arrives separately via the workoutSetLogged listener below.
 */
export async function startNativeWorkoutSession(task, dateKey, logsForDate) {
  if (!WorkoutSession) return null;
  return WorkoutSession.start({
    taskId: task.id,
    taskTitle: task.title,
    dateKey,
    exercises: task.exercises || [],
    logsForDate,
  });
}

export function initWorkoutSetListener(onSetLogged) {
  if (!WorkoutSession) return null;
  return WorkoutSession.addListener('workoutSetLogged', (event) => {
    onSetLogged(event.taskId, event.dateKey, event.exercise, event.setIndex, event.values);
  });
}
