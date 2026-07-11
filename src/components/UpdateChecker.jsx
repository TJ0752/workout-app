import { DownloadCloud, X } from 'lucide-react';

/**
 * The round header icon button only - always stays inside the header's own one-line icon row
 * (logo/title/version badge/settings gear), regardless of update status. Status content that
 * needs more room (the "ready to install" banner, toasts) renders separately via
 * UpdateStatusBar below - see useUpdateChecker.js for why these two are split out of one
 * component instead of one component owning both.
 */
export default function UpdateChecker({ isNative, status, onCheck }) {
  if (!isNative) return null;

  return (
    <button
      type="button"
      className="update-check-btn"
      onClick={onCheck}
      aria-label="Check for updates"
      title="Check for updates"
    >
      <DownloadCloud size={15} className={status === 'checking' || status === 'downloading' ? 'spin' : ''} />
      {status === 'ready' && <span className="update-dot" />}
    </button>
  );
}

/**
 * The banner/toast status area - rendered as its own full-width block below the header's icon
 * row, not mixed into that row's flex layout. This is what keeps every header icon (including
 * the settings gear) always visible: the icon row itself never has to make room for this
 * content, since it isn't a sibling flex item of the icon buttons anymore.
 */
export function UpdateStatusBar({ isNative, status, downloadFailReason, onInstall, onDismiss, onRetry }) {
  if (!isNative) return null;

  if (status === 'downloading') return <div className="update-toast">Downloading update…</div>;

  if (status === 'ready') {
    return (
      <div className="update-banner">
        <span>Update ready to install</span>
        <div className="update-banner-actions">
          <button type="button" onClick={onInstall}>
            Install
          </button>
          <button type="button" className="update-banner-dismiss" onClick={onDismiss} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  if (status === 'up-to-date') return <div className="update-toast">You&rsquo;re up to date</div>;
  if (status === 'error') return <div className="update-toast error">Couldn&rsquo;t check for updates</div>;

  if (status === 'download-failed') {
    return (
      <div className="update-toast error">
        Update download failed{downloadFailReason ? ` (${downloadFailReason})` : ''}.{' '}
        <button type="button" className="update-retry-link" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  return null;
}
