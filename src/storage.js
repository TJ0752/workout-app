import { Preferences } from '@capacitor/preferences';
import { getDb, persist } from './db';
import { generateId } from './utils/id';

const LEGACY_ROUTINES_KEY = 'routines';
const LEGACY_COMPLETIONS_KEY = 'completions';
const MIGRATION_MARKER_KEY = 'sqlite_migrated';
const EXERCISE_BACKFILL_MARKER_KEY = 'exercise_repository_backfilled';

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
    quantityMode: row.quantity_mode || 'number',
    autoUpdateTarget: Boolean(row.auto_update_target),
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
    archived: Boolean(row.archived_at),
    archivedAt: row.archived_at || null,
    startDate: row.start_date || null,
    endDate: row.end_date || null,
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
       (id, routine_id, effective_from, effective_to, title, icon, notes, active, archived_at, start_date, end_date, default_days, change_type, changed_fields)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId(),
      routineId,
      effectiveFrom,
      fields.title,
      fields.icon,
      fields.notes,
      fields.active,
      fields.archived_at ?? null,
      fields.start_date ?? null,
      fields.end_date ?? null,
      fields.default_days,
      changeType,
      JSON.stringify(changedFields),
    ]
  );
}

async function insertTaskVersion(db, taskId, routineId, fields, effectiveFrom, changeType, changedFields) {
  await db.run(
    `INSERT INTO task_versions
       (id, task_id, routine_id, effective_from, effective_to, title, time, window_start, reminder_times, days, completion_type, target, unit, quick_add, quantity_mode, auto_update_target, exercises, active, change_type, changed_fields)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      fields.quantity_mode,
      fields.auto_update_target,
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
    start_date: routine.startDate || null,
    end_date: routine.endDate || null,
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
    quantity_mode: isQuantity ? task.quantityMode || 'number' : 'number',
    auto_update_target: isQuantity && task.autoUpdateTarget ? 1 : 0,
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
        start_date: null,
        end_date: null,
        default_days: JSON.stringify(r.days || []),
      };
      await db.run(
        `INSERT OR REPLACE INTO routines (id, title, icon, notes, active, deleted, start_date, end_date, default_days, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          r.id,
          routineFields.title,
          routineFields.icon,
          routineFields.notes,
          routineFields.active,
          routineFields.start_date,
          routineFields.end_date,
          routineFields.default_days,
          r.createdAt,
        ]
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
        quantity_mode: 'number',
        auto_update_target: 0,
        exercises: '[]',
        active: r.active ? 1 : 0,
      };
      await db.run(
        `INSERT OR REPLACE INTO tasks (id, routine_id, title, time, window_start, reminder_times, days, completion_type, target, unit, quick_add, quantity_mode, auto_update_target, exercises, active, deleted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          taskId,
          r.id,
          taskFields.title,
          taskFields.time,
          taskFields.window_start,
          taskFields.reminder_times,
          taskFields.days,
          taskFields.completion_type,
          taskFields.target,
          taskFields.unit,
          taskFields.quick_add,
          taskFields.quantity_mode,
          taskFields.auto_update_target,
          taskFields.exercises,
          taskFields.active,
          r.createdAt,
        ]
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

/**
 * Looks up an exercise repository row by case-insensitive name, creating one if it doesn't
 * exist yet - this is the single choke point that gives a real-world exercise ("Bench Press") a
 * stable identity shared across every routine/task it's added to, instead of the per-task-instance
 * `exercises[].id` that gets regenerated fresh every time. Called both from upsertTask (for a
 * newly typed exercise name with no exerciseId yet) and the one-time backfill below (for
 * exercises that existed before this table did).
 */
async function resolveExerciseId(db, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const rows = await db.query('SELECT id FROM exercises WHERE name = ? COLLATE NOCASE', [trimmed]);
  const existing = (rows.values || [])[0];
  if (existing) return existing.id;
  const id = generateId();
  await db.run('INSERT INTO exercises (id, name, created_at) VALUES (?, ?, ?)', [
    id,
    trimmed,
    new Date().toISOString(),
  ]);
  return id;
}

/**
 * Resolves (or creates) an exerciseId for every exercise in a workout task that doesn't already
 * have one - picking one from the autosuggest list already carries its id, typing a brand-new
 * name doesn't yet. Sequential (not `Promise.all`) on purpose: a real bug found via a two-exercise
 * routine failing to save ("cannot start a transaction within a transaction") - the web SQLite
 * backend's `db.query`/`db.run` calls aren't safe to run concurrently on the same connection, and
 * `Promise.all` over an async map issues exactly that (two brand-new exercise names both hitting
 * the insert path at once). A `for` loop keeps each resolution's query+insert pair fully
 * finished before the next exercise's begins.
 */
async function resolveExerciseIds(db, exercises) {
  const resolved = [];
  for (const ex of exercises) {
    resolved.push({ ...ex, exerciseId: ex.exerciseId || (await resolveExerciseId(db, ex.name)) });
  }
  return resolved;
}

/**
 * One-time backfill for installs that already had workout tasks before the exercises table
 * existed - without this, `getFitnessOverview`'s switch from name-matching to exerciseId-matching
 * would silently orphan every exercise saved before this migration (no exerciseId means no
 * matching group) until the task happened to be edited again. Rewrites each task's *live*
 * `exercises` JSON with the resolved id - safe to mutate in place because `tasks` is current
 * state, not the append-only `task_versions` audit log (see CLAUDE.md's versioning section);
 * historical versions are never rewritten.
 */
async function backfillExerciseRepositoryOnce(db) {
  const { value: marker } = await Preferences.get({ key: EXERCISE_BACKFILL_MARKER_KEY });
  if (marker) return;

  const taskRows = await db.query("SELECT id, exercises FROM tasks WHERE completion_type = 'workout'");
  for (const row of taskRows.values || []) {
    let exercises;
    try {
      exercises = JSON.parse(row.exercises || '[]');
    } catch {
      exercises = [];
    }
    if (exercises.length === 0) continue;

    let changed = false;
    for (const ex of exercises) {
      if (ex.exerciseId || !ex.name?.trim()) continue;
      ex.exerciseId = await resolveExerciseId(db, ex.name);
      changed = true;
    }
    if (changed) {
      await db.run('UPDATE tasks SET exercises = ? WHERE id = ?', [JSON.stringify(exercises), row.id]);
    }
  }

  await persist();
  await Preferences.set({ key: EXERCISE_BACKFILL_MARKER_KEY, value: 'true' });
}

let readyPromise = null;
async function ready() {
  if (!readyPromise) {
    readyPromise = getDb().then(async (db) => {
      await migrateFromPreferencesOnce(db);
      await backfillExerciseRepositoryOnce(db);
      return db;
    });
  }
  return readyPromise;
}

/** Every exercise ever named, for the RoutineForm exercise editor's autosuggest. */
export async function getExerciseNames() {
  const db = await ready();
  const result = await db.query('SELECT id, name FROM exercises ORDER BY name COLLATE NOCASE ASC');
  return result.values || [];
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
      `INSERT INTO routines (id, title, icon, notes, active, deleted, start_date, end_date, default_days, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        routine.id,
        fields.title,
        fields.icon,
        fields.notes,
        fields.active,
        fields.start_date,
        fields.end_date,
        fields.default_days,
        routine.createdAt || now,
      ]
    );
    await insertRoutineVersion(db, routine.id, fields, now, 'created', []);
  } else {
    const changed = diffRowFields(existing, fields);
    if (changed.length > 0) {
      await db.run(
        `UPDATE routines SET title=?, icon=?, notes=?, active=?, start_date=?, end_date=?, default_days=? WHERE id=?`,
        [
          fields.title,
          fields.icon,
          fields.notes,
          fields.active,
          fields.start_date,
          fields.end_date,
          fields.default_days,
          routine.id,
        ]
      );
      const changeType =
        changed.length === 1 && changed[0] === 'active' ? (fields.active ? 'resumed' : 'paused') : 'updated';
      await closeCurrentVersion(db, 'routine_versions', 'routine_id', routine.id, now);
      await insertRoutineVersion(db, routine.id, fields, now, changeType, changed);
    }
  }
  await persist();
  return getRoutines();
}

/**
 * Archives a routine: hides it from Today/Routines/notifications going forward, without
 * touching a single row of its tasks/versions/completions - the whole point is that its history
 * stays exactly as complete as an un-archived routine's. `archived_at` is a timestamp, not a
 * flag, so getRoutineFraction (utils/date.js) can treat it as a one-time cutover: every day
 * before this moment still computes normally, only this moment and afterward becomes "nothing
 * due" - see the migration comment in db.js for the full rationale.
 */
export async function archiveRoutine(routineId) {
  const db = await ready();
  const now = new Date().toISOString();
  const rows = await db.query('SELECT * FROM routines WHERE id = ?', [routineId]);
  const routine = (rows.values || [])[0];
  if (routine) {
    await db.run('UPDATE routines SET archived_at = ? WHERE id = ?', [now, routineId]);
    await closeCurrentVersion(db, 'routine_versions', 'routine_id', routineId, now);
    await insertRoutineVersion(db, routineId, { ...routine, archived_at: now }, now, 'archived', ['archived_at']);
  }
  await persist();
  return getRoutines();
}

/** Undoes archiveRoutine - the routine and every day of its history return exactly as they were. */
export async function restoreRoutine(routineId) {
  const db = await ready();
  const now = new Date().toISOString();
  const rows = await db.query('SELECT * FROM routines WHERE id = ?', [routineId]);
  const routine = (rows.values || [])[0];
  if (routine) {
    await db.run('UPDATE routines SET archived_at = NULL WHERE id = ?', [routineId]);
    await closeCurrentVersion(db, 'routine_versions', 'routine_id', routineId, now);
    await insertRoutineVersion(db, routineId, { ...routine, archived_at: null }, now, 'restored', ['archived_at']);
  }
  await persist();
  return getRoutines();
}

/**
 * A genuine, irreversible hard delete - the one place in this codebase that actually erases
 * rows instead of soft-deleting/versioning them (see CLAUDE.md's append-only versioning
 * philosophy). Only ever allowed for an already-archived routine, enforced here rather than
 * just in the UI, since "permanently delete" is a real data-loss action a stray call anywhere
 * else must not be able to trigger. Sequential per-task loop, not Promise.all, matching
 * resolveExerciseIds' documented reason: the web SQLite backend's db.query/db.run aren't safe
 * to run concurrently on one connection.
 */
export async function permanentlyDeleteRoutine(routineId) {
  const db = await ready();
  const routineRows = await db.query('SELECT archived_at FROM routines WHERE id = ?', [routineId]);
  const routine = (routineRows.values || [])[0];
  if (!routine || !routine.archived_at) return getRoutines();

  const taskRows = await db.query('SELECT id FROM tasks WHERE routine_id = ?', [routineId]);
  for (const task of taskRows.values || []) {
    await db.run('DELETE FROM completions WHERE task_id = ?', [task.id]);
    await db.run('DELETE FROM workout_logs WHERE task_id = ?', [task.id]);
    await db.run('DELETE FROM task_versions WHERE task_id = ?', [task.id]);
    await db.run('DELETE FROM task_reschedules WHERE task_id = ?', [task.id]);
  }
  await db.run('DELETE FROM tasks WHERE routine_id = ?', [routineId]);
  await db.run('DELETE FROM routine_versions WHERE routine_id = ?', [routineId]);
  await db.run('DELETE FROM routines WHERE id = ?', [routineId]);

  await persist();
  return getRoutines();
}

export async function upsertTask(task) {
  const db = await ready();
  const now = new Date().toISOString();
  const resolvedTask =
    task.completionType === 'workout'
      ? { ...task, exercises: await resolveExerciseIds(db, task.exercises || []) }
      : task;
  const fields = taskFieldsOf(resolvedTask);

  const existingRows = await db.query('SELECT * FROM tasks WHERE id = ?', [task.id]);
  const existing = (existingRows.values || [])[0];

  if (!existing) {
    await db.run(
      `INSERT INTO tasks (id, routine_id, title, time, window_start, reminder_times, days, completion_type, target, unit, quick_add, quantity_mode, auto_update_target, exercises, active, deleted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
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
        fields.quantity_mode,
        fields.auto_update_target,
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
        `UPDATE tasks SET title=?, time=?, window_start=?, reminder_times=?, days=?, completion_type=?, target=?, unit=?, quick_add=?, quantity_mode=?, auto_update_target=?, exercises=?, active=? WHERE id=?`,
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
          fields.quantity_mode,
          fields.auto_update_target,
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

/**
 * A one-time, per-occurrence override of a task's due day - unversioned on purpose, since it's a
 * single-instance move, not a change to the recurring schedule task.days describes. Upserted per
 * (task_id, original_date) via the table's own unique index, so rescheduling the same original
 * date a second time replaces the previous move instead of stacking a second one. originalDate
 * stops counting as due (treated as nothing-scheduled, not a miss); newDate becomes due in its
 * place, even if it falls outside task.days for that week.
 */
export async function setTaskReschedule(taskId, originalDate, newDate) {
  const db = await ready();
  await db.run(
    `INSERT OR REPLACE INTO task_reschedules (id, task_id, original_date, new_date, created_at) VALUES (?, ?, ?, ?, ?)`,
    [generateId(), taskId, originalDate, newDate, new Date().toISOString()]
  );
  await persist();
  return getTaskReschedulesForAnalytics();
}

/** Undoes a reschedule, reverting originalDate back to its normal due status. */
export async function clearTaskReschedule(taskId, originalDate) {
  const db = await ready();
  await db.run('DELETE FROM task_reschedules WHERE task_id = ? AND original_date = ?', [taskId, originalDate]);
  await persist();
  return getTaskReschedulesForAnalytics();
}

/** Every reschedule, task id -> [{originalDate, newDate}] - loaded once per app-level refresh and
 * threaded through the analytics layer alongside taskVersionsMap, the same "load once, pass down"
 * pattern already used everywhere else "was this due on day X" needs data beyond the live task row. */
export async function getTaskReschedulesForAnalytics() {
  const db = await ready();
  const result = await db.query('SELECT task_id, original_date, new_date FROM task_reschedules ORDER BY original_date ASC');
  const map = {};
  for (const row of result.values || []) {
    if (!map[row.task_id]) map[row.task_id] = [];
    map[row.task_id].push({ originalDate: row.original_date, newDate: row.new_date });
  }
  return map;
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
