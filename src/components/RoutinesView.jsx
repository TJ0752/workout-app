import { useState } from 'react';
import RoutineForm from './RoutineForm';
import { DAY_LABELS } from '../utils/date';
import { getRoutineIcon } from '../utils/icons';

export default function RoutinesView({ routines, onAdd, onUpdate, onDelete, onToggleActive }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);

  const startEdit = (routine) => {
    setEditing(routine);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
  };

  const handleSave = (routine) => {
    if (editing) {
      onUpdate(routine);
    } else {
      onAdd(routine);
    }
    closeForm();
  };

  return (
    <div className="routines-view">
      {!showForm && (
        <button className="add-btn" onClick={() => setShowForm(true)}>
          + Add routine
        </button>
      )}

      {showForm && <RoutineForm initial={editing} onSave={handleSave} onCancel={closeForm} />}

      {routines.length === 0 && !showForm && (
        <p className="empty-state">No routines yet. Add your first one above.</p>
      )}

      <ul className="routine-list">
        {routines.map((routine) => {
          const RoutineIcon = getRoutineIcon(routine);
          return (
            <li key={routine.id} className={`routine-card ${routine.active ? '' : 'inactive'}`}>
              <span className="icon-badge">
                <RoutineIcon size={18} />
              </span>
              <div className="routine-card-body">
                <div className="routine-card-main">
                  <strong>{routine.title}</strong>
                  <span className="routine-time">{routine.time}</span>
                </div>
                <div className="routine-days">
                  {routine.days.map((d) => DAY_LABELS[d]).join(', ')}
                </div>
                {routine.notes && <div className="routine-notes">{routine.notes}</div>}
                <div className="routine-actions">
                  <button onClick={() => startEdit(routine)}>Edit</button>
                  <button onClick={() => onToggleActive(routine)}>
                    {routine.active ? 'Pause' : 'Resume'}
                  </button>
                  <button className="danger" onClick={() => onDelete(routine)}>
                    Delete
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
