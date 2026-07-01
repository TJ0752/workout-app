import { useState } from 'react';
import { DAY_LABELS } from '../utils/date';

const emptyForm = { title: '', time: '08:00', days: [1, 2, 3, 4, 5], notes: '' };

export default function RoutineForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState(initial ? { ...initial } : emptyForm);

  const toggleDay = (day) => {
    setForm((f) => ({
      ...f,
      days: f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day].sort(),
    }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.title.trim() || form.days.length === 0) return;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      title: form.title.trim(),
      time: form.time,
      days: form.days,
      notes: form.notes.trim(),
      active: initial?.active ?? true,
      createdAt: initial?.createdAt ?? new Date().toISOString(),
    });
  };

  return (
    <form className="routine-form" onSubmit={handleSubmit}>
      <label>
        Routine name
        <input
          type="text"
          placeholder="e.g. Morning stretch"
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          required
        />
      </label>

      <label>
        Reminder time
        <input
          type="time"
          value={form.time}
          onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
          required
        />
      </label>

      <div className="day-picker">
        <span className="field-label">Repeat on</span>
        <div className="day-buttons">
          {DAY_LABELS.map((label, idx) => (
            <button
              type="button"
              key={label}
              className={`day-chip ${form.days.includes(idx) ? 'selected' : ''}`}
              onClick={() => toggleDay(idx)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <label>
        Notes (optional)
        <input
          type="text"
          placeholder="Reminder message"
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </label>

      {form.days.length === 0 && <p className="form-error">Pick at least one day.</p>}

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
