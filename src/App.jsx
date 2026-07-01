import { useEffect, useState } from 'react';
import { Sun, ListTodo, BarChart3, Calendar } from 'lucide-react';
import './App.css';
import TodayView from './components/TodayView';
import RoutinesView from './components/RoutinesView';
import DashboardView from './components/DashboardView';
import HistoryView from './components/HistoryView';
import { getRoutines, upsertRoutine, deleteRoutine as deleteRoutineFromStore, getCompletions, setCompletion } from './storage';
import { initNotifications, scheduleRoutineNotifications, cancelRoutineNotifications, syncAllNotifications } from './notifications';
import { todayKey } from './utils/date';

const TABS = [
  { id: 'today', label: 'Today', Icon: Sun },
  { id: 'routines', label: 'Routines', Icon: ListTodo },
  { id: 'dashboard', label: 'Dashboard', Icon: BarChart3 },
  { id: 'history', label: 'History', Icon: Calendar },
];

function App() {
  const [tab, setTab] = useState('today');
  const [routines, setRoutines] = useState([]);
  const [completions, setCompletions] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [storedRoutines, storedCompletions] = await Promise.all([getRoutines(), getCompletions()]);
      setRoutines(storedRoutines);
      setCompletions(storedCompletions);
      setLoading(false);
      await initNotifications();
      await syncAllNotifications(storedRoutines);
    })();
  }, []);

  const handleAdd = async (routine) => {
    const next = await upsertRoutine(routine);
    setRoutines(next);
    await scheduleRoutineNotifications(routine);
  };

  const handleUpdate = async (routine) => {
    const next = await upsertRoutine(routine);
    setRoutines(next);
    await scheduleRoutineNotifications(routine);
  };

  const handleDelete = async (routine) => {
    if (!confirm(`Delete "${routine.title}"?`)) return;
    const next = await deleteRoutineFromStore(routine.id);
    setRoutines(next);
    await cancelRoutineNotifications(routine);
  };

  const handleToggleActive = async (routine) => {
    const updated = { ...routine, active: !routine.active };
    const next = await upsertRoutine(updated);
    setRoutines(next);
    await scheduleRoutineNotifications(updated);
  };

  const handleToggleComplete = async (routine, done) => {
    const next = await setCompletion(routine.id, todayKey(), done);
    setCompletions(next);
  };

  if (loading) {
    return <div className="app-shell loading">Loading…</div>;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Daily Routines</h1>
      </header>

      <main className="app-main">
        {tab === 'today' && (
          <TodayView routines={routines} completions={completions} onToggleComplete={handleToggleComplete} />
        )}
        {tab === 'routines' && (
          <RoutinesView
            routines={routines}
            onAdd={handleAdd}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onToggleActive={handleToggleActive}
          />
        )}
        {tab === 'dashboard' && <DashboardView routines={routines} completions={completions} />}
        {tab === 'history' && <HistoryView routines={routines} completions={completions} />}
      </main>

      <nav className="app-tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            <t.Icon size={20} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export default App;
