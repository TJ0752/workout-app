import { Check } from 'lucide-react';
import { isDueToday, todayKey } from '../utils/date';
import { getRoutineIcon } from '../utils/icons';

export default function TodayView({ routines, completions, onToggleComplete }) {
  const key = todayKey();
  const dueToday = routines.filter(isDueToday);
  const doneCount = dueToday.filter((r) => completions[r.id]?.[key]).length;

  return (
    <div className="today-view">
      <div className="today-summary">
        <h2>Today</h2>
        <p>
          {doneCount} / {dueToday.length} completed
        </p>
      </div>

      {dueToday.length === 0 && <p className="empty-state">No routines scheduled for today.</p>}

      <ul className="today-list">
        {dueToday.map((routine) => {
          const done = Boolean(completions[routine.id]?.[key]);
          const RoutineIcon = getRoutineIcon(routine);
          return (
            <li key={routine.id} className={`today-item ${done ? 'done' : ''}`}>
              <label>
                <input
                  type="checkbox"
                  checked={done}
                  onChange={() => onToggleComplete(routine, !done)}
                />
                <span className="icon-badge">
                  <RoutineIcon size={18} />
                </span>
                <span className="today-item-title">{routine.title}</span>
                <span className="today-item-time">{routine.time}</span>
                <span className={`check-circle ${done ? 'done' : ''}`}>
                  {done && <Check size={15} />}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
