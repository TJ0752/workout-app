import { describe, expect, it } from 'vitest';
import { releaseTagFor } from './updateCheck';

// Regression test for a real bug: the `prod`/`dev` flavors share one web bundle (see
// CLAUDE.md's "Test app / product flavors"), so checkForUpdate can't hardcode a single release
// tag - the dev app must never be offered the prod APK (a different applicationId, which fails
// at the OS installer level as "package appears to be invalid" rather than updating in place).
describe('releaseTagFor', () => {
  it('points the real (prod) app at the prod release', () => {
    expect(releaseTagFor('com.tharuka.routines')).toBe('latest-android');
  });

  it('points the dev/test app at the dev release', () => {
    expect(releaseTagFor('com.tharuka.routines.dev')).toBe('latest-android-dev');
  });

  it('falls back to the prod release for an unrecognized or missing id', () => {
    expect(releaseTagFor(undefined)).toBe('latest-android');
    expect(releaseTagFor('')).toBe('latest-android');
  });
});
