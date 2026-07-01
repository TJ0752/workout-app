import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'routines';
const DB_VERSION = 3;

const sqlite = new SQLiteConnection(CapacitorSQLite);
let dbInstance = null;
let initPromise = null;

const MIGRATIONS = [
  {
    toVersion: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        time TEXT NOT NULL,
        days TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS completions (
        routine_id TEXT NOT NULL,
        date TEXT NOT NULL,
        PRIMARY KEY (routine_id, date)
      );`,
    ],
  },
  {
    toVersion: 2,
    statements: [`ALTER TABLE routines ADD COLUMN icon TEXT;`],
  },
  {
    // Splits the flat "routine = one completable thing" model into
    // Routine (container) -> Tasks (the actual schedulable/completable units),
    // and introduces versioning so edits don't rewrite history: every change
    // to a routine or task closes its current version row and inserts a new
    // one, so historical dashboards/streaks evaluate past dates against
    // whatever was in effect *then*. The version tables double as the audit
    // log the user asked for. Deletes are soft (a terminal version + a
    // `deleted` flag) so the audit log still has something to show.
    toVersion: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY NOT NULL,
        routine_id TEXT NOT NULL,
        title TEXT NOT NULL,
        time TEXT NOT NULL,
        days TEXT NOT NULL,
        completion_type TEXT NOT NULL DEFAULT 'boolean',
        target REAL,
        unit TEXT,
        quick_add TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS task_versions (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        routine_id TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        title TEXT NOT NULL,
        time TEXT NOT NULL,
        days TEXT NOT NULL,
        completion_type TEXT NOT NULL,
        target REAL,
        unit TEXT,
        quick_add TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        change_type TEXT NOT NULL,
        changed_fields TEXT NOT NULL DEFAULT '[]'
      );`,
      `CREATE TABLE IF NOT EXISTS routine_versions (
        id TEXT PRIMARY KEY NOT NULL,
        routine_id TEXT NOT NULL,
        effective_from TEXT NOT NULL,
        effective_to TEXT,
        title TEXT NOT NULL,
        icon TEXT,
        notes TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        default_days TEXT NOT NULL,
        change_type TEXT NOT NULL,
        changed_fields TEXT NOT NULL DEFAULT '[]'
      );`,
      // One synthetic task per existing routine, carrying over its time/days/active.
      `INSERT INTO tasks (id, routine_id, title, time, days, completion_type, target, unit, quick_add, active, deleted, created_at)
       SELECT id || '-task', id, title, time, days, 'boolean', NULL, NULL, NULL, active, 0, created_at
       FROM routines;`,
      `INSERT INTO task_versions (id, task_id, routine_id, effective_from, effective_to, title, time, days, completion_type, target, unit, quick_add, active, change_type, changed_fields)
       SELECT id || '-task-v1', id || '-task', id, created_at, NULL, title, time, days, 'boolean', NULL, NULL, NULL, active, 'migrated', '[]'
       FROM routines;`,
      `INSERT INTO routine_versions (id, routine_id, effective_from, effective_to, title, icon, notes, active, default_days, change_type, changed_fields)
       SELECT id || '-v1', id, created_at, NULL, title, icon, notes, active, days, 'migrated', '[]'
       FROM routines;`,
      // Completions move from (routine_id, date) to (task_id, date, value).
      `CREATE TABLE IF NOT EXISTS completions_v2 (
        task_id TEXT NOT NULL,
        date TEXT NOT NULL,
        value REAL,
        updated_at TEXT,
        PRIMARY KEY (task_id, date)
      );`,
      `INSERT INTO completions_v2 (task_id, date, value, updated_at)
       SELECT routine_id || '-task', date, 1, NULL
       FROM completions;`,
      `DROP TABLE completions;`,
      `ALTER TABLE completions_v2 RENAME TO completions;`,
      // Rebuild routines without time/days (now task-level) and with the new
      // deleted/default_days columns - SQLite can't drop columns cleanly
      // pre-3.35, so rebuild-and-swap is the portable approach.
      `CREATE TABLE routines_new (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        icon TEXT,
        notes TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        default_days TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`,
      `INSERT INTO routines_new (id, title, icon, notes, active, deleted, default_days, created_at)
       SELECT id, title, icon, notes, active, 0, days, created_at
       FROM routines;`,
      `DROP TABLE routines;`,
      `ALTER TABLE routines_new RENAME TO routines;`,
    ],
  },
];

async function openDatabase() {
  const isWeb = Capacitor.getPlatform() === 'web';
  if (isWeb) {
    await sqlite.initWebStore();
  }

  await sqlite.addUpgradeStatement(DB_NAME, MIGRATIONS);

  const alreadyOpen = (await sqlite.isConnection(DB_NAME, false)).result;
  const db = alreadyOpen
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);

  await db.open();
  return db;
}

export async function getDb() {
  if (!initPromise) {
    initPromise = openDatabase().then((db) => {
      dbInstance = db;
      return db;
    });
  }
  return initPromise;
}

export async function persist() {
  if (Capacitor.getPlatform() === 'web') {
    await sqlite.saveToStore(DB_NAME);
  }
}

export function getOpenDb() {
  return dbInstance;
}
