import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateId } from './id.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateId', () => {
  it('uses crypto.randomUUID when available and produces unique ids', () => {
    const a = generateId();
    const b = generateId();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });

  it('falls back to crypto.getRandomValues (with correct version/variant nibbles) when randomUUID is unavailable', () => {
    // Simulates an older Android WebView that has getRandomValues but not
    // randomUUID - see the doc comment in id.js.
    const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal('crypto', { getRandomValues: realGetRandomValues });
    const id = generateId();
    expect(id).toMatch(UUID_RE);
    // Version nibble (first hex digit of the 3rd group) must be 4.
    expect(id[14]).toBe('4');
    // Variant nibble (first hex digit of the 4th group) must be 8, 9, a, or b.
    expect(['8', '9', 'a', 'b']).toContain(id[19].toLowerCase());
  });

  it('falls back to Math.random when crypto is entirely unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const id = generateId();
    expect(id).toMatch(/^id-[0-9a-z]+-[0-9a-z]+$/);
  });
});
