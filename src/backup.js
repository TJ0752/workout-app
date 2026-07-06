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
