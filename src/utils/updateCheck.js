import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';

const REPO = 'TJ0752/workout-app';

// Native-only (see android/.../update/UpdateInstallerPlugin.kt) - downloads a release APK via
// Android's own DownloadManager and posts a tap-to-install notification once it's ready, since a
// sideloaded (non-Play-Store) app has no way to install itself without at least one explicit
// system confirmation. No-ops on web (there's no installed native build to update).
const UpdateInstaller = Capacitor.isNativePlatform() ? registerPlugin('UpdateInstaller') : null;

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
    fileName: assetName,
  };
}

/**
 * Downloads a newly-available release APK in the background (native DownloadManager, not a
 * browser round-trip) and, once complete, posts an "Update ready" notification whose tap target
 * fires the system install confirmation directly - the closest a sideloaded app can get to
 * Play Store's silent auto-update, since only a privileged installer (Play Store itself, or
 * root) can skip that confirmation entirely; a regular app has no permission that grants it.
 * `versionCode` (checkForUpdate's `latestBuild`) lets the native side no-op a repeat call for a
 * build that's already downloading or ready, instead of re-downloading the identical APK every
 * time the app happens to be reopened before the user gets around to installing. No-ops on web.
 */
export async function downloadUpdate({ downloadUrl, fileName, latestBuild }) {
  if (!UpdateInstaller) return null;
  return UpdateInstaller.downloadUpdate({ url: downloadUrl, fileName, versionCode: latestBuild });
}

/** Re-fires the install confirmation for an already-downloaded update - lets in-app UI offer a
 * retry if the "Update ready" notification was dismissed or missed. No-ops on web. */
export async function installReadyUpdate() {
  if (!UpdateInstaller) return null;
  return UpdateInstaller.installReadyUpdate();
}

/** Fires once a background download started by downloadUpdate() finishes - see
 * UpdateDownloadReceiver.kt. Registered with `true` retained semantics on the native side, so a
 * listener attached after the event already fired (e.g. the app was reopened after the download
 * completed while backgrounded) still receives it. No-ops on web. */
export function initUpdateReadyListener(onReady) {
  if (!UpdateInstaller) return null;
  return UpdateInstaller.addListener('updateReady', (event) => onReady(event.versionCode));
}

/**
 * Fires when a download DownloadManager itself reported as failed (or the completed file
 * couldn't be found) - previously this case was swallowed entirely on the native side with no
 * signal anywhere, so a failed download looked identical to one that was simply still in
 * progress: the "Downloading update…" toast would show, then just quietly disappear with no
 * install prompt and no error. `reason` is a short human-readable string (DownloadManager's own
 * ERROR_* reason code, or a raw HTTP status) - see UpdateDownloadReceiver.kt. No-ops on web.
 */
export function initUpdateFailedListener(onFailed) {
  if (!UpdateInstaller) return null;
  return UpdateInstaller.addListener('updateFailed', (event) => onFailed(event.reason));
}
