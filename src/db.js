import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'routines';
const DB_VERSION = 10;

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
  {
    // `time` stays the task's due-by moment. `window_start` marks when it
    // becomes "current" (default midnight, i.e. no change from before), and
    // `reminder_times` holds extra hardcoded nudge times in addition to the
    // due-by reminder - see notifications.js for how these get scheduled.
    toVersion: 4,
    statements: [
      `ALTER TABLE tasks ADD COLUMN window_start TEXT NOT NULL DEFAULT '00:00';`,
      `ALTER TABLE tasks ADD COLUMN reminder_times TEXT NOT NULL DEFAULT '[]';`,
      `ALTER TABLE task_versions ADD COLUMN window_start TEXT NOT NULL DEFAULT '00:00';`,
      `ALTER TABLE task_versions ADD COLUMN reminder_times TEXT NOT NULL DEFAULT '[]';`,
    ],
  },
  {
    // Adds a third completionType, 'workout' - a task made of exercises
    // (sets/reps/weight or duration targets), versioned exactly like
    // quick_add/reminder_times so editing a workout's exercises produces a
    // new task_versions snapshot. completions.value still holds a single
    // 0-1 fraction (sets logged / sets planned) so the existing
    // fraction-based analytics pipeline needs no schema changes - the
    // per-set actual performance (reps/weight actually done) lives in the
    // new workout_logs table instead, keyed by a stable exercise id that
    // survives template edits/renames.
    toVersion: 5,
    statements: [
      `ALTER TABLE tasks ADD COLUMN exercises TEXT NOT NULL DEFAULT '[]';`,
      `ALTER TABLE task_versions ADD COLUMN exercises TEXT NOT NULL DEFAULT '[]';`,
      `CREATE TABLE IF NOT EXISTS workout_logs (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        date TEXT NOT NULL,
        exercise_id TEXT NOT NULL,
        exercise_name TEXT NOT NULL,
        set_index INTEGER NOT NULL,
        reps INTEGER,
        weight REAL,
        duration_seconds INTEGER,
        completed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workout_logs_natural_key
        ON workout_logs(task_id, date, exercise_id, set_index);`,
    ],
  },
  {
    // A named exercise ("Bench Press") is currently only identified by a per-task-instance id
    // (task.exercises[].id, generated fresh whenever a task is created/edited) - the same
    // real-world exercise added to two different routines gets two different ids, which is
    // exactly why getFitnessOverview (utils/workouts.js) has to fall back to matching by name
    // string instead, silently fragmenting history across any typo/casing difference. This table
    // is the stable, cross-routine identity that fixes that: `exercises.id` is what
    // task.exercises[].exerciseId (a new field, resolved by storage.js's resolveExerciseId,
    // distinct from the existing per-task exercises[].id) actually refers to.
    toVersion: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS exercises (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_exercises_name_nocase ON exercises(name COLLATE NOCASE);`,
    ],
  },
  {
    // Archive is a third, distinct lifecycle state from `active` (a simple non-date-aware pause
    // gate, checked directly against "today" regardless of which date is being evaluated) and
    // `deleted` (soft, but excluded from analytics entirely - see getTaskVersionsForAnalytics).
    // archived_at is a nullable *timestamp*, not a boolean, specifically so getRoutineFraction
    // can treat it like a one-time cutover: every day before archived_at still computes exactly
    // as if the routine were never archived (preserving 100% of its historical analytics), while
    // archived_at itself and every day after are treated as "nothing due" - the same outcome a
    // day that was simply never scheduled produces. Restoring just clears it back to NULL.
    // Permanently deleting a routine (only ever allowed once archived - see
    // storage.js's permanentlyDeleteRoutine) is a genuine hard delete with no column here at all.
    toVersion: 7,
    statements: [
      `ALTER TABLE routines ADD COLUMN archived_at TEXT;`,
      `ALTER TABLE routine_versions ADD COLUMN archived_at TEXT;`,
    ],
  },
  {
    // A quantity task's target can now be entered/logged as a duration timer instead of a plain
    // number - quantity_mode distinguishes the two ('number', the pre-existing behavior, stays
    // the default so every existing quantity task renders unchanged). target/unit are unchanged
    // by this: in 'timer' mode target still holds the same REAL column, just interpreted as
    // whole seconds instead of an arbitrary unit amount. auto_update_target is a per-task opt-in
    // (default off, matching every other new boolean flag added to this table so far) that lets
    // a timer-mode quantity task raise its own target to the newly logged time whenever that time
    // exceeds the current target - see handleLogQuantityTimer in App.jsx.
    toVersion: 8,
    statements: [
      `ALTER TABLE tasks ADD COLUMN quantity_mode TEXT NOT NULL DEFAULT 'number';`,
      `ALTER TABLE tasks ADD COLUMN auto_update_target INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE task_versions ADD COLUMN quantity_mode TEXT NOT NULL DEFAULT 'number';`,
      `ALTER TABLE task_versions ADD COLUMN auto_update_target INTEGER NOT NULL DEFAULT 0;`,
    ],
  },
  {
    // A routine can now be scoped to run for a specific window (start_date/end_date, both
    // nullable 'YYYY-MM-DD' dates) instead of running indefinitely from creation. These behave
    // like `archived_at` above, not like a versioned field: they're a "which days even count"
    // gate read directly off the live `routines` row (see getRoutineFraction/getDayBreakdown),
    // never resolved per-day through routine_versions cutover - editing them still goes through
    // the normal routineFieldsOf/upsertRoutine diff-and-version path purely for audit-log parity
    // (routine_versions carries the same two columns), the same reason archived_at exists on
    // both tables. end_date doesn't need its own analytics-layer cutover at all: once today
    // reaches it, App.jsx's auto-archive check just calls the existing archiveRoutine(), and
    // archived_at's own already-correct cutover takes over from there.
    toVersion: 9,
    statements: [
      `ALTER TABLE routines ADD COLUMN start_date TEXT;`,
      `ALTER TABLE routines ADD COLUMN end_date TEXT;`,
      `ALTER TABLE routine_versions ADD COLUMN start_date TEXT;`,
      `ALTER TABLE routine_versions ADD COLUMN end_date TEXT;`,
    ],
  },
  {
    // Lets a task's schedule "flex" for one occurrence at a time without touching its recurring
    // days - task_reschedules is a small, unversioned table (one row per moved occurrence, not a
    // task edit) keyed by (task_id, original_date): original_date stops being due (treated as
    // nothing-scheduled, not a miss) and new_date becomes due instead, even if it falls outside
    // task.days. new_date is restricted to a fixed [original_date, original_date + 8 days] range
    // (see utils/reschedule.js's getRescheduleRange) - future-only, anchored to the original day
    // itself rather than a calendar week, since this app has no other notion of "a week" that
    // isn't already a rolling N-days-back window (see rangeStartDate/lastNDates).
    //
    // allow_cross_week_reschedule was a per-task opt-in for a since-abandoned Monday-Sunday-week
    // +/-1-day design (a real product decision to simplify to one fixed rule for everyone, not a
    // bug) - the column is left in place (harmless, always defaults to 0, never read or written
    // by any code anymore) rather than dropped via a rebuild-and-swap migration, since this
    // feature hasn't shipped to production yet and the column costs nothing sitting unused.
    toVersion: 10,
    statements: [
      `ALTER TABLE tasks ADD COLUMN allow_cross_week_reschedule INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE task_versions ADD COLUMN allow_cross_week_reschedule INTEGER NOT NULL DEFAULT 0;`,
      `CREATE TABLE IF NOT EXISTS task_reschedules (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        original_date TEXT NOT NULL,
        new_date TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_task_reschedules_task_original
        ON task_reschedules(task_id, original_date);`,
    ],
  },
];

/**
 * Defensive self-heal for a real bug seen on a device already updated to DB_VERSION 8:
 * PRAGMA user_version had correctly advanced to 8, but the toVersion:8 ALTER TABLE statements
 * (adding quantity_mode/auto_update_target) never actually applied, surfacing as "table tasks
 * has no column named quantity_mode" on every routine save from then on -
 * capacitor-community/sqlite's upgrade runner apparently doesn't guarantee the version number
 * and the statements actually succeeding stay in lockstep if something goes wrong mid-batch.
 * Once that happens, addUpgradeStatement's normal mechanism never retries (it only acts when
 * the stored version is behind DB_VERSION), so this checks for the column directly - cheap,
 * and a no-op on every device where the migration ran correctly - and adds it if missing,
 * without requiring a destructive uninstall/reinstall to recover.
 */
async function ensureQuantityModeColumns(db) {
  const info = await db.query(`PRAGMA table_info(tasks);`);
  const hasColumn = (info.values || []).some((col) => col.name === 'quantity_mode');
  if (hasColumn) return;
  await db.run(`ALTER TABLE tasks ADD COLUMN quantity_mode TEXT NOT NULL DEFAULT 'number';`);
  await db.run(`ALTER TABLE tasks ADD COLUMN auto_update_target INTEGER NOT NULL DEFAULT 0;`);
  await db.run(`ALTER TABLE task_versions ADD COLUMN quantity_mode TEXT NOT NULL DEFAULT 'number';`);
  await db.run(`ALTER TABLE task_versions ADD COLUMN auto_update_target INTEGER NOT NULL DEFAULT 0;`);
}

/** Same self-heal template as ensureQuantityModeColumns above, applied to the toVersion:9
 * start_date/end_date columns - kept as its own cheap PRAGMA check rather than assuming
 * capacitor-community/sqlite's version bookkeeping and its ALTER TABLE statements always stay
 * in lockstep, since they've already been observed not to on a real device once. */
async function ensureRoutineDateColumns(db) {
  const info = await db.query(`PRAGMA table_info(routines);`);
  const hasColumn = (info.values || []).some((col) => col.name === 'start_date');
  if (hasColumn) return;
  await db.run(`ALTER TABLE routines ADD COLUMN start_date TEXT;`);
  await db.run(`ALTER TABLE routines ADD COLUMN end_date TEXT;`);
  await db.run(`ALTER TABLE routine_versions ADD COLUMN start_date TEXT;`);
  await db.run(`ALTER TABLE routine_versions ADD COLUMN end_date TEXT;`);
}

/** Same self-heal template again, for the toVersion:10 reschedule schema. */
async function ensureTaskRescheduleSchema(db) {
  const info = await db.query(`PRAGMA table_info(tasks);`);
  const hasColumn = (info.values || []).some((col) => col.name === 'allow_cross_week_reschedule');
  if (!hasColumn) {
    await db.run(`ALTER TABLE tasks ADD COLUMN allow_cross_week_reschedule INTEGER NOT NULL DEFAULT 0;`);
    await db.run(`ALTER TABLE task_versions ADD COLUMN allow_cross_week_reschedule INTEGER NOT NULL DEFAULT 0;`);
  }
  await db.run(`CREATE TABLE IF NOT EXISTS task_reschedules (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    original_date TEXT NOT NULL,
    new_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
  await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_reschedules_task_original
    ON task_reschedules(task_id, original_date);`);
}

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
  await ensureQuantityModeColumns(db);
  await ensureRoutineDateColumns(db);
  await ensureTaskRescheduleSchema(db);
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

/**
 * Dumps the entire live database (every table, schema and rows) via the sqlite plugin's own
 * exportToJson - not a hand-rolled per-table SELECT, so this automatically covers every table
 * (including ones added by future migrations) with no export-code changes needed per schema
 * bump. The returned object's own `version` field is the DB's current PRAGMA user_version
 * (DB_VERSION at export time), which is exactly what makes round-tripping through
 * importDatabaseJson safe - see there for why.
 */
export async function exportDatabaseJson() {
  const db = await getDb();
  const result = await db.exportToJson('full');
  return result.export;
}

/**
 * Restores a previously-exported database, wholesale-replacing whatever's currently there
 * (`overwrite: true`) - this is a full restore, not a merge. `isJsonValid` rejects anything
 * that isn't a well-formed JsonSQLite export before touching the real database at all.
 *
 * The existing connection is explicitly closed first: `importFromJson` recreates every table
 * from scratch on the same underlying file, and this app's own connection-lifecycle rule (see
 * CLAUDE.md's two-SQLite-drivers-in-one-process warning, which applies just as much to two
 * *uses* of the same driver holding stale handles to a file that just got rewritten out from
 * under them) means the already-open `dbInstance` must not survive past this point. Resetting
 * both module-level caches here forces the next `getDb()` call to open a genuinely fresh
 * connection against the restored file, rather than reusing a handle to the pre-import schema.
 */
export async function importDatabaseJson(jsonExport) {
  const jsonString = JSON.stringify({ ...jsonExport, overwrite: true });
  const isValid = await sqlite.isJsonValid(jsonString);
  if (!isValid.result) {
    throw new Error("That file doesn't look like a valid Daily Routines backup.");
  }

  if (dbInstance) {
    await sqlite.closeConnection(DB_NAME, false);
  }
  dbInstance = null;
  initPromise = null;

  await sqlite.importFromJson(jsonString);

  if (Capacitor.getPlatform() === 'web') {
    // Confirmed via a real browser round-trip: the web backend's saveToStore needs a live
    // connection registered under DB_NAME to know what to persist into IndexedDB -
    // importFromJson alone doesn't leave one open, so calling saveToStore right after it fails
    // with "No available connection for routines". Reopening here (which storage.js's own
    // ready() will happily reuse once its cache is invalidated) is what makes this work.
    await getDb();
    await sqlite.saveToStore(DB_NAME);
  }
}
