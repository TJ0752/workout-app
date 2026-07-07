import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { DownloadCloud, X } from 'lucide-react';
import { checkForUpdate, downloadUpdate, installReadyUpdate, initUpdateReadyListener } from '../utils/updateCheck';

/**
 * Auto-downloads a newly-available release APK the moment one's detected (no "Download" tap
 * needed) and surfaces a one-tap "Install" banner once it's ready - the closest a sideloaded
 * (non-Play-Store) app can get to Play Store's silent auto-update. The mandatory system install
 * confirmation (Android has no way for a regular app to skip it) is the one tap that can't be
 * removed; everything before it now happens automatically. See utils/updateCheck.js and
 * android/.../update/ for the native download+notification mechanics.
 */
export default function UpdateChecker() {
  const [status, setStatus] = useState('idle'); // idle | checking | downloading | ready | up-to-date | error

  const startDownload = async (result) => {
    setStatus('downloading');
    try {
      await downloadUpdate(result);
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
    return () => {
      listenerPromise?.then((handle) => handle.remove());
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
        <DownloadCloud size={17} className={status === 'checking' || status === 'downloading' ? 'spin' : ''} />
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
    </>
  );
}
