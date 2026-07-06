import { Preferences } from '@capacitor/preferences';
import { getDb, persist } from './db';
import { generateId } from './utils/id';

const LEGACY_ROUTINES_KEY = 'routines';
const LEGACY_COMPLETIONS_KEY = 'completions';
const MIGRATION_MARKER_KEY = 'sqlite_migrated';

function rowToTask(row) {
  return {
    id: row.id,
    routineId: row.routine_id,
    title: row.title,
    time: row.time,
    windowStart: row.window_start || '00:00',
    reminderTimes: row.reminder_times ? JSON.parse(row.reminder_times) : [],
    days: JSON.parse(row.days),
    completionType: row.completion_type,
    target: row.target,
    unit: row.unit,
    quickAdd: row.quick_add ? JSON.parse(row.quick_add) : null,
    exercises: row.exercises ? JSON.parse(row.exercises) : [],
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

function rowToRoutine(row, tasks) {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon || null,
    notes: row.notes || '',
    active: Boolean(row.active),
    defaultDays: JSON.parse(row.default_days),
    createdAt: row.created_at,
    tasks: tasks || [],
  };
}

function diffRowFields(existingRow, newFields) {
  return Object.keys(newFields).filter(
    (k) => String(existingRow[k] ?? '') !== String(newFields[k] ?? '')
  );
}

async function closeCurrentVersion(db, table, idCol, id, now) {
  await db.run(`UPDATE ${table} SET effective_to = ? WHERE ${idCol} = ? AND effective_to IS NULL`, [
    now,
    id,
  ]);
}

async function insertRoutineVersion(db, routineId, fields, effectiveFrom, changeType, changedFields) {
  await db.run(
    `INSERT INTO routine_versions
       (id, routine_id, effective_from, effective_to, title, icon, notes, active, default_days, change_type, changed_fields)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId(),
      routineId,
      effectiveFrom,
      fields.title,
      fields.icon,
      fields.notes,
      fields.active,
      fields.default_days,
      changeType,
      JSON.stringify(changedFields),
    ]
  );
}

async function insertTaskVersion(db, taskId, routineId, fields, effectiveFrom, changeType, changedFields) {
  await db.run(
    `INSERT INTO task_versions
       (id, task_id, routine_id, effective_from, effective_to, title, time, window_start, reminder_times, days, completion_type, target, unit, quick_add, exercises, active, change_type, changed_fields)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId(),
      taskId,
      routineId,
      effectiveFrom,
      fields.title,
      fields.time,
      fields.window_start,
      fields.reminder_times,
      fields.days,
      fields.completion_type,
      fields.target,
      fields.unit,
      fields.quick_add,
      fields.exercises,
      fields.active,
      changeType,
      JSON.stringify(changedFields),
    ]
  );
}

function routineFieldsOf(routine) {
  return {
    title: routine.title,
    icon: routine.icon || null,
    notes: routine.notes || '',
    active: routine.active ? 1 : 0,
    default_days: JSON.stringify(routine.defaultDays || []),
  };
}

function taskFieldsOf(task) {
  const isQuantity = task.completionType === 'quantity';
  const isWorkout = task.completionType === 'workout';
  return {
    title: task.title,
    time: task.time,
    window_start: task.windowStart || '00:00',
    reminder_times: JSON.stringify(task.reminderTimes?.length ? task.reminderTimes : []),
    days: JSON.stringify(task.days || []),
    completion_type: task.completionType || 'boolean',
    target: isQuantity ? task.target ?? null : null,
    unit: isQuantity ? task.unit || null : null,
    quick_add: isQuantity && task.quickAdd?.length ? JSON.stringify(task.quickAdd) : null,
    exercises: JSON.stringify(isWorkout ? task.exercises || [] : []),
    active: task.active ? 1 : 0,
  };
}

async function migrateFromPreferencesOnce(db) {
  const { value: marker } = await Preferences.get({ key: MIGRATION_MARKER_KEY });
  if (marker) return;

  const [{ value: legacyRoutinesRaw }, { value: legacyCompletionsRaw }] = await Promise.all([
    Preferences.get({ key: LEGACY_ROUTINES_KEY }),
    Preferences.get({ key: LEGACY_COMPLETIONS_KEY }),
  ]);

  if (legacyRoutinesRaw) {
    for (const r of JSON.parse(legacyRoutinesRaw)) {
      const routineFields = {
        title: r.title,
        icon: r.icon || null,
        notes: r.notes || '',
        active: r.active ? 1 : 0,
        default_days: JSON.stringify(r.days || []),
      };
      await db.run(
        `INSERT OR REPLACE INTO routines (id, title, icon, notes, active, deleted, default_days, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [r.id, routineFields.title, routineFields.icon, routineFields.notes, routineFields.active, routineFields.default_days, r.createdAt]
      );
      await insertRoutineVersion(db, r.id, routineFields, r.createdAt, 'migrated', []);

      const taskId = `${r.id}-task`;
      const taskFields = {
        title: r.title,
        time: r.time,
        window_start: '00:00',
        reminder_times: '[]',
        days: JSON.stringify(r.days || []),
        completion_type: 'boolean',
        target: null,
        unit: null,
        quick_add: null,
        exercises: '[]',
        active: r.active ? 1 : 0,
      };
      await db.run(
        `INSERT OR REPLACE INTO tasks (id, routine_id, title, time, window_start, reminder_times, days, completion_type, target, unit, quick_add, exercises, active, deleted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [taskId, r.id, taskFields.title, taskFields.time, taskFields.window_start, taskFields.reminder_times, taskFields.days, taskFields.completion_type, taskFields.target, taskFields.unit, taskFields.quick_add, taskFields.exercises, taskFields.active, r.createdAt]
      );
      await insertTaskVersion(db, taskId, r.id, taskFields, r.createdAt, 'migrated', []);

      const legacyCompletions = legacyCompletionsRaw ? JSON.parse(legacyCompletionsRaw)[r.id] : null;
      if (legacyCompletions) {
        for (const date of Object.keys(legacyCompletions)) {
          await db.run('INSERT OR REPLACE INTO completions (task_id, date, value) VALUES (?, ?, 1)', [
            taskId,
            date,
          ]);
        }
      }
    }
  }

  await persist();
  await Preferences.set({ key: MIGRATION_MARKER_KEY, value: 'true' });
}

let readyPromise = null;
async function ready() {
  if (!readyPromise) {
    readyPromise = getDb().then(async (db) => {
      await migrateFromPreferencesOnce(db);
      return db;
    });
  }
  return readyPromise;
}

/**
 * Called once a backup restore (see backup.js's importBackup) has swapped the underlying
 * database out from under this module - without this, `ready()` would keep handing out its
 * already-resolved promise for the pre-restore connection (db.js's own import already closed
 * and nulled that connection, so reusing it here would query a dead handle). The next call to
 * any storage.js function re-derives a fresh connection via getDb() and skips
 * migrateFromPreferencesOnce again since the restored DB is never a pre-SQLite install.
 */
export function invalidateDbCache() {
  readyPromise = null;
}

export async function getRoutines() {
  const db = await ready();
  const [routineRows, taskRows] = await Promise.all([
    db.query('SELECT * FROM routines WHERE deleted = 0 ORDER BY created_at ASC'),
    db.query('SELECT * FROM tasks WHERE deleted = 0 ORDER BY created_at ASC'),
  ]);

  const tasksByRoutine = {};
  for (const row of taskRows.values || []) {
    if (!tasksByRoutine[row.routine_id]) tasksByRoutine[row.routine_id] = [];
    tasksByRoutine[row.routine_id].push(rowToTask(row));
  }

  return (routineRows.values || []).map((row) => rowToRoutine(row, tasksByRoutine[row.id]));
}

export async function upsertRoutine(routine) {
  const db = await ready();
  const now = new Date().toISOString();
  const fields = routineFieldsOf(routine);

  const existingRows = await db.query('SELECT * FROM routines WHERE id = ?', [routine.id]);
  const existing = (existingRows.values || [])[0];

  if (!existing) {
    await db.run(
      `INSERT INTO routines (id, title, icon, notes, active, deleted, default_days, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [routine.id, fields.title, fields.icon, fields.notes, fields.active, fields.default_days, routine.createdAt || now]
    );
    await insertRoutineVersion(db, routine.id, fields, now, 'created', []);
  } else {
    const changed = diffRowFields(existing, fields);
    if (changed.length > 0) {
      await db.run(`UPDATE routines SET title=?, icon=?, notes=?, active=?, default_days=? WHERE id=?`, [
        fields.title,
        fields.icon,
        fields.notes,
        fields.active,
        fields.default_days,
        routine.id,
      ]);
      const changeType =
        changed.length === 1 && changed[0] === 'active' ? (fields.active ? 'resumed' : 'paused') : 'updated';
      await closeCurrentVersion(db, 'routine_versions', 'routine_id', routine.id, now);
      await insertRoutineVersion(db, routine.id, fields, now, changeType, changed);
    }
  }
  await persist();
  return getRoutines();
}

export async function deleteRoutine(routineId) {
  const db = await ready();
  const now = new Date().toISOString();

  const routineRows = await db.query('SELECT * FROM routines WHERE id = ?', [routineId]);
  const routine = (routineRows.values || [])[0];
  if (routine) {
    await db.run('UPDATE routines SET deleted = 1, active = 0 WHERE id = ?', [routineId]);
    await closeCurrentVersion(db, 'routine_versions', 'routine_id', routineId, now);
    await insertRoutineVersion(db, routineId, { ...routine, active: 0 }, now, 'deleted', ['deleted']);
  }

  const taskRows = await db.query('SELECT * FROM tasks WHERE routine_id = ? AND deleted = 0', [routineId]);
  for (const task of taskRows.values || []) {
    await db.run('UPDATE tasks SET deleted = 1, active = 0 WHERE id = ?', [task.id]);
    await closeCurrentVersion(db, 'task_versions', 'task_id', task.id, now);
    await insertTaskVersion(db, task.id, routineId, { ...task, active: 0 }, now, 'deleted', ['deleted']);
  }

  await persist();
  return getRoutines();
}

export async function upsertTask(task) {
  const db = await ready();
  const now = new Date().toISOString();
  const fields = taskFieldsOf(task);

  const existingRows = await db.query('SELECT * FROM tasks WHERE id = ?', [task.id]);
  const existing = (existingRows.values || [])[0];

  if (!existing) {
    await db.run(
      `INSERT INTO tasks (id, routine_id, title, time, window_start, reminder_times, days, completion_type, target, unit, quick_add, exercises, active, deleted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        task.id,
        task.routineId,
        fields.title,
        fields.time,
        fields.window_start,
        fields.reminder_times,
        fields.days,
        fields.completion_type,
        fields.target,
        fields.unit,
        fields.quick_add,
        fields.exercises,
        fields.active,
        task.createdAt || now,
      ]
    );
    await insertTaskVersion(db, task.id, task.routineId, fields, now, 'created', []);
  } else {
    const changed = diffRowFields(existing, fields);
    if (changed.length > 0) {
      await db.run(
        `UPDATE tasks SET title=?, time=?, window_start=?, reminder_times=?, days=?, completion_type=?, target=?, unit=?, quick_add=?, exercises=?, active=? WHERE id=?`,
        [
          fields.title,
          fields.time,
          fields.window_start,
          fields.reminder_times,
          fields.days,
          fields.completion_type,
          fields.target,
          fields.unit,
          fields.quick_add,
          fields.exercises,
          fields.active,
          task.id,
        ]
      );
      const changeType =
        changed.length === 1 && changed[0] === 'active' ? (fields.active ? 'resumed' : 'paused') : 'updated';
      await closeCurrentVersion(db, 'task_versions', 'task_id', task.id, now);
      await insertTaskVersion(db, task.id, task.routineId, fields, now, changeType, changed);
    }
  }
  await persist();
  return getRoutines();
}

export async function deleteTask(taskId) {
  const db = await ready();
  const now = new Date().toISOString();
  const rows = await db.query('SELECT * FROM tasks WHERE id = ?', [taskId]);
  const task = (rows.values || [])[0];
  if (!task) return getRoutines();

  await db.run('UPDATE tasks SET deleted = 1, active = 0 WHERE id = ?', [taskId]);
  await closeCurrentVersion(db, 'task_versions', 'task_id', taskId, now);
  await insertTaskVersion(db, taskId, task.routine_id, { ...task, active: 0 }, now, 'deleted', ['deleted']);

  await persist();
  return getRoutines();
}

export async function getCompletions() {
  const db = await ready();
  const result = await db.query('SELECT task_id, date, value FROM completions');
  const completions = {};
  for (const row of result.values || []) {
    if (!completions[row.task_id]) completions[row.task_id] = {};
    completions[row.task_id][row.date] = row.value;
  }
  return completions;
}

export async function setCompletion(taskId, dateKey, value) {
  const db = await ready();
  const now = new Date().toISOString();
  if (value === null || value === undefined || value === false || value === 0) {
    await db.run('DELETE FROM completions WHERE task_id = ? AND date = ?', [taskId, dateKey]);
  } else {
    const numericValue = value === true ? 1 : value;
    await db.run('INSERT OR REPLACE INTO completions (task_id, date, value, updated_at) VALUES (?, ?, ?, ?)', [
      taskId,
      dateKey,
      numericValue,
      now,
    ]);
  }
  await persist();
  return getCompletions();
}

export async function addToCompletion(taskId, dateKey, delta) {
  const completions = await getCompletions();
  const current = completions[taskId]?.[dateKey] || 0;
  return setCompletion(taskId, dateKey, current + delta);
}

export async function getAllVersions() {
  const db = await ready();
  const [routineVersions, taskVersions] = await Promise.all([
    db.query('SELECT * FROM routine_versions ORDER BY effective_from DESC'),
    db.query('SELECT * FROM task_versions ORDER BY effective_from DESC'),
  ]);

  const routineEntries = (routineVersions.values || []).map((v) => ({
    id: v.id,
    kind: 'routine',
    entityId: v.routine_id,
    routineId: v.routine_id,
    effectiveFrom: v.effective_from,
    effectiveTo: v.effective_to,
    changeType: v.change_type,
    changedFields: JSON.parse(v.changed_fields || '[]'),
    title: v.title,
  }));

  const taskEntries = (taskVersions.values || []).map((v) => ({
    id: v.id,
    kind: 'task',
    entityId: v.task_id,
    routineId: v.routine_id,
    effectiveFrom: v.effective_from,
    effectiveTo: v.effective_to,
    changeType: v.change_type,
    changedFields: JSON.parse(v.changed_fields || '[]'),
    title: v.title,
  }));

  return [...routineEntries, ...taskEntries].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
}

export async function getRoutineHistory(routineId) {
  const all = await getAllVersions();
  return all.filter((v) => v.routineId === routineId);
}

export async function getTaskVersionsForAnalytics() {
  const db = await ready();
  const result = await db.query(
    `SELECT tv.* FROM task_versions tv
     JOIN tasks t ON t.id = tv.task_id
     WHERE t.deleted = 0
     ORDER BY tv.task_id, tv.effective_from ASC`
  );
  const map = {};
  for (const row of result.values || []) {
    if (!map[row.task_id]) map[row.task_id] = [];
    map[row.task_id].push({
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      title: row.title,
      time: row.time,
      days: JSON.parse(row.days),
      completionType: row.completion_type,
      target: row.target,
      unit: row.unit,
      exercises: row.exercises ? JSON.parse(row.exercises) : [],
      active: Boolean(row.active),
    });
  }
  return map;
}

export async function logWorkoutSet(taskId, dateKey, exercise, setIndex, values) {
  const db = await ready();
  const now = new Date().toISOString();
  const { reps = null, weight = null, durationSeconds = null, completed = true } = values;

  const existingRows = await db.query(
    'SELECT id FROM workout_logs WHERE task_id = ? AND date = ? AND exercise_id = ? AND set_index = ?',
    [taskId, dateKey, exercise.id, setIndex]
  );
  const existing = (existingRows.values || [])[0];

  if (existing) {
    await db.run(
      `UPDATE workout_logs SET reps=?, weight=?, duration_seconds=?, completed=?, updated_at=?, exercise_name=? WHERE id=?`,
      [reps, weight, durationSeconds, completed ? 1 : 0, now, exercise.name, existing.id]
    );
  } else {
    await db.run(
      `INSERT INTO workout_logs (id, task_id, date, exercise_id, exercise_name, set_index, reps, weight, duration_seconds, completed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [generateId(), taskId, dateKey, exercise.id, exercise.name, setIndex, reps, weight, durationSeconds, completed ? 1 : 0, now]
    );
  }

  await persist();
  return getAllWorkoutLogs();
}

export async function getAllWorkoutLogs() {
  const db = await ready();
  const result = await db.query(
    'SELECT * FROM workout_logs ORDER BY task_id, date, exercise_id, set_index ASC'
  );
  const byTask = {};
  for (const row of result.values || []) {
    if (!byTask[row.task_id]) byTask[row.task_id] = {};
    if (!byTask[row.task_id][row.date]) byTask[row.task_id][row.date] = {};
    if (!byTask[row.task_id][row.date][row.exercise_id]) byTask[row.task_id][row.date][row.exercise_id] = [];
    byTask[row.task_id][row.date][row.exercise_id].push({
      setIndex: row.set_index,
      reps: row.reps,
      weight: row.weight,
      durationSeconds: row.duration_seconds,
      completed: Boolean(row.completed),
      exerciseName: row.exercise_name,
      updatedAt: row.updated_at,
    });
  }
  return byTask;
}
