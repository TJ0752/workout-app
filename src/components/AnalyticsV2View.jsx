import { useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import {
  ANALYTICS_V2_RANGES,
  buildExerciseCategoryMap,
  datesForRange,
  getAnalyticsV2Overview,
  getFocusAreaBreakdown,
  getPeriodTotals,
  getRoutineDayOfWeekBreakdown,
  getRoutineOnTimeRate,
  getRoutineTrendSeries,
  getTaskAverageValue,
  getTaskDominantCategory,
  getTaskHeatmapSeries,
  getTaskOnTimeRate,
  makeCustomRange,
} from '../utils/analyticsV2';
import { getOverallConsistency } from '../utils/analytics';
import { calcRoutineStreak, calcLongestRoutineStreak, todayKey } from '../utils/date';
import { getWorkoutStats } from '../utils/workouts';
import { exerciseCategoryLabel } from '../utils/exerciseCategory';
import { getRoutineIcon } from '../utils/icons';

const DURATION_CATEGORIES = new Set(['stretch_mobility', 'yoga']);

function fmtPct(value) {
  return value === null || value === undefined ? '—' : `${value}%`;
}

function fmt1(value) {
  return String(Math.round(value * 10) / 10);
}

function formatSeconds(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Small bar-chart, shared by the Overview trend and the Routine Detail trend - both already
 * produce a [{label|date, pct}] series, just at different granularities. */
function TrendChart({ series, labelKey = 'label' }) {
  const max = Math.max(1, ...series.map((s) => s.pct ?? 0));
  return (
    <>
      <div className="trend-chart">
        {series.map((point, i) => (
          <div className="trend-bar-wrap" key={i}>
            <div
              className={`trend-bar ${point.pct === 100 ? 'best' : ''}`}
              style={{ height: `${((point.pct ?? 0) / max) * 100}%` }}
              title={point.pct === null ? 'Nothing due' : `${point.pct}%`}
            />
          </div>
        ))}
      </div>
      <div className="trend-labels">
        {series.map((point, i) => (
          <span key={i}>{labelKey === 'date' ? point.date.slice(5) : point[labelKey]}</span>
        ))}
      </div>
    </>
  );
}

function RangePicker({ range, customStart, onRangeChange, onCustomStartChange }) {
  const isCustom = Boolean(customStart);
  return (
    <div className="av2-range-picker">
      <div className="range-toggle">
        {ANALYTICS_V2_RANGES.map((r) => (
          <button
            key={r.id}
            className={!isCustom && range === r.id ? 'active' : ''}
            onClick={() => onRangeChange(r.id)}
          >
            {r.label}
          </button>
        ))}
        <button className={isCustom ? 'active' : ''} onClick={() => onCustomStartChange(customStart || todayKey())}>
          Custom
        </button>
      </div>
      {isCustom && (
        <label className="av2-custom-range-input">
          Since
          <input type="date" value={customStart} max={todayKey()} onChange={(e) => onCustomStartChange(e.target.value)} />
        </label>
      )}
    </div>
  );
}

/** Habit Heatmap - Routines uses the same day-by-day series the original Dashboard's
 * consistency chart already computes; Tasks lets the user pick one task and shows its own
 * per-day series (utils/analyticsV2.js's getTaskHeatmapSeries). Purely visual here - no
 * tap-to-drill-down, unlike the original Dashboard's equivalent chart. */
function HabitHeatmap({ routines, taskVersionsMap, completions, reschedulesMap }) {
  const [mode, setMode] = useState('routines');
  const [taskId, setTaskId] = useState(null);
  const allTasks = useMemo(() => routines.flatMap((r) => r.tasks.map((t) => ({ ...t, routineTitle: r.title }))), [routines]);
  const effectiveTaskId = taskId || allTasks[0]?.id || null;

  const routineSeries = useMemo(
    () => getOverallConsistency(routines, taskVersionsMap, completions, 0.5, 35, reschedulesMap).series,
    [routines, taskVersionsMap, completions, reschedulesMap]
  );
  const task = allTasks.find((t) => t.id === effectiveTaskId);
  const taskSeries = useMemo(
    () => (task ? getTaskHeatmapSeries(task, taskVersionsMap, completions, 35, reschedulesMap) : []),
    [task, taskVersionsMap, completions, reschedulesMap]
  );
  const series = mode === 'routines' ? routineSeries : taskSeries;

  function heatmapClass(pct) {
    if (pct === null) return 'seq-none';
    if (pct === 0) return 'seq-1';
    if (pct < 40) return 'seq-2';
    if (pct < 65) return 'seq-3';
    if (pct < 90) return 'seq-4';
    return 'seq-5';
  }

  return (
    <div className="av2-card">
      <div className="section-title">Habit Heatmap</div>
      <div className="range-toggle av2-small-toggle">
        <button className={mode === 'routines' ? 'active' : ''} onClick={() => setMode('routines')}>
          Routines
        </button>
        <button className={mode === 'tasks' ? 'active' : ''} onClick={() => setMode('tasks')}>
          Tasks
        </button>
      </div>
      {mode === 'tasks' && allTasks.length > 0 && (
        <select className="av2-task-select" value={effectiveTaskId || ''} onChange={(e) => setTaskId(e.target.value)}>
          {allTasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.routineTitle} · {t.title}
            </option>
          ))}
        </select>
      )}
      <div className="heatmap-quiet">
        {series.map((d) => (
          <div
            key={d.date}
            className={`heatmap-cell-quiet ${heatmapClass(d.pct)}`}
            title={`${d.date}: ${d.pct === null ? 'nothing due' : `${d.pct}%`}`}
          />
        ))}
      </div>
    </div>
  );
}

/** Progress vs Goal - every quantity task's target vs its average logged value over the current
 * range, reusing the exact same target the app already enforces elsewhere. */
function ProgressVsGoal({ routines, taskVersionsMap, completions, dates, reschedulesMap }) {
  const rows = [];
  for (const routine of routines) {
    for (const task of routine.tasks) {
      if (task.completionType !== 'quantity') continue;
      const versions = taskVersionsMap[task.id];
      if (!versions) continue;
      const avg = getTaskAverageValue(versions, completions[task.id] || {}, dates, reschedulesMap[task.id] || []);
      if (avg === null) continue;
      rows.push({ task, avg, target: task.target, pct: task.target ? Math.min(100, Math.round((avg / task.target) * 100)) : null });
    }
  }
  if (rows.length === 0) return null;

  return (
    <div className="av2-card">
      <div className="section-title">Progress vs Goal</div>
      <div className="av2-goal-list">
        {rows.map(({ task, avg, target, pct }) => (
          <div className="av2-goal-row" key={task.id}>
            <div className="av2-goal-row-head">
              <span className="av2-goal-name">{task.title}</span>
              <span className="av2-goal-values">
                {fmt1(avg)} {task.unit || ''} avg
                {target ? ` / ${target} ${task.unit || ''} goal` : ''}
              </span>
            </div>
            {pct !== null && (
              <div className="av2-goal-bar-track">
                <div className="av2-goal-bar-fill" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewScreen({
  routines,
  completions,
  taskVersionsMap,
  reschedulesMap,
  completionTimestamps,
  range,
  customStart,
  onRangeChange,
  onCustomStartChange,
  onOpenRoutine,
}) {
  const effectiveRange = customStart ? makeCustomRange(customStart) : range;
  const stats = useMemo(
    () => getAnalyticsV2Overview(routines, taskVersionsMap, completions, completionTimestamps, reschedulesMap, effectiveRange),
    [routines, taskVersionsMap, completions, completionTimestamps, reschedulesMap, effectiveRange]
  );
  const dates = useMemo(() => datesForRange(effectiveRange, routines), [effectiveRange, routines]);

  if (routines.length === 0) {
    return <p className="empty-state">Add a routine to see Analytics 2 here.</p>;
  }

  return (
    <>
      <RangePicker range={range} customStart={customStart} onRangeChange={onRangeChange} onCustomStartChange={onCustomStartChange} />

      <div className="av2-ring-row">
        <div className="av2-ring" style={{ '--pct': `${stats.completionRate}%` }}>
          <span>{stats.completionRate}%</span>
        </div>
        <div className="av2-ring-side">
          <div className="av2-ring-stat">
            <strong>
              {stats.routinesCompleted}/{stats.routinesDue}
            </strong>
            <span>Routines completed</span>
          </div>
          <div className="av2-ring-stat">
            <strong>
              {stats.tasksCompleted}/{stats.tasksDue}
            </strong>
            <span>Tasks completed</span>
          </div>
          {stats.completionRateDelta !== null && (
            <div className={`av2-delta ${stats.completionRateDelta >= 0 ? 'up' : 'down'}`}>
              {stats.completionRateDelta >= 0 ? '+' : ''}
              {stats.completionRateDelta}% vs previous period
            </div>
          )}
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-value gold">{stats.bestStreak}</span>
          <span className="stat-label">CURRENT STREAK</span>
        </div>
        <div className="stat-card">
          <span className="stat-value gold">{stats.longestStreak}</span>
          <span className="stat-label">LONGEST STREAK</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{fmtPct(stats.onTimeRate)}</span>
          <span className="stat-label">ON-TIME RATE</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{fmtPct(stats.consistency.pct)}</span>
          <span className="stat-label">CONSISTENCY</span>
        </div>
      </div>

      <div className="callout-row">
        <div className="callout">
          <span className="callout-label">BEST DAY</span>
          <span className="callout-value">{stats.bestDay ? `${stats.bestDay.label} · ${stats.bestDay.pct}%` : '—'}</span>
        </div>
        <div className="callout">
          <span className="callout-label">WEAKEST DAY</span>
          <span className="callout-value">{stats.weakestDay ? `${stats.weakestDay.label} · ${stats.weakestDay.pct}%` : '—'}</span>
        </div>
      </div>

      <div className="trend-section">
        <div className="section-title">Completion Trend</div>
        <TrendChart series={stats.trend} />
      </div>

      <div className="section-title">Top Routines</div>
      <div className="av2-card">
        {stats.perRoutine.slice(0, 6).map(({ routine, pct }) => {
          const RoutineIcon = getRoutineIcon(routine);
          return (
            <button type="button" className="exercise-item av2-routine-row" key={routine.id} onClick={() => onOpenRoutine(routine.id)}>
              <div className="exercise-head" style={{ cursor: 'pointer' }}>
                <div className="exercise-head-left">
                  <span className="icon-badge" style={{ width: 28, height: 28 }}>
                    <RoutineIcon size={14} />
                  </span>
                  <span className="exercise-name">{routine.title}</span>
                </div>
                <div className="exercise-head-right">
                  <span className="exercise-metric">
                    <strong>{pct}%</strong>
                  </span>
                  <ChevronLeft size={16} style={{ transform: 'rotate(180deg)' }} />
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <HabitHeatmap routines={routines} taskVersionsMap={taskVersionsMap} completions={completions} reschedulesMap={reschedulesMap} />
      <ProgressVsGoal
        routines={routines}
        taskVersionsMap={taskVersionsMap}
        completions={completions}
        dates={dates}
        reschedulesMap={reschedulesMap}
      />
    </>
  );
}

function RoutineDetailScreen({
  routine,
  routines,
  taskVersionsMap,
  completions,
  completionTimestamps,
  reschedulesMap,
  range,
  customStart,
  onBack,
  onOpenWorkout,
}) {
  const [subTab, setSubTab] = useState('overview');
  const effectiveRange = customStart ? makeCustomRange(customStart) : range;
  const dates = useMemo(() => datesForRange(effectiveRange, routines), [effectiveRange, routines]);

  const totals = useMemo(
    () => getPeriodTotals([routine], taskVersionsMap, completions, dates, reschedulesMap),
    [routine, taskVersionsMap, completions, dates, reschedulesMap]
  );
  const onTime = useMemo(
    () => getRoutineOnTimeRate(routine, taskVersionsMap, completions, completionTimestamps, dates, reschedulesMap),
    [routine, taskVersionsMap, completions, completionTimestamps, dates, reschedulesMap]
  );
  const dayOfWeek = useMemo(
    () => getRoutineDayOfWeekBreakdown(routine, taskVersionsMap, completions, dates, reschedulesMap),
    [routine, taskVersionsMap, completions, dates, reschedulesMap]
  );
  const trend = useMemo(
    () => getRoutineTrendSeries(routine, taskVersionsMap, completions, dates, reschedulesMap).slice(-14),
    [routine, taskVersionsMap, completions, dates, reschedulesMap]
  );
  const currentStreak = calcRoutineStreak(routine, taskVersionsMap, completions, reschedulesMap);
  const longestStreak = calcLongestRoutineStreak(routine, taskVersionsMap, completions, dates.length, reschedulesMap);

  return (
    <>
      <button type="button" className="link-btn av2-back-btn" onClick={onBack}>
        <ChevronLeft size={16} /> Back to Overview
      </button>
      <h2 className="av2-detail-title">{routine.title}</h2>

      <div className="range-toggle av2-small-toggle">
        <button className={subTab === 'overview' ? 'active' : ''} onClick={() => setSubTab('overview')}>
          Overview
        </button>
        <button className={subTab === 'tasks' ? 'active' : ''} onClick={() => setSubTab('tasks')}>
          Tasks
        </button>
      </div>

      {subTab === 'overview' ? (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-value">
                {totals.routinesCompleted}/{totals.routinesDue}
              </span>
              <span className="stat-label">TIMES COMPLETED</span>
            </div>
            <div className="stat-card">
              <span className="stat-value gold">{currentStreak}</span>
              <span className="stat-label">CURRENT STREAK</span>
            </div>
            <div className="stat-card">
              <span className="stat-value gold">{longestStreak}</span>
              <span className="stat-label">LONGEST STREAK</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{fmtPct(onTime.pct)}</span>
              <span className="stat-label">ON-TIME RATE</span>
            </div>
          </div>

          <div className="trend-section">
            <div className="section-title">Completion Trend</div>
            <TrendChart series={trend} labelKey="date" />
          </div>

          <div className="section-title">Day of Week</div>
          <div className="av2-card av2-dow-row">
            {dayOfWeek.map((d) => (
              <div key={d.label} className="av2-dow-cell">
                <span className="av2-dow-pct">{d.pct === null ? '—' : `${d.pct}%`}</span>
                <span className="av2-dow-label">{d.label}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="av2-card">
          {routine.tasks.map((task) => {
            const versions = taskVersionsMap[task.id];
            const isWorkout = task.completionType === 'workout';
            const avg =
              task.completionType === 'quantity' && versions
                ? getTaskAverageValue(versions, completions[task.id] || {}, dates, reschedulesMap[task.id] || [])
                : null;
            const taskOnTime = versions
              ? getTaskOnTimeRate(versions, completions[task.id] || {}, completionTimestamps[task.id] || {}, dates, reschedulesMap[task.id] || [])
              : { pct: null };
            const Row = isWorkout ? 'button' : 'div';
            return (
              <Row
                type={isWorkout ? 'button' : undefined}
                key={task.id}
                className={`exercise-item av2-task-row ${isWorkout ? 'av2-clickable' : ''}`}
                onClick={isWorkout ? () => onOpenWorkout(task.id) : undefined}
              >
                <div className="exercise-head" style={isWorkout ? { cursor: 'pointer' } : undefined}>
                  <div className="exercise-head-left">
                    <span className="exercise-name">{task.title}</span>
                  </div>
                  <div className="exercise-head-right">
                    <span className="exercise-metric">
                      {avg !== null && (
                        <>
                          {fmt1(avg)} {task.unit || ''} avg
                          <br />
                        </>
                      )}
                      On-time: {fmtPct(taskOnTime.pct)}
                    </span>
                    {isWorkout && <ChevronLeft size={16} style={{ transform: 'rotate(180deg)' }} />}
                  </div>
                </div>
              </Row>
            );
          })}
        </div>
      )}
    </>
  );
}

function WorkoutDetailScreen({ task, routineTitle, workoutLogsByTask, exerciseCategoryById, onBack }) {
  const [subTab, setSubTab] = useState('overview');
  const logsForTask = useMemo(() => workoutLogsByTask[task.id] || {}, [workoutLogsByTask, task.id]);
  const stats = useMemo(() => getWorkoutStats(task, logsForTask), [task, logsForTask]);
  const category = useMemo(() => getTaskDominantCategory(task, exerciseCategoryById), [task, exerciseCategoryById]);
  const isDurationStyle = DURATION_CATEGORIES.has(category);
  const focusAreas = useMemo(() => (isDurationStyle ? getFocusAreaBreakdown(task, logsForTask) : []), [isDurationStyle, task, logsForTask]);

  const totalReps = Object.values(stats.byExercise).reduce((sum, e) => sum + (e.totalReps || 0), 0);
  const totalWeight = Object.values(stats.byExercise).reduce((sum, e) => sum + (e.volume || 0), 0);
  const totalDuration = Object.values(stats.byExercise).reduce((sum, e) => sum + (e.totalDuration || 0), 0);

  return (
    <>
      <button type="button" className="link-btn av2-back-btn" onClick={onBack}>
        <ChevronLeft size={16} /> Back to {routineTitle}
      </button>
      <h2 className="av2-detail-title">{task.title}</h2>
      {category && <span className="av2-category-badge">{exerciseCategoryLabel(category)}</span>}

      <div className="range-toggle av2-small-toggle">
        <button className={subTab === 'overview' ? 'active' : ''} onClick={() => setSubTab('overview')}>
          Overview
        </button>
        <button className={subTab === 'exercises' ? 'active' : ''} onClick={() => setSubTab('exercises')}>
          Exercises
        </button>
        <button className={subTab === 'progress' ? 'active' : ''} onClick={() => setSubTab('progress')}>
          Progress
        </button>
      </div>

      {subTab === 'overview' && (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-value">{stats.recentSessions.length}</span>
              <span className="stat-label">SESSIONS LOGGED</span>
            </div>
            {isDurationStyle ? (
              <div className="stat-card">
                <span className="stat-value">{formatSeconds(totalDuration)}</span>
                <span className="stat-label">TOTAL TIME</span>
              </div>
            ) : totalWeight > 0 ? (
              <div className="stat-card">
                <span className="stat-value">{fmt1(totalWeight)}</span>
                <span className="stat-label">TOTAL VOLUME (KG)</span>
              </div>
            ) : (
              <div className="stat-card">
                <span className="stat-value">{totalReps}</span>
                <span className="stat-label">TOTAL REPS</span>
              </div>
            )}
          </div>
          {isDurationStyle && focusAreas.length > 0 && (
            <>
              <div className="section-title">Top Areas</div>
              <div className="av2-card">
                {focusAreas.map((area) => (
                  <div className="av2-goal-row" key={area.label}>
                    <div className="av2-goal-row-head">
                      <span className="av2-goal-name">{area.label}</span>
                      <span className="av2-goal-values">{formatSeconds(area.seconds)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {subTab === 'exercises' && (
        <div className="av2-card">
          {(task.exercises || []).map((exercise) => {
            const exStats = stats.byExercise[exercise.id];
            if (!exStats) return null;
            const headline = exStats.isWeighted
              ? `${fmt1(exStats.e1rm?.e1rm || 0)}kg e1RM`
              : exStats.repPR
                ? `${exStats.repPR.reps} reps`
                : exStats.durationPR
                  ? `${exStats.durationPR.durationSeconds}s`
                  : '—';
            return (
              <div className="exercise-item" key={exercise.id}>
                <div className="exercise-head">
                  <div className="exercise-head-left">
                    <span className="exercise-name">{exercise.name}</span>
                  </div>
                  <div className="exercise-head-right">
                    <span className="exercise-metric">
                      <strong>{headline}</strong>
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {subTab === 'progress' && (
        <div className="av2-card">
          {(task.exercises || []).map((exercise) => {
            const exStats = stats.byExercise[exercise.id];
            if (!exStats || exStats.series.length === 0) return null;
            const values = exStats.series.map((s) => (exStats.isWeighted ? s.e1rm : exStats.repPR ? s.bestReps : s.bestDuration));
            const max = Math.max(1, ...values);
            return (
              <div key={exercise.id}>
                <div className="trend-chart-label">{exercise.name}</div>
                <div className="trend-chart small">
                  {values.slice(-8).map((v, i) => (
                    <div className="trend-bar-wrap" key={i}>
                      <div className="trend-bar" style={{ height: `${(v / max) * 100}%` }} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export default function AnalyticsV2View({
  routines,
  completions,
  taskVersionsMap,
  reschedulesMap = {},
  workoutLogsByTask,
  completionTimestamps = {},
  exerciseCategories = [],
}) {
  const [range, setRange] = useState('week');
  const [customStart, setCustomStart] = useState('');
  const [screen, setScreen] = useState({ view: 'overview' });

  const exerciseCategoryById = useMemo(() => buildExerciseCategoryMap(exerciseCategories), [exerciseCategories]);

  const handleRangeChange = (id) => {
    setCustomStart('');
    setRange(id);
  };

  if (routines.length === 0) {
    return (
      <div className="analytics-v2-view">
        <p className="empty-state">Add a routine to see Analytics 2 here.</p>
      </div>
    );
  }

  if (screen.view === 'routine') {
    const routine = routines.find((r) => r.id === screen.routineId);
    if (!routine) {
      setScreen({ view: 'overview' });
      return null;
    }
    return (
      <div className="analytics-v2-view">
        <RoutineDetailScreen
          routine={routine}
          routines={routines}
          taskVersionsMap={taskVersionsMap}
          completions={completions}
          completionTimestamps={completionTimestamps}
          reschedulesMap={reschedulesMap}
          range={range}
          customStart={customStart}
          onBack={() => setScreen({ view: 'overview' })}
          onOpenWorkout={(taskId) => setScreen({ view: 'workout', routineId: routine.id, taskId })}
        />
      </div>
    );
  }

  if (screen.view === 'workout') {
    const routine = routines.find((r) => r.id === screen.routineId);
    const task = routine?.tasks.find((t) => t.id === screen.taskId);
    if (!routine || !task) {
      setScreen({ view: 'overview' });
      return null;
    }
    return (
      <div className="analytics-v2-view">
        <WorkoutDetailScreen
          task={task}
          routineTitle={routine.title}
          workoutLogsByTask={workoutLogsByTask}
          exerciseCategoryById={exerciseCategoryById}
          onBack={() => setScreen({ view: 'routine', routineId: routine.id })}
        />
      </div>
    );
  }

  return (
    <div className="analytics-v2-view">
      <OverviewScreen
        routines={routines}
        completions={completions}
        taskVersionsMap={taskVersionsMap}
        reschedulesMap={reschedulesMap}
        completionTimestamps={completionTimestamps}
        range={range}
        customStart={customStart}
        onRangeChange={handleRangeChange}
        onCustomStartChange={setCustomStart}
        onOpenRoutine={(routineId) => setScreen({ view: 'routine', routineId })}
      />
    </div>
  );
}
