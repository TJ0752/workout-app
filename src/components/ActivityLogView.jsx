import { useEffect, useState } from 'react';
import { getAllVersions } from '../storage';

function describeChange(entry) {
  const kind = entry.kind === 'routine' ? 'Routine' : 'Task';
  switch (entry.changeType) {
    case 'created':
      return `${kind} "${entry.title}" created`;
    case 'migrated':
      return `${kind} "${entry.title}" existed`;
    case 'paused':
      return `${kind} "${entry.title}" paused`;
    case 'resumed':
      return `${kind} "${entry.title}" resumed`;
    case 'deleted':
      return `${kind} "${entry.title}" deleted`;
    case 'updated':
      return `${kind} "${entry.title}" updated (${entry.changedFields.join(', ')})`;
    default:
      return `${kind} "${entry.title}" changed`;
  }
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function ActivityLogView({ routineId }) {
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    getAllVersions().then((all) => {
      setEntries(routineId ? all.filter((e) => e.routineId === routineId) : all);
    });
  }, [routineId]);

  if (entries === null) return <p className="empty-state">Loading…</p>;
  if (entries.length === 0) return <p className="empty-state">No changes recorded yet.</p>;

  return (
    <ul className="today-list">
      {entries.map((entry) => (
        <li key={entry.id} className="today-item">
          <div style={{ fontWeight: 600, fontSize: '0.9em' }}>{describeChange(entry)}</div>
          <div style={{ color: 'var(--text-soft)', fontSize: '0.78em', marginTop: '0.2rem' }}>
            {formatDate(entry.effectiveFrom)}
          </div>
        </li>
      ))}
    </ul>
  );
}
