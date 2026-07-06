import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { exportDatabaseJson, importDatabaseJson } from './db';
import { invalidateDbCache } from './storage';

function backupFileName() {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `daily-routines-backup-${stamp}.json`;
}

/**
 * On-demand full-database export, independent of Android's own Auto Backup (which only runs on
 * its own schedule and only actually restores on a genuinely fresh install - see CLAUDE.md).
 * This is the verifiable, immediate counterpart: a single JSON file the user fully controls
 * (share it to Drive, email, Files - whatever), that importBackup below can restore from
 * directly, on this device or a fresh one, at any time.
 *
 * Web gets a plain browser download instead of the native Share sheet - there's no OS-level
 * share target to hand a file to in a desktop browser, and this doubles as the dev-loop path
 * for testing the export content without a device (see storage.test.js).
 */
export async function exportBackup() {
  const json = await exportDatabaseJson();
  const content = JSON.stringify(json, null, 2);
  const fileName = backupFileName();

  if (!Capacitor.isNativePlatform()) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return { fileName };
  }

  await Filesystem.writeFile({
    path: fileName,
    data: content,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  });
  const { uri } = await Filesystem.getUri({ path: fileName, directory: Directory.Cache });
  await Share.share({ title: 'Daily Routines backup', url: uri });
  return { fileName };
}

/**
 * Restores a backup from a File the caller already has in hand (the Settings screen's hidden
 * `<input type="file">` - browsers/WebView both hand back a real File object from that without
 * needing a native file-picker plugin at all). Wholesale replace, not a merge - see
 * db.js's importDatabaseJson for exactly what that means and why it's safe to do destructively.
 */
export async function importBackup(file) {
  const text = await file.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("That file doesn't look like a valid Daily Routines backup.");
  }
  await importDatabaseJson(json);
  invalidateDbCache();
}

// App-private storage (Directory.Data -> Android's getFilesDir()), not the Cache dir the manual
// export above uses - Cache can be purged by the OS under storage pressure, which would defeat
// the entire point of an automatic safety net. Deliberately *not* Directory.Documents/External:
// writing there needs storage permissions that vary awkwardly across Android versions (scoped
// storage), for a benefit (surviving a deliberate uninstall) Android's own Auto Backup already
// covers via data_extraction_rules.xml/backup_rules.xml - see the `file` domain include added
// there specifically for this folder.
const AUTO_BACKUP_DIR = 'auto-backups';
const AUTO_BACKUP_RETENTION = 5;

function autoBackupFileName() {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `auto-backup-${stamp}.json`;
}

/**
 * Takes a fresh automatic snapshot and prunes older ones down to AUTO_BACKUP_RETENTION - called
 * once per app-process launch (App.jsx's top-level mount effect, which itself only runs once per
 * launch), not on a timer. That's a deliberate fit for "seamless, before every release": a normal
 * in-place app update never touches this app-private directory at all (Android only wipes it on
 * a genuine uninstall, not an update - "in case something goes wrong" for a bad release means a
 * data-*corrupting* bug, not the update process itself deleting anything), so the snapshot from
 * the most recent time the app was opened is already sitting there the moment a new build lands,
 * with zero action needed. No-ops on web - there's no separate "reinstall" story worth protecting
 * against on a dev machine, and this would just add IndexedDB noise to the browser dev loop.
 */
export async function runAutoBackup() {
  if (!Capacitor.isNativePlatform()) return;

  const json = await exportDatabaseJson();
  await Filesystem.writeFile({
    path: `${AUTO_BACKUP_DIR}/${autoBackupFileName()}`,
    data: JSON.stringify(json),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  });

  const { files } = await Filesystem.readdir({ path: AUTO_BACKUP_DIR, directory: Directory.Data });
  const sorted = files.map((f) => f.name).sort(); // filenames are zero-padded ISO stamps, so lexicographic == chronological
  const stale = sorted.slice(0, Math.max(0, sorted.length - AUTO_BACKUP_RETENTION));
  for (const name of stale) {
    await Filesystem.deleteFile({ path: `${AUTO_BACKUP_DIR}/${name}`, directory: Directory.Data });
  }
}

/** Newest-first, for the Settings screen's "Recent local backups" list. */
export async function listAutoBackups() {
  if (!Capacitor.isNativePlatform()) return [];
  try {
    const { files } = await Filesystem.readdir({ path: AUTO_BACKUP_DIR, directory: Directory.Data });
    return files
      .map((f) => f.name)
      .sort()
      .reverse();
  } catch {
    return []; // directory doesn't exist yet - no auto-backup has run this install
  }
}

/** Restores one specific automatic snapshot by its file name (as returned by listAutoBackups). */
export async function restoreAutoBackup(name) {
  const { data } = await Filesystem.readFile({
    path: `${AUTO_BACKUP_DIR}/${name}`,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
  const json = JSON.parse(data);
  await importDatabaseJson(json);
  invalidateDbCache();
}

/**
 * `auto-backup-2026-07-06-05-11-44.json` -> the equivalent local time, e.g. `Jul 6, 2026, 1:11 PM`
 * for a UTC+8 device. The filename's timestamp is `toISOString()`-derived, i.e. UTC - a real bug
 * here parsed those components with the local-time `Date(y, mo, d, h, mi, s)` constructor, which
 * silently relabels a UTC clock reading as a local one before formatting, showing the wrong time
 * everywhere outside UTC+0. `Date.UTC(...)` parses it as the UTC instant it actually is; only the
 * display step (`toLocaleString`, no explicit timeZone) converts it to the device's local zone.
 */
export function formatAutoBackupName(name) {
  const match = name.match(/^auto-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.json$/);
  if (!match) return name;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
