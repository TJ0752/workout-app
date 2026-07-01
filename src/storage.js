import { Preferences } from '@capacitor/preferences';

const ROUTINES_KEY = 'routines';
const COMPLETIONS_KEY = 'completions';

async function readJson(key, fallback) {
  const { value } = await Preferences.get({ key });
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function writeJson(key, value) {
  await Preferences.set({ key, value: JSON.stringify(value) });
}

export async function getRoutines() {
  return readJson(ROUTINES_KEY, []);
}

export async function saveRoutines(routines) {
  await writeJson(ROUTINES_KEY, routines);
  return routines;
}

export async function upsertRoutine(routine) {
  const routines = await getRoutines();
  const index = routines.findIndex((r) => r.id === routine.id);
  if (index === -1) {
    routines.push(routine);
  } else {
    routines[index] = routine;
  }
  await saveRoutines(routines);
  return routines;
}

export async function deleteRoutine(id) {
  const routines = await getRoutines();
  const next = routines.filter((r) => r.id !== id);
  await saveRoutines(next);
  return next;
}

export async function getCompletions() {
  return readJson(COMPLETIONS_KEY, {});
}

export async function setCompletion(routineId, dateKey, done) {
  const completions = await getCompletions();
  const routineDone = { ...(completions[routineId] || {}) };
  if (done) {
    routineDone[dateKey] = true;
  } else {
    delete routineDone[dateKey];
  }
  const next = { ...completions, [routineId]: routineDone };
  await writeJson(COMPLETIONS_KEY, next);
  return next;
}
