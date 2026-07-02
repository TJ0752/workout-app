import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { DownloadCloud, X } from 'lucide-react';
import { checkForUpdate, openDownload } from '../utils/updateCheck';

export default function UpdateChecker() {
  const [status, setStatus] = useState('idle'); // idle | checking | up-to-date | available | error
  const [info, setInfo] = useState(null);

  const runCheck = async (silent) => {
    if (!silent) setStatus('checking');
    try {
      const result = await checkForUpdate();
      if (result.updateAvailable) {
        setInfo(result);
        setStatus('available');
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
        <DownloadCloud size={17} className={status === 'checking' ? 'spin' : ''} />
        {status === 'available' && <span className="update-dot" />}
      </button>

      {status === 'available' && info && (
        <div className="update-banner">
          <span>Update available (build {info.latestBuild})</span>
          <div className="update-banner-actions">
            <button type="button" onClick={() => openDownload(info.downloadUrl)}>
              Download
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
