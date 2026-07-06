import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = {
  writeFile: [],
  getUri: [],
  share: [],
  importDatabaseJson: [],
  invalidateDbCache: 0,
};

function resetCalls() {
  calls.writeFile.length = 0;
  calls.getUri.length = 0;
  calls.share.length = 0;
  calls.importDatabaseJson.length = 0;
  calls.invalidateDbCache = 0;
}

// exportBackup/importBackup are thin orchestration over the sqlite plugin (via db.js) and two
// native Capacitor plugins (Filesystem/Share) - mocked here the same way notifications.test.js
// mocks @capacitor/core, so this exercises the real call sequencing without touching an actual
// device or SQLite connection.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: {
    writeFile: vi.fn(async (opts) => {
      calls.writeFile.push(opts);
    }),
    getUri: vi.fn(async (opts) => {
      calls.getUri.push(opts);
      return { uri: `file:///cache/${opts.path}` };
    }),
  },
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
}));

vi.mock('@capacitor/share', () => ({
  Share: {
    share: vi.fn(async (opts) => {
      calls.share.push(opts);
    }),
  },
}));

vi.mock('../db', () => ({
  exportDatabaseJson: vi.fn(async () => ({ database: 'routines', version: 5, tables: [] })),
  importDatabaseJson: vi.fn(async (json) => {
    calls.importDatabaseJson.push(json);
  }),
}));

vi.mock('../storage', () => ({
  invalidateDbCache: vi.fn(() => {
    calls.invalidateDbCache += 1;
  }),
}));

const { exportBackup, importBackup } = await import('../backup');

beforeEach(() => {
  resetCalls();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('exportBackup', () => {
  it('writes the exported JSON to a cache file and hands it to the native Share sheet', async () => {
    await exportBackup();

    expect(calls.writeFile).toHaveLength(1);
    expect(calls.writeFile[0].directory).toBe('CACHE');
    const written = JSON.parse(calls.writeFile[0].data);
    expect(written).toEqual({ database: 'routines', version: 5, tables: [] });

    expect(calls.getUri).toHaveLength(1);
    expect(calls.getUri[0].path).toBe(calls.writeFile[0].path);

    expect(calls.share).toHaveLength(1);
    expect(calls.share[0].url).toBe(`file:///cache/${calls.writeFile[0].path}`);
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
