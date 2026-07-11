import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import {
  checkForUpdate,
  downloadUpdate,
  installReadyUpdate,
  initUpdateReadyListener,
  initUpdateFailedListener,
} from '../utils/updateCheck';

/**
 * Auto-downloads a newly-available release APK the moment one's detected (no "Download" tap
 * needed) and surfaces a one-tap "Install" banner once it's ready - the closest a sideloaded
 * (non-Play-Store) app can get to Play Store's silent auto-update. The mandatory system install
 * confirmation (Android has no way for a regular app to skip it) is the one tap that can't be
 * removed; everything before it now happens automatically. See utils/updateCheck.js and
 * android/.../update/ for the native download+notification mechanics.
 *
 * Extracted out of UpdateChecker.jsx into its own hook so App.jsx can hold a single instance of
 * this state and render two independent pieces from it - a small icon button that must always
 * stay in the header's own one-line icon row, and a banner/toast status area that renders as a
 * separate full-width block below that row (see the "App header version badge" CLAUDE.md entry
 * for the layout bug this split fixes: the banner used to be a flex sibling of the icon buttons
 * themselves, and once the header's flex-wrap was set to `nowrap` - to stop the title/version
 * badge from wrapping the settings gear onto a second row - the banner had nothing to force it
 * onto its own line either, so it got squeezed into the icon row and pushed the settings gear
 * off-screen).
 */
export function useUpdateChecker() {
  // idle | checking | downloading | ready | up-to-date | error | download-failed
  const [status, setStatus] = useState('idle');
  const [downloadFailReason, setDownloadFailReason] = useState('');

  const startDownload = async (result) => {
    try {
      const response = await downloadUpdate(result);
      // downloadUpdate() no-ops (without re-enqueuing) and resolves with whatever status this
      // exact versionCode already has if it's already downloading or ready - important now that
      // runCheck(true) also re-runs on every foreground transition (see below), not just cold
      // open: without checking this, re-foregrounding the app while an update sat "ready" (its
      // Install banner showing) would blindly stomp that back to a transient "downloading" toast
      // that then auto-hides to idle, silently dropping the banner for no actual reason.
      if (response?.status === 'ready') {
        setStatus('ready');
        return;
      }
      setStatus('downloading');
      // downloadUpdate() only confirms the download was *enqueued*, not complete - the actual
      // "ready" transition arrives later via initUpdateReadyListener below (or is already true
      // if a prior check's download finished while this component wasn't mounted to see it).
      setTimeout(() => setStatus((s) => (s === 'downloading' ? 'idle' : s)), 4000);
    } catch {
      setStatus('idle');
    }
  };

  const runCheck = async (silent) => {
    if (!silent) setStatus('checking');
    try {
      const result = await checkForUpdate();
      if (result.updateAvailable) {
        await startDownload(result);
        return;
      }
      if (silent) {
        setStatus('idle');
        return;
      }
      setStatus('up-to-date');
      setTimeout(() => setStatus((s) => (s === 'up-to-date' ? 'idle' : s)), 2500);
    } catch {
      if (!silent) {
        setStatus('error');
        setTimeout(() => setStatus((s) => (s === 'error' ? 'idle' : s)), 2500);
      }
    }
  };

  useEffect(() => {
    runCheck(true);
    const listenerPromise = initUpdateReadyListener(() => setStatus('ready'));
    // Previously a failed download (a bad redirect, no space, a flaky connection, anything
    // DownloadManager itself reports as a failure) was swallowed entirely on the native side -
    // the "Downloading update…" toast would show, then just silently vanish with no install
    // prompt and no error, indistinguishable from "still downloading, check back later." This
    // surfaces the actual reason so it's an obvious, diagnosable failure instead.
    const failedListenerPromise = initUpdateFailedListener((reason) => {
      setDownloadFailReason(reason || '');
      setStatus('download-failed');
    });
    // Re-checks on every foreground transition, not just the initial mount - a silent check on
    // cold-open alone missed the common case of an app left running in the background for a
    // while (the whole point of the persistent background-sync process, see CLAUDE.md) getting
    // brought back to the foreground without a fresh launch. `isActive` is false on the
    // corresponding backgrounding transition, which this deliberately ignores.
    const appStateListenerPromise = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) runCheck(true);
    });
    return () => {
      listenerPromise?.then((handle) => handle.remove());
      failedListenerPromise?.then((handle) => handle.remove());
      appStateListenerPromise?.then((handle) => handle.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isNative: Capacitor.isNativePlatform(),
    status,
    downloadFailReason,
    runCheck,
    installReadyUpdate,
    dismiss: () => setStatus('idle'),
  };
}
