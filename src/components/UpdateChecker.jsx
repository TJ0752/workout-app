import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { DownloadCloud, X } from 'lucide-react';
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
 */
export default function UpdateChecker() {
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

  if (!Capacitor.isNativePlatform()) return null;

  return (
    <>
      <button
        type="button"
        className="update-check-btn"
        onClick={() => runCheck(false)}
        aria-label="Check for updates"
        title="Check for updates"
      >
        <DownloadCloud size={15} className={status === 'checking' || status === 'downloading' ? 'spin' : ''} />
        {status === 'ready' && <span className="update-dot" />}
      </button>

      {status === 'downloading' && <div className="update-toast">Downloading update…</div>}

      {status === 'ready' && (
        <div className="update-banner">
          <span>Update ready to install</span>
          <div className="update-banner-actions">
            <button type="button" onClick={() => installReadyUpdate()}>
              Install
            </button>
            <button
              type="button"
              className="update-banner-dismiss"
              onClick={() => setStatus('idle')}
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      {status === 'up-to-date' && <div className="update-toast">You&rsquo;re up to date</div>}
      {status === 'error' && <div className="update-toast error">Couldn&rsquo;t check for updates</div>}
      {status === 'download-failed' && (
        <div className="update-toast error">
          Update download failed{downloadFailReason ? ` (${downloadFailReason})` : ''}.{' '}
          <button type="button" className="update-retry-link" onClick={() => runCheck(false)}>
            Retry
          </button>
        </div>
      )}
    </>
  );
}
