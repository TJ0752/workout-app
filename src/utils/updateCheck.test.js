import { describe, expect, it } from 'vitest';
import { releaseTagFor, assetNameFor } from './updateCheck';

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

// Regression test for a real bug: the `latest-android` release predates the flavor split and
// still carries a leftover `app-debug.apk` asset alongside the current `app-prod-debug.apk`
// (softprops/action-gh-release doesn't prune assets it's no longer given). Matching loosely by
// "any .apk" could pick the stale, much older asset, which fails to install over the current
// app as "package appears to be invalid" (really Android's downgrade protection).
describe('assetNameFor', () => {
  it('picks the exact prod/dev asset filename, not just any .apk', () => {
    expect(assetNameFor('com.tharuka.routines')).toBe('app-prod-debug.apk');
    expect(assetNameFor('com.tharuka.routines.dev')).toBe('app-dev-debug.apk');
  });

  it('falls back to the prod asset for an unrecognized or missing id', () => {
    expect(assetNameFor(undefined)).toBe('app-prod-debug.apk');
    expect(assetNameFor('')).toBe('app-prod-debug.apk');
  });
});
