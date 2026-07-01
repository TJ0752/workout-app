import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'routines';
const DB_VERSION = 1;

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
