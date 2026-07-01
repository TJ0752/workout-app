import { Preferences } from '@capacitor/preferences';
import { getDb, persist } from './db';

const LEGACY_ROUTINES_KEY = 'routines';
const LEGACY_COMPLETIONS_KEY = 'completions';
const MIGRATION_MARKER_KEY = 'sqlite_migrated';

function rowToRoutine(row) {
  return {
    id: row.id,
    title: row.title,
    time: row.time,
    days: JSON.parse(row.days),
    notes: row.notes || '',
    active: Boolean(row.active),
    createdAt: row.created_at,
    icon: row.icon || null,
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
      await db.run(
        `INSERT OR REPLACE INTO routines (id, title, time, days, notes, active, created_at, icon)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.id,
          r.title,
          r.time,
          JSON.stringify(r.days),
          r.notes || '',
          r.active ? 1 : 0,
          r.createdAt,
          r.icon || null,
        ]
      );
    }
  }

  if (legacyCompletionsRaw) {
    const legacyCompletions = JSON.parse(legacyCompletionsRaw);
    for (const routineId of Object.keys(legacyCompletions)) {
      for (const date of Object.keys(legacyCompletions[routineId])) {
        await db.run('INSERT OR REPLACE INTO completions (routine_id, date) VALUES (?, ?)', [
          routineId,
          date,
        ]);
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

export async function getRoutines() {
  const db = await ready();
  const result = await db.query('SELECT * FROM routines ORDER BY created_at ASC');
  return (result.values || []).map(rowToRoutine);
}

export async function upsertRoutine(routine) {
  const db = await ready();
  await db.run(
    `INSERT INTO routines (id, title, time, days, notes, active, created_at, icon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       time = excluded.time,
       days = excluded.days,
       notes = excluded.notes,
       active = excluded.active,
       icon = excluded.icon`,
    [
      routine.id,
      routine.title,
      routine.time,
      JSON.stringify(routine.days),
      routine.notes || '',
      routine.active ? 1 : 0,
      routine.createdAt,
      routine.icon || null,
    ]
  );
  await persist();
  return getRoutines();
}

export async function deleteRoutine(id) {
  const db = await ready();
  await db.run('DELETE FROM routines WHERE id = ?', [id]);
  await db.run('DELETE FROM completions WHERE routine_id = ?', [id]);
  await persist();
  return getRoutines();
}

export async function getCompletions() {
  const db = await ready();
  const result = await db.query('SELECT routine_id, date FROM completions');
  const completions = {};
  for (const row of result.values || []) {
    if (!completions[row.routine_id]) completions[row.routine_id] = {};
    completions[row.routine_id][row.date] = true;
  }
  return completions;
}

export async function setCompletion(routineId, dateKey, done) {
  const db = await ready();
  if (done) {
    await db.run('INSERT OR REPLACE INTO completions (routine_id, date) VALUES (?, ?)', [
      routineId,
      dateKey,
    ]);
  } else {
    await db.run('DELETE FROM completions WHERE routine_id = ? AND date = ?', [routineId, dateKey]);
  }
  await persist();
  return getCompletions();
}
