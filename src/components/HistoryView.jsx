import { useState } from 'react';
import { Flame } from 'lucide-react';
import { calcRoutineStreak, calcRoutineCompletionRate, dateToKey, getTaskFraction, lastNDates, todayKey } from '../utils/date';
import { getRoutineIcon } from '../utils/icons';
import ActivityLogView from './ActivityLogView';

const HISTORY_DAYS = 14;

function TaskHistoryCard(props) {
  const { title, task, versions, completions, routine, taskVersionsMap } = props;
  const days = lastNDates(HISTORY_DAYS);
  const taskCompletions = completions[task.id] || {};
  const soloRoutine = { ...routine, tasks: [task] };
  const streak = calcRoutineStreak(soloRoutine, taskVersionsMap, completions);
  const rate = calcRoutineCompletionRate(soloRoutine, taskVersionsMap, completions, 30);

  return (
    <div className="history-card">
      <div className="history-header">
        <div className="history-header-title">
          <span className="icon-badge">
            <props.Icon size={16} />
          </span>
          <strong>{title}</strong>
        </div>
        <span>
          <Flame size={12} /> {streak}d · {rate}% (30d)
        </span>
      </div>
      <div className="history-grid">
        {days.map((date) => {
          const key = dateToKey(date);
          const fraction = getTaskFraction(versions, taskCompletions, date);
          let cls = 'history-cell';
          if (fraction === null) cls += ' not-due';
          else if (key === todayKey()) cls += ' pending';
          else if (fraction === 1) cls += ' completed';
          else if (fraction > 0) cls += ' partial';
          else cls += ' missed';
          return (
            <div key={key} className={cls} title={key}>
              {date.getDate()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function HistoryView({ routines, completions, taskVersionsMap }) {
  const [view, setView] = useState('completions');

  return (
    <div className="history-view">
      <div className="range-toggle">
        <button className={view === 'completions' ? 'active' : ''} onClick={() => setView('completions')}>
          Completions
        </button>
        <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}>
          Activity Log
        </button>
      </div>

      {view === 'activity' ? (
        <ActivityLogView />
      ) : routines.length === 0 ? (
        <p className="empty-state">Add a routine to start tracking history.</p>
      ) : (
        routines.map((routine) => {
          const RoutineIcon = getRoutineIcon(routine);
          if (routine.tasks.length === 1) {
            const task = routine.tasks[0];
            const versions = taskVersionsMap[task.id];
            if (!versions) return null;
            return (
              <TaskHistoryCard
                key={task.id}
                title={routine.title}
                Icon={RoutineIcon}
                task={task}
                versions={versions}
                completions={completions}
                routine={routine}
                taskVersionsMap={taskVersionsMap}
              />
            );
          }
          return (
            <div key={routine.id}>
              <div className="section-title">{routine.title}</div>
              {routine.tasks.map((task) => {
                const versions = taskVersionsMap[task.id];
                if (!versions) return null;
                return (
                  <TaskHistoryCard
                    key={task.id}
                    title={task.title}
                    Icon={RoutineIcon}
                    task={task}
                    versions={versions}
                    completions={completions}
                    routine={routine}
                    taskVersionsMap={taskVersionsMap}
                  />
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}
