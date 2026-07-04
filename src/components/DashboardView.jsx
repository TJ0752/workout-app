import { useMemo, useState } from 'react';
import { ChevronDown, Flame } from 'lucide-react';
import { getDashboardStats } from '../utils/analytics';
import { getFitnessOverview } from '../utils/workouts';
import { getRoutineIcon } from '../utils/icons';

const RANGES = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All Time' },
];

function fmt1(value) {
  return String(Math.round(value * 10) / 10);
}

function FitnessStatsPanel({ routines, workoutLogsByTask }) {
  const [expandedExercise, setExpandedExercise] = useState(null);
  const overview = useMemo(
    () => getFitnessOverview(routines, workoutLogsByTask),
    [routines, workoutLogsByTask]
  );

  if (!overview.hasWorkouts) {
    return <p className="empty-state">Log a workout to see fitness stats here.</p>;
  }

  return (
    <>
      {(overview.topWeightedPR || overview.topRepPR || overview.topDurationPR) && (
        <div className="fit-overview-row">
          {overview.topWeightedPR && (
            <div className="fit-overview-tile weighted">
              <div className="fo-kind">Weighted PR</div>
              <div className="fo-num">
                {fmt1(overview.topWeightedPR.e1rm.e1rm)}
                <span className="fo-unit">kg e1RM</span>
              </div>
              <div className="fo-sub">{overview.topWeightedPR.name}</div>
            </div>
          )}
          {overview.topRepPR && (
            <div className="fit-overview-tile bodyweight">
              <div className="fo-kind">Bodyweight PR</div>
              <div className="fo-num">
                {overview.topRepPR.repPR.reps}
                <span className="fo-unit"> reps</span>
              </div>
              <div className="fo-sub">{overview.topRepPR.name}</div>
            </div>
          )}
          {overview.topDurationPR && (
            <div className="fit-overview-tile bodyweight">
              <div className="fo-kind">Duration PR</div>
              <div className="fo-num">
                {overview.topDurationPR.durationPR.durationSeconds}
                <span className="fo-unit">s</span>
              </div>
              <div className="fo-sub">{overview.topDurationPR.name}</div>
            </div>
          )}
        </div>
      )}

      {overview.sessionMix.length > 0 && (
        <>
          <div className="section-title">
            Calisthenics vs. weightlifting
            <span className="section-subtitle">Share of sessions each week - not raw kg vs. reps, which don't compare</span>
          </div>
          <div className="mix-chart">
            {overview.sessionMix.map((w) => (
              <div className="mix-col" key={w.weekStart} title={`Week of ${w.weekStart}: ${w.weightedPct}% weighted`}>
                <div className="mix-seg bodyweight" style={{ height: `${100 - w.weightedPct}%` }} />
                <div className="mix-seg weighted" style={{ height: `${w.weightedPct}%` }} />
              </div>
            ))}
          </div>
          <div className="mix-legend">
            <span>
              <span className="mix-swatch weighted" /> Weightlifting
            </span>
            <span>
              <span className="mix-swatch bodyweight" /> Calisthenics
            </span>
          </div>
        </>
      )}

      <div className="section-title">By exercise</div>
      <div className="exercise-list">
        {overview.exercises.map((ex) => {
          const latest = ex.series[ex.series.length - 1];
          const kind = ex.isWeighted ? 'weighted' : ex.repPR ? 'reps' : 'duration';
          const headline =
            kind === 'weighted'
              ? `${fmt1(latest.e1rm)}kg e1RM`
              : kind === 'reps'
                ? `${latest.totalReps} reps`
                : `${latest.totalDuration}s`;
          const sub =
            kind === 'weighted'
              ? `PR ${fmt1(ex.e1rm.e1rm)}kg`
              : kind === 'reps'
                ? `PR ${ex.repPR.reps} reps`
                : `PR ${ex.durationPR.durationSeconds}s`;
          const seriesValues = ex.series.map((s) =>
            kind === 'weighted' ? s.e1rm : kind === 'reps' ? s.totalReps : s.totalDuration
          );
          const maxSeriesValue = Math.max(1, ...seriesValues);
          const isOpen = expandedExercise === ex.name;

          return (
            <div className={`exercise-item ${isOpen ? 'open' : ''}`} key={ex.name}>
              <div
                className="exercise-head"
                onClick={() => setExpandedExercise(isOpen ? null : ex.name)}
              >
                <div className="exercise-head-left">
                  <span className={`exercise-type-dot ${kind}`} />
                  <span className="exercise-name">{ex.name}</span>
                </div>
                <div className="exercise-head-right">
                  <span className="exercise-metric">
                    <strong>{headline}</strong>
                    <br />
                    {sub}
                  </span>
                  <span className={`chevron ${isOpen ? 'open' : ''}`}>
                    <ChevronDown size={16} />
                  </span>
                </div>
              </div>
              {isOpen && (
                <div className="exercise-detail">
                  <div className="trend-chart small">
                    {seriesValues.slice(-8).map((v, i) => (
                      <div className="trend-bar-wrap" key={i}>
                        <div className="trend-bar" style={{ height: `${(v / maxSeriesValue) * 100}%` }} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function barClass(pct) {
  if (pct === null) return '';
  if (pct < 50) return 'low';
  if (pct < 80) return 'mid';
  return '';
}

// Sequential single-hue ramp for the heatmap - light to dark, matching the app's accent green.
function heatmapClass(pct) {
  if (pct === null) return 'seq-none';
  if (pct === 0) return 'seq-1';
  if (pct < 40) return 'seq-2';
  if (pct < 65) return 'seq-3';
  if (pct < 90) return 'seq-4';
  return 'seq-5';
}

export default function DashboardView({ routines, completions, taskVersionsMap, workoutLogsByTask }) {
  const [screen, setScreen] = useState('overall');
  const [range, setRange] = useState('month');
  const [expanded, setExpanded] = useState(() => new Set());
  const stats = useMemo(
    () => getDashboardStats(routines, taskVersionsMap, completions, range),
    [routines, taskVersionsMap, completions, range]
  );

  if (routines.length === 0) {
    return <p className="empty-state">Add a routine to see your dashboard.</p>;
  }

  const maxTrendPct = Math.max(1, ...stats.trend.map((t) => t.pct ?? 0));
  const showCallouts =
    stats.topRoutine && stats.needsAttention && stats.topRoutine.routine.id !== stats.needsAttention.routine.id;

  const toggleExpanded = (routineId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(routineId)) next.delete(routineId);
      else next.add(routineId);
      return next;
    });
  };

  return (
    <div className="dashboard-view">
      <div className="range-toggle">
        <button className={screen === 'overall' ? 'active' : ''} onClick={() => setScreen('overall')}>
          Overall
        </button>
        <button className={screen === 'fitness' ? 'active' : ''} onClick={() => setScreen('fitness')}>
          Fitness Stats
        </button>
      </div>

      {screen === 'fitness' ? (
        <FitnessStatsPanel routines={routines} workoutLogsByTask={workoutLogsByTask} />
      ) : (
        <>
      <div className="range-toggle">
        {RANGES.map((r) => (
          <button key={r.id} className={range === r.id ? 'active' : ''} onClick={() => setRange(r.id)}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-value">{stats.completionRate}%</span>
          <span className="stat-label">COMPLETION RATE</span>
        </div>
        <div className="stat-card">
          <span className="stat-value gold">{stats.bestStreak}</span>
          <span className="stat-label">CURRENT STREAK</span>
        </div>
        <div className="stat-card">
          <span className="stat-value gold">{stats.longestStreak}</span>
          <span className="stat-label">LONGEST STREAK</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.totalCompleted}</span>
          <span className="stat-label">COMPLETED</span>
        </div>
      </div>

      <div className="section-title">
        Consistency
        <span className="section-subtitle">Days at or above a 50% minimum - not just perfect days</span>
      </div>
      <div className="consistency-summary">
        {stats.consistency.daysMet} of {stats.consistency.totalDueDays} days ≥ 50%
        <span className="consistency-pct"> · {stats.consistency.pct}% consistency</span>
      </div>
      {stats.consistency.series.length > 0 && (
        <div className="threshold-chart">
          <div className="threshold-line" />
          <span className="threshold-line-label">50% min</span>
          <div className="threshold-bars">
            {stats.consistency.series.map((d) => (
              <div className="threshold-bar-col" key={d.date} title={`${d.date}: ${d.pct}%`}>
                <div className={`threshold-bar ${d.met ? 'met' : 'unmet'}`} style={{ height: `${d.pct}%` }} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section-title">
        Completion heatmap
        <span className="section-subtitle">Darker = higher completion that day</span>
      </div>
      <div className="heatmap-quiet">
        {stats.consistency.series.map((d) => (
          <div key={d.date} className={`heatmap-cell-quiet ${heatmapClass(d.pct)}`} title={`${d.date}: ${d.pct}%`} />
        ))}
      </div>

      {stats.trend.length > 1 && (
        <div className="trend-section">
          <div className="section-title">Trend</div>
          <div className="trend-chart">
            {stats.trend.map((t, i) => (
              <div className="trend-bar-wrap" key={i}>
                <div
                  className={`trend-bar ${t.pct !== null && t.pct === maxTrendPct ? 'best' : ''}`}
                  style={{ height: `${t.pct ?? 0}%` }}
                />
              </div>
            ))}
          </div>
          <div className="trend-labels">
            {stats.trend.map((t, i) => (
              <span key={i}>{t.label}</span>
            ))}
          </div>
        </div>
      )}

      {showCallouts && (
        <div className="callout-row">
          <div className="callout">
            <div className="callout-label">TOP ROUTINE</div>
            <div className="callout-value">
              {stats.topRoutine.routine.title} · {stats.topRoutine.pct}%
            </div>
          </div>
          <div className="callout">
            <div className="callout-label">NEEDS ATTENTION</div>
            <div className="callout-value">
              {stats.needsAttention.routine.title} · {stats.needsAttention.pct}%
            </div>
          </div>
        </div>
      )}

      <div className="section-title">Completion by routine</div>
      {stats.perRoutine.length === 0 && <p className="empty-state">No routines were due in this range yet.</p>}
      <div className="breakdown-list">
        {stats.perRoutine.map((r) => {
          const RoutineIcon = getRoutineIcon(r.routine);
          const hasMultipleTasks = r.tasks.length > 1;
          const isOpen = expanded.has(r.routine.id);
          return (
            <div className="breakdown-row" key={r.routine.id}>
              <div
                className="breakdown-head"
                onClick={hasMultipleTasks ? () => toggleExpanded(r.routine.id) : undefined}
                style={hasMultipleTasks ? { cursor: 'pointer' } : undefined}
              >
                <span className="icon-badge">
                  <RoutineIcon size={18} />
                </span>
                <div className="breakdown-body">
                  <div className="breakdown-top">
                    <span className="breakdown-name">{r.routine.title}</span>
                    <span className="breakdown-pct">{r.pct}%</span>
                  </div>
                  <div className="breakdown-bar-track">
                    <div className={`breakdown-bar-fill ${barClass(r.pct)}`} style={{ width: `${r.pct}%` }} />
                  </div>
                  <div className="breakdown-meta">
                    <Flame size={12} /> {r.streak} day streak · {r.completed}/{r.due} days
                  </div>
                </div>
                {hasMultipleTasks && (
                  <span className={`chevron ${isOpen ? 'open' : ''}`}>
                    <ChevronDown size={16} />
                  </span>
                )}
              </div>

              {hasMultipleTasks && isOpen && (
                <div className="breakdown-sub-list">
                  {r.tasks.map((t) => (
                    <div className="breakdown-sub-row" key={t.task.id}>
                      <span className="dot" />
                      <span className="breakdown-sub-name">{t.task.title}</span>
                      <span className={`breakdown-sub-pct ${t.pct !== null && t.pct < 50 ? 'partial' : ''}`}>
                        {t.pct === null ? '—' : `${t.pct}%`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {stats.dayOfWeek && (
        <>
          <div className="section-title">By day of week</div>
          <div className="breakdown-list">
            {stats.dayOfWeek.map((d) => (
              <div className="breakdown-row" key={d.label}>
                <div className="breakdown-body">
                  <div className="breakdown-top">
                    <span className="breakdown-name">{d.label}</span>
                    <span className="breakdown-pct">{d.pct === null ? '—' : `${d.pct}%`}</span>
                  </div>
                  <div className="breakdown-bar-track">
                    <div
                      className={`breakdown-bar-fill ${barClass(d.pct)}`}
                      style={{ width: `${d.pct ?? 0}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
        </>
      )}
    </div>
  );
}
