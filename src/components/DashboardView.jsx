import { useMemo, useState } from 'react';
import { Flame } from 'lucide-react';
import { getDashboardStats } from '../utils/analytics';
import { getRoutineIcon } from '../utils/icons';

const RANGES = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All Time' },
];

function barClass(pct) {
  if (pct === null) return '';
  if (pct < 50) return 'low';
  if (pct < 80) return 'mid';
  return '';
}

export default function DashboardView({ routines, completions }) {
  const [range, setRange] = useState('month');
  const stats = useMemo(
    () => getDashboardStats(routines, completions, range),
    [routines, completions, range]
  );

  if (routines.length === 0) {
    return <p className="empty-state">Add a routine to see your dashboard.</p>;
  }

  const maxTrendPct = Math.max(1, ...stats.trend.map((t) => t.pct ?? 0));
  const showCallouts =
    stats.topRoutine && stats.needsAttention && stats.topRoutine.routine.id !== stats.needsAttention.routine.id;

  return (
    <div className="dashboard-view">
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
          <span className="stat-value">{stats.bestStreak}</span>
          <span className="stat-label">BEST STREAK</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.totalCompleted}</span>
          <span className="stat-label">COMPLETED</span>
        </div>
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
          return (
            <div className="breakdown-row" key={r.routine.id}>
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
    </div>
  );
}
