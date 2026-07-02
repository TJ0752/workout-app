import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

const REPO = 'TJ0752/workout-app';
const RELEASE_TAG = 'latest-android';

/**
 * Compares the running app's versionCode (set at CI build time to the GitHub
 * Actions run number - see android-build.yml) against the "latest-android"
 * GitHub Release's versionCode, embedded in the release body. No-ops on web:
 * there's no installed native build to compare, and no Play Store/backend to
 * check against otherwise, so this only makes sense on-device.
 */
export async function checkForUpdate() {
  if (!Capacitor.isNativePlatform()) {
    return { updateAvailable: false };
  }

  const info = await App.getInfo();
  const currentBuild = Number(info.build) || 0;

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}`);
  if (!res.ok) {
    throw new Error(`GitHub API responded ${res.status}`);
  }
  const release = await res.json();

  const match = release.body?.match(/versionCode:\s*(\d+)/);
  const latestBuild = match ? Number(match[1]) : 0;
  const asset = (release.assets || []).find((a) => a.name.endsWith('.apk'));

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
