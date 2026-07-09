import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Flame } from 'lucide-react';
import { getRoutineFraction, getTaskFraction, dateToKey, todayKey, startOfDay, calcRoutineStreak } from '../utils/date';

// Below this, a streak badge reads as noise rather than a meaningful "you're on a roll" signal.
const STREAK_BADGE_MIN = 3;
import { getRoutineIcon } from '../utils/icons';
import { quickAddAmountsFor, formatHms } from '../utils/tasks';

function isTaskDueOn(task, taskVersionsMap, date) {
  const versions = taskVersionsMap[task.id];
  if (!versions) return false;
  return getTaskFraction(versions, {}, date) !== null;
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

function CountdownLabel({ time, windowStart, now, done, showCountdown, className = 'today-item-time' }) {
  if (done || !showCountdown) return <span className={className}>{time}</span>;
  const { text, overdue } = formatCountdown(time, now, windowStart);
  return (
    <span className={`${className} ${overdue ? 'overdue' : ''}`}>
      {time} · {text}
    </span>
  );
}

function DateNav({ date, onChange }) {
  const key = dateToKey(date);
  const isToday = key === todayKey();
  const label = isToday
    ? 'Today'
    : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const shiftDay = (delta) => {
    const next = new Date(date);
    next.setDate(next.getDate() + delta);
    if (dateToKey(next) > todayKey()) return;
    onChange(startOfDay(next));
  };

  return (
    <div className="date-nav">
      <div className="date-nav-arrows">
        <button type="button" className="date-nav-arrow" onClick={() => shiftDay(-1)} aria-label="Previous day">
          <ChevronLeft size={18} />
        </button>
        <button
          type="button"
          className="date-nav-arrow"
          onClick={() => shiftDay(1)}
          disabled={isToday}
          aria-label="Next day"
        >
          <ChevronRight size={18} />
        </button>
      </div>
      <label className="date-nav-label">
        {label}
        <input
          type="date"
          value={key}
          max={todayKey()}
          onChange={(e) => {
            if (!e.target.value) return;
            const [y, m, d] = e.target.value.split('-').map(Number);
            onChange(new Date(y, m - 1, d));
          }}
        />
      </label>
    </div>
  );
}

function StreakBadge({ streak }) {
  if (streak < STREAK_BADGE_MIN) return null;
  return (
    <span className="streak-flame">
      <Flame size={11} /> {streak}
    </span>
  );
}

function QuantityControl({
  task,
  routine,
  completions,
  dateKey,
  onAddQuantity,
  onSetQuantity,
  onStartQuantityTimer,
  now,
  showCountdown,
  isToday,
  routineStreak,
}) {
  const actual = completions[task.id]?.[dateKey] || 0;
  const target = task.target || 0;
  const pct = target ? Math.min(100, Math.round((actual / target) * 100)) : 0;
  const isComplete = target > 0 && actual >= target;
  const isPartial = actual > 0 && !isComplete;
  const isTimer = task.quantityMode === 'timer';
  const quickAmounts = quickAddAmountsFor(task);

  return (
    <div className="qty-row">
      <div className="qty-top">
        <span className="today-item-title-row">
          <span className="today-item-title">{task.title}</span>
          <StreakBadge streak={routineStreak} />
        </span>
        <span className={`qty-value ${isComplete ? 'complete' : isPartial ? 'partial' : ''}`}>
          {isTimer ? `${formatHms(actual)} / ${formatHms(target)}` : `${actual} / ${target} ${task.unit || ''}`}
        </span>
      </div>
      <CountdownLabel
        time={task.time}
        windowStart={task.windowStart}
        now={now}
        done={isComplete}
        showCountdown={showCountdown}
      />
      <div className="qty-track">
        <div className={`qty-fill ${isPartial ? 'partial' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="qty-actions">
        {isTimer ? (
          <button
            type="button"
            className="qty-btn primary"
            disabled={!isToday}
            onClick={() => onStartQuantityTimer(task, routine, dateKey)}
          >
            Start timer
          </button>
        ) : (
          <>
            {quickAmounts.map((amount) => (
              <button key={amount} className="qty-btn primary" onClick={() => onAddQuantity(task, amount, dateKey)}>
                + {amount}
              </button>
            ))}
            <button
              className="qty-btn"
              onClick={() => {
                const input = window.prompt(`Set ${task.title} total for this day:`, String(actual));
                if (input === null) return;
                const parsed = Number(input);
                if (!Number.isNaN(parsed) && parsed >= 0) onSetQuantity(task, parsed, dateKey);
              }}
            >
              Custom…
            </button>
          </>
        )}
        {isPartial && <span className="badge-partial">Partial</span>}
        {isTimer && !isToday && <span className="badge-partial">Today only</span>}
      </div>
    </div>
  );
}

function WorkoutTaskCard({ task, routine, completions, dateKey, onStartWorkout, isToday, routineStreak }) {
  const fraction = completions[task.id]?.[dateKey] || 0;
  const pct = Math.round(fraction * 100);
  const isComplete = fraction >= 1;
  const exerciseCount = task.exercises?.length || 0;
  const label = isComplete ? 'Workout complete · Review' : fraction > 0 ? 'Resume workout' : 'Start workout';

  return (
    <div className="qty-row">
      <div className="qty-top">
        <span className="today-item-title-row">
          <span className="today-item-title">{task.title}</span>
          <StreakBadge streak={routineStreak} />
        </span>
        <span className={`qty-value ${isComplete ? 'complete' : fraction > 0 ? 'partial' : ''}`}>
          {exerciseCount} exercise{exerciseCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="qty-track">
        <div className={`qty-fill ${!isComplete && fraction > 0 ? 'partial' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="qty-actions">
        <button
          type="button"
          className="qty-btn primary"
          disabled={!isToday}
          onClick={() => onStartWorkout(task, routine, dateKey)}
        >
          {label}
        </button>
        {!isToday && <span className="badge-partial">Today only</span>}
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
  onStartWorkout,
  onStartQuantityTimer,
  focusTaskId,
  focusRoutineId,
  onFocusHandled,
}) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [now, setNow] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => startOfDay(new Date()));

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  // A tapped notification always deep-links into *today's* view of the task/routine (every
  // native notification is about today), and needs its group expanded if it's collapsed -
  // otherwise the element being scrolled to doesn't exist in the DOM at all.
  useEffect(() => {
    if (!focusTaskId && !focusRoutineId) return;
    setSelectedDate(startOfDay(new Date()));
    if (focusRoutineId) {
      setCollapsed((prev) => {
        if (!prev.has(focusRoutineId)) return prev;
        const next = new Set(prev);
        next.delete(focusRoutineId);
        return next;
      });
    }
  }, [focusTaskId, focusRoutineId]);

  // Runs after the (possibly just-expanded) DOM has settled, so the target element actually
  // exists to scroll to - separate from the effect above, which only handles date/collapse state.
  useEffect(() => {
    if (!focusTaskId && !focusRoutineId) return;
    const elementId = focusTaskId ? `today-task-${focusTaskId}` : `today-routine-${focusRoutineId}`;
    const el = document.getElementById(elementId);
    if (!el) {
      onFocusHandled?.();
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('today-item-focused');
    const timeout = setTimeout(() => {
      el.classList.remove('today-item-focused');
      onFocusHandled?.();
    }, 2500);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTaskId, focusRoutineId, collapsed]);

  const dateKey = dateToKey(selectedDate);
  const isToday = dateKey === todayKey();
  const dayLabel = isToday
    ? 'Today'
    : selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  const dueRoutines = routines
    .filter((routine) => routine.active && !routine.archived)
    .map((routine) => ({
      routine,
      dueTasks: routine.tasks.filter((t) => isTaskDueOn(t, taskVersionsMap, selectedDate)),
    }))
    .filter((r) => r.dueTasks.length > 0);

  const doneCount = dueRoutines.filter(
    ({ routine }) => getRoutineFraction(routine, taskVersionsMap, completions, selectedDate) === 1
  ).length;
  const heroPct = dueRoutines.length ? Math.round((doneCount / dueRoutines.length) * 100) : 0;

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
      <div className="today-hero">
        <div className="today-hero-text">
          <h2 className="today-hero-date">{dayLabel}</h2>
          <p className="today-hero-sub">
            {doneCount} of {dueRoutines.length} routines done
          </p>
        </div>
        <div className="today-hero-ring" style={{ '--pct': `${heroPct}%` }}>
          <span>{heroPct}%</span>
        </div>
      </div>

      <DateNav date={selectedDate} onChange={setSelectedDate} />

      {dueRoutines.length === 0 && (
        <p className="empty-state">
          {isToday ? 'No routines scheduled for today.' : `No routines were due on ${dayLabel}.`}
        </p>
      )}

      <ul className="today-list">
        {dueRoutines.map(({ routine, dueTasks }) => {
          const RoutineIcon = getRoutineIcon(routine);
          const routineStreak = calcRoutineStreak(routine, taskVersionsMap, completions);

          if (dueTasks.length === 1) {
            const task = dueTasks[0];
            if (task.completionType === 'quantity') {
              return (
                <li key={routine.id} id={`today-task-${task.id}`} className="today-item">
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <span className="icon-badge">
                      <RoutineIcon size={18} />
                    </span>
                    <QuantityControl
                      task={task}
                      routine={routine}
                      completions={completions}
                      dateKey={dateKey}
                      onAddQuantity={onAddQuantity}
                      onSetQuantity={onSetQuantity}
                      onStartQuantityTimer={onStartQuantityTimer}
                      now={now}
                      showCountdown={isToday}
                      isToday={isToday}
                      routineStreak={routineStreak}
                    />
                  </div>
                </li>
              );
            }
            if (task.completionType === 'workout') {
              return (
                <li key={routine.id} id={`today-task-${task.id}`} className="today-item">
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <span className="icon-badge">
                      <RoutineIcon size={18} />
                    </span>
                    <WorkoutTaskCard
                      task={task}
                      routine={routine}
                      completions={completions}
                      dateKey={dateKey}
                      onStartWorkout={onStartWorkout}
                      isToday={isToday}
                      routineStreak={routineStreak}
                    />
                  </div>
                </li>
              );
            }
            const done = Boolean(completions[task.id]?.[dateKey]);
            return (
              <li key={routine.id} id={`today-task-${task.id}`} className={`today-item ${done ? 'done' : ''}`}>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={done}
                    onChange={() => onToggleComplete(task, !done, dateKey)}
                  />
                  <span className="icon-badge">
                    <RoutineIcon size={18} />
                  </span>
                  <span className="today-item-title">{routine.title}</span>
                  <StreakBadge streak={routineStreak} />
                  <CountdownLabel
                    time={task.time}
                    windowStart={task.windowStart}
                    now={now}
                    done={done}
                    showCountdown={isToday}
                  />
                  <span className={`check-circle ${done ? 'done' : ''}`}>{done && <Check size={15} />}</span>
                </label>
              </li>
            );
          }

          const fraction = getRoutineFraction(routine, taskVersionsMap, completions, selectedDate) || 0;
          const pct = Math.round(fraction * 100);
          const doneTaskCount = dueTasks.filter(
            (t) => getTaskFraction(taskVersionsMap[t.id], completions[t.id] || {}, selectedDate) === 1
          ).length;
          const isCollapsed = collapsed.has(routine.id);

          return (
            <li key={routine.id} id={`today-routine-${routine.id}`} className="routine-group">
              <div className="group-header" onClick={() => toggleCollapsed(routine.id)}>
                <span className="icon-badge">
                  <RoutineIcon size={18} />
                </span>
                <div className="group-title">
                  <span className="today-item-title-row">
                    <span className="name">{routine.title}</span>
                    <StreakBadge streak={routineStreak} />
                  </span>
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
                        <li className="task-row" key={task.id} id={`today-task-${task.id}`} style={{ alignItems: 'flex-start' }}>
                          <QuantityControl
                            task={task}
                            routine={routine}
                            completions={completions}
                            dateKey={dateKey}
                            onAddQuantity={onAddQuantity}
                            onSetQuantity={onSetQuantity}
                            onStartQuantityTimer={onStartQuantityTimer}
                            now={now}
                            showCountdown={isToday}
                            isToday={isToday}
                          />
                        </li>
                      );
                    }
                    if (task.completionType === 'workout') {
                      return (
                        <li className="task-row" key={task.id} id={`today-task-${task.id}`} style={{ alignItems: 'flex-start' }}>
                          <WorkoutTaskCard
                            task={task}
                            routine={routine}
                            completions={completions}
                            dateKey={dateKey}
                            onStartWorkout={onStartWorkout}
                            isToday={isToday}
                          />
                        </li>
                      );
                    }
                    const done = Boolean(completions[task.id]?.[dateKey]);
                    return (
                      <li className="task-row" key={task.id} id={`today-task-${task.id}`}>
                        <span className="dot" />
                        <span
                          className="task-title"
                          style={done ? { textDecoration: 'line-through', opacity: 0.5 } : undefined}
                        >
                          {task.title}
                        </span>
                        <CountdownLabel
                          time={task.time}
                          windowStart={task.windowStart}
                          now={now}
                          done={done}
                          showCountdown={isToday}
                          className="task-time"
                        />
                        <button
                          type="button"
                          className={`check-circle sm ${done ? 'done' : ''}`}
                          onClick={() => onToggleComplete(task, !done, dateKey)}
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
