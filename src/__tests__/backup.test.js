import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = {
  getUri: [],
  share: [],
  importDatabaseJson: [],
  invalidateDbCache: 0,
};

// In-memory fake for the two directories backup.js actually uses (Cache for manual export,
// Data for automatic snapshots) - realistic enough to exercise runAutoBackup's own retention
// pruning logic for real, not just record call args.
const fakeFs = { CACHE: new Map(), DATA: new Map() };

function resetCalls() {
  calls.getUri.length = 0;
  calls.share.length = 0;
  calls.importDatabaseJson.length = 0;
  calls.invalidateDbCache = 0;
  fakeFs.CACHE.clear();
  fakeFs.DATA.clear();
}

// exportBackup/importBackup/runAutoBackup are thin orchestration over the sqlite plugin (via
// db.js) and two native Capacitor plugins (Filesystem/Share) - mocked here the same way
// notifications.test.js mocks @capacitor/core, so this exercises the real call sequencing and
// retention logic without touching an actual device or SQLite connection.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: {
    writeFile: vi.fn(async ({ path, data, directory }) => {
      fakeFs[directory].set(path, data);
    }),
    readFile: vi.fn(async ({ path, directory }) => {
      if (!fakeFs[directory].has(path)) throw new Error(`ENOENT: ${path}`);
      return { data: fakeFs[directory].get(path) };
    }),
    deleteFile: vi.fn(async ({ path, directory }) => {
      fakeFs[directory].delete(path);
    }),
    readdir: vi.fn(async ({ path, directory }) => {
      const prefix = `${path}/`;
      const files = [...fakeFs[directory].keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => ({ name: p.slice(prefix.length), type: 'file' }));
      return { files };
    }),
    getUri: vi.fn(async (opts) => {
      calls.getUri.push(opts);
      return { uri: `file:///cache/${opts.path}` };
    }),
  },
  Directory: { Cache: 'CACHE', Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
}));

vi.mock('@capacitor/share', () => ({
  Share: {
    share: vi.fn(async (opts) => {
      calls.share.push(opts);
    }),
  },
}));

let exportCounter = 0;
vi.mock('../db', () => ({
  exportDatabaseJson: vi.fn(async () => {
    exportCounter += 1;
    return { database: 'routines', version: 5, tables: [], exportCounter };
  }),
  importDatabaseJson: vi.fn(async (json) => {
    calls.importDatabaseJson.push(json);
  }),
}));

vi.mock('../storage', () => ({
  invalidateDbCache: vi.fn(() => {
    calls.invalidateDbCache += 1;
  }),
}));

const { exportBackup, importBackup, runAutoBackup, listAutoBackups, restoreAutoBackup, formatAutoBackupName } =
  await import('../backup');

beforeEach(() => {
  exportCounter = 0;
  resetCalls();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('exportBackup', () => {
  it('writes the exported JSON to a cache file and hands it to the native Share sheet', async () => {
    await exportBackup();

    const [cachePath] = fakeFs.CACHE.keys();
    expect(JSON.parse(fakeFs.CACHE.get(cachePath))).toEqual({
      database: 'routines',
      version: 5,
      tables: [],
      exportCounter: 1,
    });
    expect(calls.getUri).toHaveLength(1);
    expect(calls.getUri[0].path).toBe(cachePath);
    expect(calls.share).toHaveLength(1);
    expect(calls.share[0].url).toBe(`file:///cache/${cachePath}`);
  });
});

describe('importBackup', () => {
  function fakeFile(text) {
    return { text: async () => text };
  }

  it('parses the file and restores it, then invalidates the storage cache', async () => {
    const backup = { database: 'routines', version: 5, tables: [] };
    await importBackup(fakeFile(JSON.stringify(backup)));

    expect(calls.importDatabaseJson).toEqual([backup]);
    expect(calls.invalidateDbCache).toBe(1);
  });

  it('rejects invalid JSON without touching the database', async () => {
    await expect(importBackup(fakeFile('not json'))).rejects.toThrow(/valid Daily Routines backup/);
    expect(calls.importDatabaseJson).toHaveLength(0);
    expect(calls.invalidateDbCache).toBe(0);
  });
});

describe('runAutoBackup', () => {
  it('writes a snapshot into the auto-backups folder under Directory.Data', async () => {
    await runAutoBackup();
    const backups = await listAutoBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^auto-backup-.*\.json$/);
  });

  it('prunes down to the 5 most recent snapshots', async () => {
    for (let i = 0; i < 8; i++) {
      // Distinct filenames even when called within the same millisecond in a fast test run.
      fakeFs.DATA.set(`auto-backups/auto-backup-2026-01-01-00-00-0${i}.json`, '{}');
    }
    await runAutoBackup(); // adds a 9th, then should prune to 5 total
    const backups = await listAutoBackups();
    expect(backups).toHaveLength(5);
    // Newest-first: the just-added snapshot survives, the earliest ones were pruned.
    expect(backups[0]).not.toMatch(/2026-01-01/);
  });
});

describe('restoreAutoBackup', () => {
  it('reads the named snapshot, restores it, and invalidates the storage cache', async () => {
    await runAutoBackup();
    const [name] = await listAutoBackups();

    await restoreAutoBackup(name);

    expect(calls.importDatabaseJson).toHaveLength(1);
    expect(calls.importDatabaseJson[0]).toEqual({ database: 'routines', version: 5, tables: [], exportCounter: 1 });
    expect(calls.invalidateDbCache).toBe(1);
  });
});

describe('formatAutoBackupName', () => {
  it('turns a snapshot filename into a human-readable date/time', () => {
    const formatted = formatAutoBackupName('auto-backup-2026-07-06-05-11-44.json');
    expect(formatted).not.toBe('auto-backup-2026-07-06-05-11-44.json');
    expect(formatted).toMatch(/2026/);
  });

  it('falls back to the raw name if it does not match the expected shape', () => {
    expect(formatAutoBackupName('something-else.json')).toBe('something-else.json');
  });

  it('interprets the filename timestamp as UTC and converts it to the device local time', () => {
    // Regression test for a real bug: the filename encodes a UTC instant (autoBackupFileName
    // uses toISOString()), but this used to reconstruct it with the local-time
    // `Date(y, mo, d, h, mi, s)` constructor - which always reads its arguments as local time by
    // definition, so it silently relabeled a UTC clock reading as a local one before formatting.
    // Under that bug the displayed hour is always exactly the filename's hour (05), regardless of
    // the device's timezone. Etc/GMT+5 is a fixed UTC-5 offset with no DST, chosen so the correct
    // answer (05:11 UTC -> 00:11 local) is unambiguous and stable in CI.
    const originalTZ = process.env.TZ;
    process.env.TZ = 'Etc/GMT+5';
    try {
      const formatted = formatAutoBackupName('auto-backup-2026-07-06-05-11-44.json');
      expect(formatted).toMatch(/12:11/); // 00:11 local, 12-hour clock
      expect(formatted).not.toMatch(/\b5:11\b/); // the bug's telltale: filename hour shown verbatim
    } finally {
      process.env.TZ = originalTZ;
    }
  });
});
