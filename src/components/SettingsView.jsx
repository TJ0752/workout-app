import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { ArrowLeft, Check, Clipboard, DownloadCloud, History, Sparkles, UploadCloud } from 'lucide-react';
import { exportBackup, importBackup, listAutoBackups, restoreAutoBackup, formatAutoBackupName } from '../backup';
import { AI_IMPORT_PROMPT, AiImportError, parseAiImportText } from '../aiImport';

export default function SettingsView({ onClose, onImported, onAiImport }) {
  const [exportStatus, setExportStatus] = useState('idle'); // idle | exporting | done | error
  const [importStatus, setImportStatus] = useState('idle'); // idle | importing | done | error
  const [importError, setImportError] = useState('');
  const [autoBackups, setAutoBackups] = useState([]);
  const [restoringName, setRestoringName] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const fileInputRef = useRef(null);

  const [promptCopied, setPromptCopied] = useState(false);
  const [aiImportText, setAiImportText] = useState('');
  const [aiImportStatus, setAiImportStatus] = useState('idle'); // idle | importing | done | error
  const [aiImportError, setAiImportError] = useState('');
  const [aiImportNotes, setAiImportNotes] = useState([]);
  const [aiImportCount, setAiImportCount] = useState(0);

  useEffect(() => {
    listAutoBackups().then(setAutoBackups);
    // Native-only, like everything else this app can't know on web (there's no installed build
    // to report on) - versionName/versionCode are both set at CI build time from the same GitHub
    // Actions run number (see android-build.yml), so either one alone already uniquely identifies
    // exactly which build is installed; showing both just makes that easier to read at a glance.
    if (Capacitor.isNativePlatform()) {
      App.getInfo()
        .then(setAppInfo)
        .catch(() => {});
    }
  }, []);

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

  const handleRestoreAutoBackup = async (name) => {
    const proceed = confirm(
      `Restore the snapshot from ${formatAutoBackupName(name)}? This replaces everything currently in the app and can't be undone.`
    );
    if (!proceed) return;

    setRestoringName(name);
    setImportError('');
    try {
      await restoreAutoBackup(name);
      setImportStatus('done');
      await onImported?.();
    } catch (err) {
      console.warn('Restore failed', err);
      setImportStatus('error');
      setImportError(err.message || 'Something went wrong restoring that snapshot.');
    } finally {
      setRestoringName(null);
    }
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(AI_IMPORT_PROMPT);
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 3000);
    } catch (err) {
      console.warn('Copy failed', err);
    }
  };

  const handleAiImportSubmit = async () => {
    setAiImportStatus('importing');
    setAiImportError('');
    setAiImportNotes([]);
    try {
      const { results, notes } = parseAiImportText(aiImportText);
      await onAiImport?.(results);
      setAiImportStatus('done');
      setAiImportCount(results.length);
      setAiImportNotes(notes);
      setAiImportText('');
    } catch (err) {
      console.warn('AI import failed', err);
      setAiImportStatus('error');
      setAiImportError(
        err instanceof AiImportError ? err.issues.join('\n') : err.message || 'Something went wrong reading that JSON.'
      );
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
        {appInfo && (
          <p className="settings-version">
            Version {appInfo.version} (build {appInfo.build})
            {appInfo.id?.endsWith('.dev') ? ' · Test build' : ''}
          </p>
        )}

        <div className="section-title">Data backup</div>
        <p className="settings-desc">
          A fresh snapshot is saved automatically every time you open the app, so there's always a
          very recent one to fall back on before trying an update or anything risky - no action
          needed. Android also backs your data up in the background on its own schedule (Settings ›
          Google › Backup), which is what lets a snapshot survive a full reinstall. Use the buttons
          below any time you want an on-demand copy instead - moving to a new phone, sharing it
          somewhere, or just for peace of mind.
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

        {Capacitor.isNativePlatform() && (
          <>
            <div className="section-title">Recent local backups</div>
            {autoBackups.length === 0 ? (
              <p className="settings-desc">
                No automatic snapshots yet - one is saved the next time you open the app.
              </p>
            ) : (
              <ul className="auto-backup-list">
                {autoBackups.map((name) => (
                  <li key={name} className="auto-backup-row">
                    <History size={15} />
                    <span className="auto-backup-when">{formatAutoBackupName(name)}</span>
                    <button
                      type="button"
                      className="auto-backup-restore-btn"
                      onClick={() => handleRestoreAutoBackup(name)}
                      disabled={restoringName === name}
                    >
                      {restoringName === name ? 'Restoring…' : 'Restore'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="section-title">Import from AI</div>
        <p className="settings-desc">
          Ask ChatGPT (or any AI chat) to generate a routine, copy the prompt below into it first
          so it knows the exact shape to output, then paste its JSON reply back in here. This adds
          new routines alongside what's already in the app - it never replaces or overwrites
          anything.
        </p>

        <div className="settings-actions">
          <button type="button" className="settings-action-btn" onClick={handleCopyPrompt}>
            {promptCopied ? <Check size={16} /> : <Clipboard size={16} />}
            {promptCopied ? 'Prompt copied' : 'Copy AI prompt'}
          </button>
        </div>

        <textarea
          className="ai-import-textarea"
          placeholder="Paste the AI's JSON reply here…"
          value={aiImportText}
          onChange={(e) => setAiImportText(e.target.value)}
          rows={6}
        />

        <div className="settings-actions">
          <button
            type="button"
            className="settings-action-btn"
            onClick={handleAiImportSubmit}
            disabled={aiImportStatus === 'importing' || !aiImportText.trim()}
          >
            <Sparkles size={16} className={aiImportStatus === 'importing' ? 'spin' : ''} />
            Import
          </button>
        </div>

        {aiImportStatus === 'done' && (
          <p className="settings-status success">
            Imported {aiImportCount} {aiImportCount === 1 ? 'routine' : 'routines'}.
          </p>
        )}
        {aiImportStatus === 'error' && <p className="settings-status error ai-import-error">{aiImportError}</p>}
        {aiImportNotes.length > 0 && (
          <ul className="ai-import-notes">
            {aiImportNotes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
