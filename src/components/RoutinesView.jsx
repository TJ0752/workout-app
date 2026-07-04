import { useState } from 'react';
import RoutineForm from './RoutineForm';
import { DAY_LABELS, calcRoutineCompletionRate } from '../utils/date';
import { getRoutineIcon } from '../utils/icons';

export default function RoutinesView({
  routines,
  completions,
  taskVersionsMap,
  onSaveRoutine,
  onDeleteRoutine,
  onToggleRoutineActive,
  onToggleTaskActive,
}) {
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

  const handleSave = async (payload) => {
    await onSaveRoutine(payload);
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
          const isSimple = routine.tasks.length === 1;
          const completionRate = routine.active
            ? calcRoutineCompletionRate(routine, taskVersionsMap, completions)
            : null;
          return (
            <li key={routine.id} className={`routine-card ${routine.active ? '' : 'inactive'}`}>
              <span className="icon-badge">
                <RoutineIcon size={18} />
              </span>
              <div className="routine-card-body">
                <div className="routine-card-main">
                  <strong>{routine.title}</strong>
                  {isSimple && <span className="routine-time">{routine.tasks[0]?.time}</span>}
                </div>
                <div className="routine-days">
                  {isSimple
                    ? routine.tasks[0]?.days.map((d) => DAY_LABELS[d]).join(', ')
                    : `${routine.tasks.length} tasks`}
                </div>
                {completionRate !== null && <span className="routine-rate-chip">{completionRate}% this month</span>}
                {routine.notes && <div className="routine-notes">{routine.notes}</div>}

                {!isSimple && (
                  <ul className="task-list">
                    {routine.tasks.map((task) => (
                      <li className="task-row" key={task.id}>
                        <span className="dot" />
                        <span className="task-title" style={!task.active ? { opacity: 0.5 } : undefined}>
                          {task.title}
                          {!task.active ? ' (paused)' : ''}
                        </span>
                        <span className="task-time">{task.time}</span>
                        <button
                          type="button"
                          className="task-edit-icon-btn"
                          onClick={() => onToggleTaskActive(task)}
                          title={task.active ? 'Pause task' : 'Resume task'}
                        >
                          {task.active ? 'Pause' : 'Resume'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="routine-actions">
                  <button onClick={() => startEdit(routine)}>Edit</button>
                  <button onClick={() => onToggleRoutineActive(routine)}>
                    {routine.active ? 'Pause' : 'Resume'}
                  </button>
                  <button className="danger" onClick={() => onDeleteRoutine(routine)}>
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
