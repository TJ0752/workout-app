import { describe, expect, it } from 'vitest';
import { getRescheduleRange, isValidRescheduleTarget } from './reschedule.js';

const ORIGINAL = '2026-07-10'; // a Friday, but the range no longer cares which weekday this is

describe('getRescheduleRange', () => {
  it('is future-only, from the original day itself out to 8 days after', () => {
    expect(getRescheduleRange(ORIGINAL)).toEqual({ min: ORIGINAL, max: '2026-07-18' });
  });

  it('gives the identical-size range regardless of which weekday the original day falls on', () => {
    // Monday
    expect(getRescheduleRange('2026-07-06')).toEqual({ min: '2026-07-06', max: '2026-07-14' });
    // Sunday
    expect(getRescheduleRange('2026-07-12')).toEqual({ min: '2026-07-12', max: '2026-07-20' });
  });
});

describe('isValidRescheduleTarget', () => {
  it('accepts any day from the original day out to 8 days after', () => {
    expect(isValidRescheduleTarget(ORIGINAL, ORIGINAL)).toBe(false); // same day is a no-op, see below
    expect(isValidRescheduleTarget(ORIGINAL, '2026-07-11')).toBe(true);
    expect(isValidRescheduleTarget(ORIGINAL, '2026-07-18')).toBe(true);
  });

  it('rejects the original date itself (a no-op move)', () => {
    expect(isValidRescheduleTarget(ORIGINAL, ORIGINAL)).toBe(false);
  });

  it('rejects a day before the original date - future-only', () => {
    expect(isValidRescheduleTarget(ORIGINAL, '2026-07-09')).toBe(false);
  });

  it('rejects a day more than 8 days after the original date', () => {
    expect(isValidRescheduleTarget(ORIGINAL, '2026-07-19')).toBe(false);
  });

  it('rejects an empty/missing target', () => {
    expect(isValidRescheduleTarget(ORIGINAL, '')).toBe(false);
    expect(isValidRescheduleTarget(ORIGINAL, null)).toBe(false);
  });
});
