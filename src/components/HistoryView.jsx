import { Flame } from 'lucide-react';
import { calcStreak, calcCompletionRate, dateToKey, isDueOn, lastNDates, todayKey } from '../utils/date';
import { getRoutineIcon } from '../utils/icons';

const HISTORY_DAYS = 14;

export default function HistoryView({ routines, completions }) {
  const days = lastNDates(HISTORY_DAYS);

  if (routines.length === 0) {
    return <p className="empty-state">Add a routine to start tracking history.</p>;
  }

  return (
    <div className="history-view">
      {routines.map((routine) => {
        const done = completions[routine.id] || {};
        const streak = calcStreak(routine, completions);
        const rate = calcCompletionRate(routine, completions);
        const RoutineIcon = getRoutineIcon(routine);
        return (
          <div key={routine.id} className="history-card">
            <div className="history-header">
              <div className="history-header-title">
                <span className="icon-badge">
                  <RoutineIcon size={16} />
                </span>
                <strong>{routine.title}</strong>
              </div>
              <span>
                <Flame size={12} /> {streak}d · {rate}% (30d)
              </span>
            </div>
            <div className="history-grid">
              {days.map((date) => {
                const key = dateToKey(date);
                const due = isDueOn(routine, date);
                const completed = Boolean(done[key]);
                let cls = 'history-cell';
                if (!due) cls += ' not-due';
                else if (completed) cls += ' completed';
                else if (key === todayKey()) cls += ' pending';
                else cls += ' missed';
                return (
                  <div key={key} className={cls} title={`${key}${due ? (completed ? ' - done' : ' - missed') : ' - not scheduled'}`}>
                    {date.getDate()}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
