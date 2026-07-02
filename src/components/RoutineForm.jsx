import { useState } from 'react';
import { parseQuickAddText, MAX_EXTRA_REMINDERS } from '../utils/tasks';
import { DAY_LABELS } from '../utils/date';
import { ICON_OPTIONS, suggestIconId } from '../utils/icons';
import { generateId } from '../utils/id';
import ActivityLogView from './ActivityLogView';

function toggleDay(days, day) {
  return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
}

function makeTask(days) {
  return {
    id: generateId(),
    title: '',
    time: '08:00',
    windowStart: '00:00',
    reminderTimes: [],
    days: [...days],
    completionType: 'boolean',
    target: null,
    unit: null,
    quickAdd: null,
    exercises: [],
    active: true,
    createdAt: new Date().toISOString(),
  };
}

function makeExercise() {
  return {
    id: generateId(),
    name: '',
    targetSets: 3,
    targetReps: 10,
    targetWeight: null,
    targetDurationSeconds: null,
    unit: 'reps',
    restSeconds: null,
  };
}

function QuickAddInput({ task, onChange }) {
  const [text, setText] = useState(() => task.quickAdd?.join(', ') ?? '');

  const handleChange = (value) => {
    setText(value);
    const nums = parseQuickAddText(value);
    onChange({ ...task, quickAdd: nums.length ? nums : null });
  };

  return (
    <label>
      Quick-add amounts (optional)
      <input
        type="text"
        inputMode="numeric"
        placeholder="e.g. 10, 25"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
      />
    </label>
  );
}

function ReminderTimesEditor({ task, onChange }) {
  const [draft, setDraft] = useState('12:00');
  const times = task.reminderTimes || [];
  const atLimit = times.length >= MAX_EXTRA_REMINDERS;

  const addTime = () => {
    if (!draft || atLimit || times.includes(draft) || draft === task.time) return;
    onChange({ ...task, reminderTimes: [...times, draft].sort() });
  };

  const removeTime = (t) => {
    onChange({ ...task, reminderTimes: times.filter((x) => x !== t) });
  };

  return (
    <div>
      <span className="field-label">Extra reminders (optional)</span>
      {times.length > 0 && (
        <div className="day-buttons">
          {times.map((t) => (
            <button type="button" key={t} className="day-chip selected" onClick={() => removeTime(t)} title="Remove">
              {t} ×
            </button>
          ))}
        </div>
      )}
      {!atLimit && (
        <div className="reminder-row">
          <input type="time" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="button" onClick={addTime}>
            + Add reminder
          </button>
        </div>
      )}
    </div>
  );
}

function ExerciseListEditor({ task, onChange }) {
  const exercises = task.exercises || [];

  const updateExercise = (id, patch) => {
    onChange({ ...task, exercises: exercises.map((ex) => (ex.id === id ? { ...ex, ...patch } : ex)) });
  };

  const addExercise = () => {
    onChange({ ...task, exercises: [...exercises, makeExercise()] });
  };

  const removeExercise = (id) => {
    onChange({ ...task, exercises: exercises.filter((ex) => ex.id !== id) });
  };

  return (
    <div>
      <span className="field-label">Exercises</span>
      <div className="task-edit-list">
        {exercises.map((ex) => (
          <div className="form-card" key={ex.id}>
            <div className="inline-fields">
              <label>
                Exercise name
                <input
                  type="text"
                  placeholder="e.g. Push-ups"
                  value={ex.name}
                  onChange={(e) => updateExercise(ex.id, { name: e.target.value })}
                />
              </label>
              <button type="button" className="task-edit-icon-btn" onClick={() => removeExercise(ex.id)}>
                Delete
              </button>
            </div>
            <div className="type-toggle">
              <button
                type="button"
                className={ex.unit !== 'seconds' ? 'active' : ''}
                onClick={() =>
                  updateExercise(ex.id, { unit: 'reps', targetDurationSeconds: null, targetReps: ex.targetReps ?? 10 })
                }
              >
                Reps
              </button>
              <button
                type="button"
                className={ex.unit === 'seconds' ? 'active' : ''}
                onClick={() =>
                  updateExercise(ex.id, {
                    unit: 'seconds',
                    targetReps: null,
                    targetDurationSeconds: ex.targetDurationSeconds ?? 30,
                  })
                }
              >
                Duration
              </button>
            </div>
            <div className="inline-fields">
              <label>
                Sets
                <input
                  type="number"
                  min="1"
                  value={ex.targetSets ?? ''}
                  onChange={(e) =>
                    updateExercise(ex.id, { targetSets: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </label>
              {ex.unit === 'seconds' ? (
                <label>
                  Duration/set (sec)
                  <input
                    type="number"
                    min="1"
                    value={ex.targetDurationSeconds ?? ''}
                    onChange={(e) =>
                      updateExercise(ex.id, {
                        targetDurationSeconds: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </label>
              ) : (
                <label>
                  Reps/set
                  <input
                    type="number"
                    min="1"
                    value={ex.targetReps ?? ''}
                    onChange={(e) =>
                      updateExercise(ex.id, { targetReps: e.target.value ? Number(e.target.value) : null })
                    }
                  />
                </label>
              )}
            </div>
            <div className="inline-fields">
              <label>
                Weight (optional)
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={ex.targetWeight ?? ''}
                  onChange={(e) =>
                    updateExercise(ex.id, { targetWeight: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </label>
              <label>
                Rest between sets, sec (optional)
                <input
                  type="number"
                  min="0"
                  value={ex.restSeconds ?? ''}
                  onChange={(e) =>
                    updateExercise(ex.id, { restSeconds: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </label>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="add-task-btn" onClick={addExercise}>
        + Add exercise
      </button>
    </div>
  );
}

function DayPicker({ days, onChange }) {
  return (
    <div className="day-buttons">
      {DAY_LABELS.map((label, idx) => (
        <button
          type="button"
          key={label}
          className={`day-chip ${days.includes(idx) ? 'selected' : ''}`}
          onClick={() => onChange(toggleDay(days, idx))}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TaskFields({ task, onChange, showTitle }) {
  return (
    <>
      {showTitle && (
        <label>
          Task name
          <input
            type="text"
            placeholder="e.g. Breakfast"
            value={task.title}
            onChange={(e) => onChange({ ...task, title: e.target.value })}
          />
        </label>
      )}
      <div className="inline-fields">
        <label>
          Starts at
          <input
            type="time"
            value={task.windowStart ?? '00:00'}
            onChange={(e) => onChange({ ...task, windowStart: e.target.value })}
          />
        </label>
        <label>
          Due by
          <input type="time" value={task.time} onChange={(e) => onChange({ ...task, time: e.target.value })} />
        </label>
      </div>
      <ReminderTimesEditor task={task} onChange={onChange} />
      <div>
        <span className="field-label">Repeat on</span>
        <DayPicker days={task.days} onChange={(days) => onChange({ ...task, days })} />
      </div>
      <div>
        <span className="field-label">Completion type</span>
        <div className="type-toggle">
          <button
            type="button"
            className={task.completionType === 'boolean' ? 'active' : ''}
            onClick={() => onChange({ ...task, completionType: 'boolean', target: null, unit: null, quickAdd: null })}
          >
            Yes / No
          </button>
          <button
            type="button"
            className={task.completionType === 'quantity' ? 'active' : ''}
            onClick={() => onChange({ ...task, completionType: 'quantity', target: task.target ?? 10 })}
          >
            Quantity target
          </button>
          <button
            type="button"
            className={task.completionType === 'workout' ? 'active' : ''}
            onClick={() =>
              onChange({
                ...task,
                completionType: 'workout',
                target: null,
                unit: null,
                quickAdd: null,
                exercises: task.exercises?.length ? task.exercises : [],
              })
            }
          >
            Workout
          </button>
        </div>
      </div>
      {task.completionType === 'quantity' && (
        <>
          <div className="inline-fields">
            <label>
              Target
              <input
                type="number"
                min="1"
                value={task.target ?? ''}
                onChange={(e) => onChange({ ...task, target: e.target.value ? Number(e.target.value) : null })}
              />
            </label>
            <label>
              Unit (optional)
              <input
                type="text"
                placeholder="reps, pages…"
                value={task.unit ?? ''}
                onChange={(e) => onChange({ ...task, unit: e.target.value })}
              />
            </label>
          </div>
          <QuickAddInput task={task} onChange={onChange} />
        </>
      )}
      {task.completionType === 'workout' && <ExerciseListEditor task={task} onChange={onChange} />}
    </>
  );
}

export default function RoutineForm({ initial, onSave, onCancel }) {
  const [routine, setRoutine] = useState(() =>
    initial
      ? {
          id: initial.id,
          title: initial.title,
          icon: initial.icon,
          notes: initial.notes,
          defaultDays: initial.defaultDays,
          createdAt: initial.createdAt,
          active: initial.active,
        }
      : {
          id: generateId(),
          title: '',
          icon: null,
          notes: '',
          defaultDays: [1, 2, 3, 4, 5],
          createdAt: new Date().toISOString(),
          active: true,
        }
  );
  const [tasks, setTasks] = useState(() =>
    initial && initial.tasks.length > 0 ? initial.tasks.map((t) => ({ ...t })) : [makeTask(routine.defaultDays)]
  );
  const [deletedTaskIds, setDeletedTaskIds] = useState([]);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const isSimple = tasks.length === 1;
  const autoIconId = suggestIconId(routine.title);

  const updateTask = (updated) => {
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  };

  const addTask = () => {
    const newTask = makeTask(routine.defaultDays);
    setTasks((prev) => {
      if (prev.length === 1 && !prev[0].title.trim()) {
        return [{ ...prev[0], title: routine.title }, newTask];
      }
      return [...prev, newTask];
    });
    setEditingTaskId(newTask.id);
  };

  const removeTask = (taskId) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    if (initial?.tasks.some((t) => t.id === taskId)) {
      setDeletedTaskIds((prev) => [...prev, taskId]);
    }
    if (editingTaskId === taskId) setEditingTaskId(null);
  };

  const hasUnnamedTask = !isSimple && tasks.some((t) => !t.title.trim());
  const hasTaskWithNoDays = tasks.some((t) => t.days.length === 0);
  const hasInvalidWorkout = tasks.some(
    (t) =>
      t.completionType === 'workout' &&
      (!t.exercises?.length || t.exercises.some((ex) => !ex.name.trim()))
  );
  const invalidTask = hasUnnamedTask || hasTaskWithNoDays || hasInvalidWorkout;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!routine.title.trim() || tasks.length === 0 || invalidTask) return;

    const finalTasks = tasks.map((t) => ({
      ...t,
      title: isSimple ? routine.title.trim() : t.title.trim(),
      routineId: routine.id,
      exercises:
        t.completionType === 'workout' ? t.exercises.map((ex) => ({ ...ex, name: ex.name.trim() })) : [],
    }));

    onSave({
      routine: { ...routine, title: routine.title.trim(), notes: routine.notes.trim() },
      tasks: finalTasks,
      deletedTaskIds,
    });
  };

  return (
    <form className="routine-form" onSubmit={handleSubmit}>
      <label>
        Routine name
        <input
          type="text"
          placeholder="e.g. Morning stretch"
          value={routine.title}
          onChange={(e) => setRoutine((r) => ({ ...r, title: e.target.value }))}
          required
        />
      </label>

      <div className="icon-picker">
        <span className="field-label">Icon</span>
        <div className="icon-buttons">
          <button
            type="button"
            className={`icon-chip ${!routine.icon ? 'selected' : ''}`}
            onClick={() => setRoutine((r) => ({ ...r, icon: null }))}
            title="Auto"
          >
            {(() => {
              const AutoIcon = ICON_OPTIONS.find((o) => o.id === autoIconId)?.Icon;
              return AutoIcon ? <AutoIcon size={18} /> : null;
            })()}
          </button>
          {ICON_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.id}
              className={`icon-chip ${routine.icon === option.id ? 'selected' : ''}`}
              onClick={() => setRoutine((r) => ({ ...r, icon: option.id }))}
              title={option.label}
            >
              <option.Icon size={18} />
            </button>
          ))}
        </div>
      </div>

      {isSimple ? (
        <>
          <TaskFields task={tasks[0]} onChange={updateTask} showTitle={false} />
          <button type="button" className="add-task-btn" onClick={addTask}>
            + Add another task
          </button>
        </>
      ) : (
        <div>
          <span className="section-title">Tasks ({tasks.length})</span>
          <div className="task-edit-list">
            {tasks.map((task) =>
              editingTaskId === task.id ? (
                <div className="form-card" key={task.id}>
                  <TaskFields task={task} onChange={updateTask} showTitle />
                  <div className="inline-fields">
                    <button type="button" style={{ flex: 1 }} onClick={() => setEditingTaskId(null)}>
                      Done
                    </button>
                    <button type="button" className="danger" onClick={() => removeTask(task.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ) : (
                <div className="task-edit-row" key={task.id}>
                  <div className="task-edit-info">
                    <div className="name">{task.title || '(untitled task)'}</div>
                    <div className="meta">
                      {task.time} · {task.days.length === 7 ? 'Every day' : `${task.days.length}/week`} ·{' '}
                      {task.completionType === 'quantity' &&
                        `Target ${task.target ?? '?'} ${task.unit || ''}`}
                      {task.completionType === 'workout' &&
                        `${task.exercises?.length ?? 0} exercise${task.exercises?.length === 1 ? '' : 's'}`}
                      {task.completionType === 'boolean' && 'Yes/No'}
                      {!task.active ? ' · Paused' : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="task-edit-icon-btn"
                    onClick={() => updateTask({ ...task, active: !task.active })}
                  >
                    {task.active ? 'Pause' : 'Resume'}
                  </button>
                  <button type="button" className="task-edit-icon-btn" onClick={() => setEditingTaskId(task.id)}>
                    Edit
                  </button>
                  <button type="button" className="task-edit-icon-btn" onClick={() => removeTask(task.id)}>
                    Delete
                  </button>
                </div>
              )
            )}
          </div>
          <button type="button" className="add-task-btn" onClick={addTask}>
            + Add task
          </button>
        </div>
      )}

      {hasUnnamedTask && <p className="form-error">Every task needs a name.</p>}
      {hasTaskWithNoDays && <p className="form-error">Every task needs at least one day selected.</p>}
      {hasInvalidWorkout && (
        <p className="form-error">Every workout task needs at least one named exercise.</p>
      )}

      <label>
        Notes (optional)
        <input
          type="text"
          placeholder="Reminder message"
          value={routine.notes}
          onChange={(e) => setRoutine((r) => ({ ...r, notes: e.target.value }))}
        />
      </label>

      {initial && (
        <div>
          <button type="button" className="add-task-btn" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide history' : 'View history'}
          </button>
          {showHistory && <ActivityLogView routineId={initial.id} />}
        </div>
      )}

      <div className="form-actions">
        <button type="submit" className="primary">
          {initial ? 'Save changes' : 'Add routine'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
