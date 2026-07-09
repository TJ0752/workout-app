import { useEffect, useState } from 'react';
import { List, X } from 'lucide-react';
import { parseQuickAddText, MAX_EXTRA_REMINDERS, formatHms, hmsToSeconds, secondsToHms } from '../utils/tasks';
import { DAY_LABELS } from '../utils/date';
import { ICON_OPTIONS, suggestIconId } from '../utils/icons';
import { generateId } from '../utils/id';
import { getExerciseNames } from '../storage';
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
    quantityMode: 'number',
    autoUpdateTarget: false,
    exercises: [],
    active: true,
    createdAt: new Date().toISOString(),
  };
}

function makeExercise() {
  return {
    id: generateId(),
    name: '',
    type: 'weights',
    targetSets: 3,
    targetReps: 10,
    targetDurationSeconds: null,
    unit: 'reps',
    restSeconds: null,
  };
}

// Exercises saved before this field existed have no `type` at all - treating anything other
// than an explicit 'calisthenics' as weighted preserves their old behavior exactly (the weight
// input used to always show), rather than needing a one-time backfill/migration.
function isCalisthenics(exercise) {
  return exercise.type === 'calisthenics';
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

/**
 * Every timer-related target in the app (exercise duration, quantity-as-timer) is set up through
 * this shared hours/minutes/seconds triplet instead of a single raw-seconds field - much easier
 * to enter a real-world duration like "10 minutes" than to do the mental math to 600. Storage/
 * versioning is untouched by this: task.target and exercise.targetDurationSeconds still hold a
 * single total-seconds number either way (see utils/tasks.js's hmsToSeconds/secondsToHms), so no
 * schema change was needed to support this input style.
 */
function DurationHMSInput({ totalSeconds, onChange, label }) {
  const { hours, minutes, seconds } = secondsToHms(totalSeconds);

  const update = (patch) => {
    const next = { hours, minutes, seconds, ...patch };
    const combined = hmsToSeconds(next.hours, next.minutes, next.seconds);
    onChange(combined || null);
  };

  return (
    <div className="hms-input">
      {label && <span className="field-label">{label}</span>}
      <div className="hms-input-row">
        <label className="hms-part">
          <input
            type="number"
            min="0"
            placeholder="0"
            value={hours || ''}
            onChange={(e) => update({ hours: e.target.value ? Number(e.target.value) : 0 })}
          />
          <span>h</span>
        </label>
        <label className="hms-part">
          <input
            type="number"
            min="0"
            max="59"
            placeholder="0"
            value={minutes || ''}
            onChange={(e) => update({ minutes: e.target.value ? Number(e.target.value) : 0 })}
          />
          <span>m</span>
        </label>
        <label className="hms-part">
          <input
            type="number"
            min="0"
            max="59"
            placeholder="0"
            value={seconds || ''}
            onChange={(e) => update({ seconds: e.target.value ? Number(e.target.value) : 0 })}
          />
          <span>s</span>
        </label>
      </div>
    </div>
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

function ExercisePickerModal({ exerciseNames, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed ? exerciseNames.filter((ex) => ex.name.toLowerCase().includes(trimmed)) : exerciseNames;

  return (
    <div className="day-drilldown-overlay" onClick={onClose}>
      <div className="day-drilldown-panel" onClick={(e) => e.stopPropagation()}>
        <div className="day-drilldown-header">
          <strong>Exercise repository</strong>
          <button type="button" className="day-drilldown-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <input
          type="text"
          className="exercise-picker-search"
          placeholder="Search exercises…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {exerciseNames.length === 0 ? (
          <p className="empty-state">No exercises logged yet — type a name to create the first one.</p>
        ) : filtered.length === 0 ? (
          <p className="empty-state">No matches.</p>
        ) : (
          <ul className="exercise-picker-list">
            {filtered.map((ex) => (
              <li key={ex.id}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    // Selecting here (not onClick) keeps focus on the search input above
                    // instead of momentarily moving it to this button - when the whole modal
                    // then unmounts, that avoids the browser reassigning focus onto the
                    // exercise name input behind it, which would otherwise reopen its own
                    // autosuggest dropdown via its onFocus handler.
                    e.preventDefault();
                    onSelect(ex);
                  }}
                >
                  {ex.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ExerciseNameInput({ value, exerciseNames, onChange, onSelectExisting }) {
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const trimmed = value.trim().toLowerCase();
  const suggestions = trimmed
    ? exerciseNames.filter((ex) => ex.name.toLowerCase().includes(trimmed)).slice(0, 6)
    : [];

  return (
    <div className="exercise-name-autosuggest">
      <div className="exercise-name-row">
        <input
          type="text"
          placeholder="e.g. Push-ups"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        <button
          type="button"
          className="exercise-browse-btn"
          onClick={() => {
            setOpen(false);
            setPickerOpen(true);
          }}
          aria-label="Browse exercise repository"
          title="Browse exercise repository"
        >
          <List size={16} />
        </button>
      </div>
      {open && suggestions.length > 0 && (
        <ul className="autosuggest-list">
          {suggestions.map((match) => (
            <li
              key={match.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelectExisting(match);
                setOpen(false);
              }}
            >
              {match.name}
            </li>
          ))}
        </ul>
      )}
      {pickerOpen && (
        <ExercisePickerModal
          exerciseNames={exerciseNames}
          onSelect={(match) => {
            onSelectExisting(match);
            setOpen(false);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function ExerciseListEditor({ task, onChange, exerciseNames }) {
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
                <ExerciseNameInput
                  value={ex.name}
                  exerciseNames={exerciseNames}
                  onChange={(name) => updateExercise(ex.id, { name, exerciseId: null })}
                  onSelectExisting={(match) => updateExercise(ex.id, { name: match.name, exerciseId: match.id })}
                />
              </label>
              <button type="button" className="task-edit-icon-btn" onClick={() => removeExercise(ex.id)}>
                Delete
              </button>
            </div>
            <div className="type-toggle">
              <button
                type="button"
                className={!isCalisthenics(ex) ? 'active' : ''}
                onClick={() => updateExercise(ex.id, { type: 'weights' })}
              >
                Weights
              </button>
              <button
                type="button"
                className={isCalisthenics(ex) ? 'active' : ''}
                onClick={() => updateExercise(ex.id, { type: 'calisthenics' })}
              >
                Calisthenics
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
                <DurationHMSInput
                  label="Duration/set"
                  totalSeconds={ex.targetDurationSeconds}
                  onChange={(secs) => updateExercise(ex.id, { targetDurationSeconds: secs })}
                />
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

function TaskFields({ task, onChange, showTitle, exerciseNames }) {
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
            onClick={() =>
              onChange({
                ...task,
                completionType: 'quantity',
                target: task.target ?? 10,
                quantityMode: task.quantityMode || 'number',
              })
            }
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
          <div>
            <span className="field-label">Input as</span>
            <div className="type-toggle">
              <button
                type="button"
                className={task.quantityMode !== 'timer' ? 'active' : ''}
                onClick={() => onChange({ ...task, quantityMode: 'number', target: null })}
              >
                Number
              </button>
              <button
                type="button"
                className={task.quantityMode === 'timer' ? 'active' : ''}
                onClick={() => onChange({ ...task, quantityMode: 'timer', target: null, unit: null, quickAdd: null })}
              >
                Timer
              </button>
            </div>
          </div>
          {task.quantityMode === 'timer' ? (
            <>
              <DurationHMSInput
                label="Target duration"
                totalSeconds={task.target}
                onChange={(secs) => onChange({ ...task, target: secs })}
              />
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={Boolean(task.autoUpdateTarget)}
                  onChange={(e) => onChange({ ...task, autoUpdateTarget: e.target.checked })}
                />
                Auto-update target to new best
              </label>
              <p className="field-hint">
                When on, logging a time longer than the current target raises the target to that
                new best for next time.
              </p>
            </>
          ) : (
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
        </>
      )}
      {task.completionType === 'workout' && (
        <ExerciseListEditor task={task} onChange={onChange} exerciseNames={exerciseNames} />
      )}
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
  const [exerciseNames, setExerciseNames] = useState([]);

  useEffect(() => {
    getExerciseNames()
      .then(setExerciseNames)
      .catch(() => {});
  }, []);

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
          <TaskFields task={tasks[0]} onChange={updateTask} showTitle={false} exerciseNames={exerciseNames} />
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
                  <TaskFields task={task} onChange={updateTask} showTitle exerciseNames={exerciseNames} />
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
                        (task.quantityMode === 'timer'
                          ? `Target ${task.target ? formatHms(task.target) : '?'}`
                          : `Target ${task.target ?? '?'} ${task.unit || ''}`)}
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
