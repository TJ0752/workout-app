import { describe, expect, it } from 'vitest';
import { getRescheduleRange, isValidRescheduleTarget } from './reschedule.js';

// 2026-07-07 is a Tuesday. Its Monday-start week is 2026-07-06 (Mon) .. 2026-07-12 (Sun).
const TUESDAY = '2026-07-07';
const MONDAY = '2026-07-06';
const SUNDAY = '2026-07-12';

describe('getRescheduleRange', () => {
  it('bounds to the same Monday-start week when cross-week is not allowed', () => {
    expect(getRescheduleRange(TUESDAY, false)).toEqual({ min: MONDAY, max: SUNDAY });
  });

  it('extends one day on either side when cross-week is allowed', () => {
    expect(getRescheduleRange(TUESDAY, true)).toEqual({ min: '2026-07-05', max: '2026-07-13' });
  });

  it('gives the same range for every day within the same week', () => {
    expect(getRescheduleRange(SUNDAY, false)).toEqual({ min: MONDAY, max: SUNDAY });
    expect(getRescheduleRange(MONDAY, false)).toEqual({ min: MONDAY, max: SUNDAY });
  });
});

describe('isValidRescheduleTarget', () => {
  it('accepts any other day within the same week', () => {
    expect(isValidRescheduleTarget(TUESDAY, MONDAY, false)).toBe(true);
    expect(isValidRescheduleTarget(TUESDAY, SUNDAY, false)).toBe(true);
  });

  it('rejects the original date itself (a no-op move)', () => {
    expect(isValidRescheduleTarget(TUESDAY, TUESDAY, false)).toBe(false);
  });

  it('rejects a day outside the week when cross-week is not allowed', () => {
    expect(isValidRescheduleTarget(TUESDAY, '2026-07-13', false)).toBe(false);
    expect(isValidRescheduleTarget(TUESDAY, '2026-07-05', false)).toBe(false);
  });

  it('accepts exactly one day outside the week when cross-week is allowed', () => {
    expect(isValidRescheduleTarget(TUESDAY, '2026-07-13', true)).toBe(true);
    expect(isValidRescheduleTarget(TUESDAY, '2026-07-05', true)).toBe(true);
  });

  it('still rejects two days outside the week even when cross-week is allowed', () => {
    expect(isValidRescheduleTarget(TUESDAY, '2026-07-14', true)).toBe(false);
    expect(isValidRescheduleTarget(TUESDAY, '2026-07-04', true)).toBe(false);
  });

  it('rejects an empty/missing target', () => {
    expect(isValidRescheduleTarget(TUESDAY, '', false)).toBe(false);
    expect(isValidRescheduleTarget(TUESDAY, null, false)).toBe(false);
  });
});
