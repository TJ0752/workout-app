import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

const REPO = 'TJ0752/workout-app';

/**
 * The `prod` (com.tharuka.routines) and `dev` (com.tharuka.routines.dev) flavors share this
 * exact same web bundle - Capacitor copies one `dist/` into both, flavors only change native
 * Android config (see CLAUDE.md's "Test app / product flavors") - so this can't just hardcode
 * one release tag. `App.getInfo().id` is the actual running applicationId at runtime, which is
 * what picks the right one: the `dev` app must only ever offer to install a `dev`-flavored APK
 * over itself, and vice versa - installing a `prod` APK over a `dev` install (or the reverse) is
 * a different Android package entirely, and fails at the OS installer level ("package appears to
 * be invalid") rather than updating in place.
 */
export function releaseTagFor(applicationId) {
  return applicationId?.endsWith('.dev') ? 'latest-android-dev' : 'latest-android';
}

/**
 * A release can carry more than one .apk asset - the `latest-android` tag predates the
 * prod/dev flavor split and still has a leftover pre-flavor `app-debug.apk` sitting alongside
 * the current `app-prod-debug.apk` (softprops/action-gh-release only adds/overwrites the files
 * it's given; it doesn't prune assets that are no longer produced). Matching by exact filename
 * - not just "ends with .apk" - is what keeps checkForUpdate from grabbing that stale asset,
 * which is a much older, lower-versionCode build and triggers Android's downgrade protection
 * (surfaced to the user as "App not installed as package appears to be invalid") when installed
 * over the current app.
 */
export function assetNameFor(applicationId) {
  return applicationId?.endsWith('.dev') ? 'app-dev-debug.apk' : 'app-prod-debug.apk';
}

/**
 * Compares the running app's versionCode (set at CI build time to the GitHub
 * Actions run number - see android-build.yml) against the matching GitHub Release's
 * versionCode, embedded in the release body. No-ops on web:
 * there's no installed native build to compare, and no Play Store/backend to
 * check against otherwise, so this only makes sense on-device.
 */
export async function checkForUpdate() {
  if (!Capacitor.isNativePlatform()) {
    return { updateAvailable: false };
  }

  const info = await App.getInfo();
  const currentBuild = Number(info.build) || 0;
  const releaseTag = releaseTagFor(info.id);

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${releaseTag}`);
  if (!res.ok) {
    throw new Error(`GitHub API responded ${res.status}`);
  }
  const release = await res.json();

  const match = release.body?.match(/versionCode:\s*(\d+)/);
  const latestBuild = match ? Number(match[1]) : 0;
  const assetName = assetNameFor(info.id);
  const asset =
    (release.assets || []).find((a) => a.name === assetName) ||
    (release.assets || []).find((a) => a.name.endsWith('.apk'));

  return {
    updateAvailable: latestBuild > currentBuild,
    currentBuild,
    latestBuild,
    downloadUrl: asset?.browser_download_url || release.html_url,
  };
}

export function openDownload(url) {
  // '_system' tells Capacitor's core bridge to hand the URL to the device's
  // default external browser rather than an in-app WebView tab - required
  // for the OS's normal download manager (and its "unknown sources" install
  // prompt) to actually take over for an .apk.
  window.open(url, '_system');
}
