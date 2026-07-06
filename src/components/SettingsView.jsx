import { useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, DownloadCloud, UploadCloud } from 'lucide-react';
import { exportBackup, importBackup } from '../backup';

export default function SettingsView({ onClose, onImported }) {
  const [exportStatus, setExportStatus] = useState('idle'); // idle | exporting | done | error
  const [importStatus, setImportStatus] = useState('idle'); // idle | importing | done | error
  const [importError, setImportError] = useState('');
  const fileInputRef = useRef(null);

  const handleExport = async () => {
    setExportStatus('exporting');
    try {
      await exportBackup();
      setExportStatus('done');
      setTimeout(() => setExportStatus((s) => (s === 'done' ? 'idle' : s)), 3000);
    } catch (err) {
      console.warn('Export failed', err);
      setExportStatus('error');
      setTimeout(() => setExportStatus((s) => (s === 'error' ? 'idle' : s)), 3000);
    }
  };

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the exact same file again later
    if (!file) return;
    const proceed = confirm(
      "Restoring a backup replaces everything currently in the app - routines, tasks, history, workout logs. This can't be undone. Continue?"
    );
    if (!proceed) return;

    setImportStatus('importing');
    setImportError('');
    try {
      await importBackup(file);
      setImportStatus('done');
      await onImported?.();
    } catch (err) {
      console.warn('Import failed', err);
      setImportStatus('error');
      setImportError(err.message || 'Something went wrong reading that file.');
    }
  };

  return (
    <div className="settings-view">
      <header className="settings-header">
        <button type="button" className="settings-back" onClick={onClose} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <h2>Settings</h2>
      </header>

      <div className="settings-body">
        <div className="section-title">Data backup</div>
        <p className="settings-desc">
          Android also backs your data up automatically in the background (Settings › Google › Backup), but
          that only restores itself on a fresh install, on its own schedule. Use the buttons below any time you
          want an on-demand, verifiable snapshot instead - moving to a new phone, before trying something risky,
          or just for peace of mind.
        </p>

        <div className="settings-actions">
          <button
            type="button"
            className="settings-action-btn"
            onClick={handleExport}
            disabled={exportStatus === 'exporting'}
          >
            <DownloadCloud size={16} className={exportStatus === 'exporting' ? 'spin' : ''} />
            Export data
          </button>
          <button
            type="button"
            className="settings-action-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={importStatus === 'importing'}
          >
            <UploadCloud size={16} className={importStatus === 'importing' ? 'spin' : ''} />
            Import data
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            onChange={handleFileSelected}
            style={{ display: 'none' }}
          />
        </div>

        {exportStatus === 'done' && (
          <p className="settings-status success">
            {Capacitor.isNativePlatform() ? 'Backup ready - pick where to save or send it.' : 'Backup downloaded.'}
          </p>
        )}
        {exportStatus === 'error' && <p className="settings-status error">Export failed - try again.</p>}
        {importStatus === 'done' && <p className="settings-status success">Backup restored.</p>}
        {importStatus === 'error' && <p className="settings-status error">{importError}</p>}
      </div>
    </div>
  );
}
