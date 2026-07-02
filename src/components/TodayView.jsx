import { useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { getRoutineFraction, getTaskFraction, todayKey } from '../utils/date';
import { getRoutineIcon } from '../utils/icons';
import { quickAddAmountsFor } from '../utils/tasks';

function isTaskDueToday(task, taskVersionsMap) {
  const versions = taskVersionsMap[task.id];
  if (!versions) return false;
  return getTaskFraction(versions, {}, new Date()) !== null;
}

function atTime(now, timeStr) {
  const [hour, minute] = timeStr.split(':').map(Number);
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function formatCountdown(timeStr, now, windowStart) {
  if (windowStart && windowStart !== '00:00' && now < atTime(now, windowStart)) {
    return { text: `starts ${windowStart}`, overdue: false, notStarted: true };
  }

  const due = atTime(now, timeStr);
  const diffMin = Math.round((due - now) / 60000);

  if (diffMin > 0) {
    const hrs = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    return { text: hrs > 0 ? `in ${hrs}h ${mins}m` : `in ${mins}m`, overdue: false };
  }
  if (diffMin === 0) return { text: 'due now', overdue: false };
  const overdueMin = -diffMin;
  const hrs = Math.floor(overdueMin / 60);
  const mins = overdueMin % 60;
  return { text: hrs > 0 ? `${hrs}h ${mins}m overdue` : `${mins}m overdue`, overdue: true };
}

function CountdownLabel({ time, windowStart, now, done, className = 'today-item-time' }) {
  if (done) return <span className={className}>{time}</span>;
  const { text, overdue } = formatCountdown(time, now, windowStart);
  return (
    <span className={`${className} ${overdue ? 'overdue' : ''}`}>
      {time} · {text}
    </span>
  );
}

function QuantityControl({ task, completions, onAddQuantity, onSetQuantity, now }) {
  const actual = completions[task.id]?.[todayKey()] || 0;
  const target = task.target || 0;
  const pct = target ? Math.min(100, Math.round((actual / target) * 100)) : 0;
  const isComplete = target > 0 && actual >= target;
  const isPartial = actual > 0 && !isComplete;
  const quickAmounts = quickAddAmountsFor(task);

  return (
    <div className="qty-row">
      <div className="qty-top">
        <span className="today-item-title">{task.title}</span>
        <span className={`qty-value ${isComplete ? 'complete' : isPartial ? 'partial' : ''}`}>
          {actual} / {target} {task.unit || ''}
        </span>
      </div>
      <CountdownLabel time={task.time} windowStart={task.windowStart} now={now} done={isComplete} />
      <div className="qty-track">
        <div className={`qty-fill ${isPartial ? 'partial' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="qty-actions">
        {quickAmounts.map((amount) => (
          <button key={amount} className="qty-btn primary" onClick={() => onAddQuantity(task, amount)}>
            + {amount}
          </button>
        ))}
        <button
          className="qty-btn"
          onClick={() => {
            const input = window.prompt(`Set ${task.title} total for today:`, String(actual));
            if (input === null) return;
            const parsed = Number(input);
            if (!Number.isNaN(parsed) && parsed >= 0) onSetQuantity(task, parsed);
          }}
        >
          Custom…
        </button>
        {isPartial && <span className="badge-partial">Partial</span>}
      </div>
    </div>
  );
}

export default function TodayView({
  routines,
  completions,
  taskVersionsMap,
  onToggleComplete,
  onAddQuantity,
  onSetQuantity,
}) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [now, setNow] = useState(() => new Date());
  const today = now;

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  const dueRoutines = routines
    .filter((routine) => routine.active)
    .map((routine) => ({
      routine,
      dueTasks: routine.tasks.filter((t) => isTaskDueToday(t, taskVersionsMap)),
    }))
    .filter((r) => r.dueTasks.length > 0);

  const doneCount = dueRoutines.filter(
    ({ routine }) => getRoutineFraction(routine, taskVersionsMap, completions, today) === 1
  ).length;

  const toggleCollapsed = (routineId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(routineId)) next.delete(routineId);
      else next.add(routineId);
      return next;
    });
  };

  return (
    <div className="today-view">
      <div className="today-summary">
        <h2>Today</h2>
        <p>
          {doneCount} / {dueRoutines.length} completed
        </p>
      </div>

      {dueRoutines.length === 0 && <p className="empty-state">No routines scheduled for today.</p>}

      <ul className="today-list">
        {dueRoutines.map(({ routine, dueTasks }) => {
          const RoutineIcon = getRoutineIcon(routine);

          if (dueTasks.length === 1) {
            const task = dueTasks[0];
            if (task.completionType === 'quantity') {
              return (
                <li key={routine.id} className="today-item">
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <span className="icon-badge">
                      <RoutineIcon size={18} />
                    </span>
                    <QuantityControl
                      task={task}
                      completions={completions}
                      onAddQuantity={onAddQuantity}
                      onSetQuantity={onSetQuantity}
                      now={now}
                    />
                  </div>
                </li>
              );
            }
            const done = Boolean(completions[task.id]?.[todayKey()]);
            return (
              <li key={routine.id} className={`today-item ${done ? 'done' : ''}`}>
                <label className="row">
                  <input type="checkbox" checked={done} onChange={() => onToggleComplete(task, !done)} />
                  <span className="icon-badge">
                    <RoutineIcon size={18} />
                  </span>
                  <span className="today-item-title">{routine.title}</span>
                  <CountdownLabel time={task.time} windowStart={task.windowStart} now={now} done={done} />
                  <span className={`check-circle ${done ? 'done' : ''}`}>{done && <Check size={15} />}</span>
                </label>
              </li>
            );
          }

          const fraction = getRoutineFraction(routine, taskVersionsMap, completions, today) || 0;
          const pct = Math.round(fraction * 100);
          const doneTaskCount = dueTasks.filter(
            (t) => getTaskFraction(taskVersionsMap[t.id], completions[t.id] || {}, today) === 1
          ).length;
          const isCollapsed = collapsed.has(routine.id);

          return (
            <li key={routine.id} className="routine-group">
              <div className="group-header" onClick={() => toggleCollapsed(routine.id)}>
                <span className="icon-badge">
                  <RoutineIcon size={18} />
                </span>
                <div className="group-title">
                  <span className="name">{routine.title}</span>
                  <span className="meta">
                    {doneTaskCount} of {dueTasks.length} done
                  </span>
                </div>
                <div className="group-progress-ring" style={{ '--pct': `${pct}%` }}>
                  <span>{pct}%</span>
                </div>
                <span className={`chevron ${isCollapsed ? '' : 'open'}`}>
                  <ChevronDown size={18} />
                </span>
              </div>

              {!isCollapsed && (
                <ul className="task-list">
                  {dueTasks.map((task) => {
                    if (task.completionType === 'quantity') {
                      return (
                        <li className="task-row" key={task.id} style={{ alignItems: 'flex-start' }}>
                          <QuantityControl
                            task={task}
                            completions={completions}
                            onAddQuantity={onAddQuantity}
                            onSetQuantity={onSetQuantity}
                            now={now}
                          />
                        </li>
                      );
                    }
                    const done = Boolean(completions[task.id]?.[todayKey()]);
                    return (
                      <li className="task-row" key={task.id}>
                        <span className="dot" />
                        <span className="task-title" style={done ? { textDecoration: 'line-through', opacity: 0.5 } : undefined}>
                          {task.title}
                        </span>
                        <CountdownLabel time={task.time} windowStart={task.windowStart} now={now} done={done} className="task-time" />
                        <button
                          type="button"
                          className={`check-circle sm ${done ? 'done' : ''}`}
                          onClick={() => onToggleComplete(task, !done)}
                        >
                          {done && <Check size={12} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
