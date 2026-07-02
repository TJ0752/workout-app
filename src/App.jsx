import { useEffect, useState } from 'react';
import { Sun, ListTodo, BarChart3, Calendar } from 'lucide-react';
import './App.css';
import TodayView from './components/TodayView';
import RoutinesView from './components/RoutinesView';
import DashboardView from './components/DashboardView';
import HistoryView from './components/HistoryView';
import Logo from './components/Logo';
import {
  getRoutines,
  upsertRoutine,
  deleteRoutine as deleteRoutineFromStore,
  upsertTask,
  deleteTask as deleteTaskFromStore,
  getCompletions,
  setCompletion,
  addToCompletion,
  getTaskVersionsForAnalytics,
} from './storage';
import {
  initNotifications,
  scheduleTaskNotifications,
  cancelTaskNotifications,
  syncAllNotifications,
  syncDynamicNotifications,
  refreshTaskReminderVisibility,
  initActionListener,
} from './notifications';
import { todayKey } from './utils/date';

function findTask(routines, taskId) {
  for (const routine of routines) {
    const task = routine.tasks.find((t) => t.id === taskId);
    if (task) return task;
  }
  return null;
}

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
  const [taskVersionsMap, setTaskVersionsMap] = useState({});
  const [loading, setLoading] = useState(true);

  const refreshAll = async () => {
    const [storedRoutines, storedCompletions, versionsMap] = await Promise.all([
      getRoutines(),
      getCompletions(),
      getTaskVersionsForAnalytics(),
    ]);
    setRoutines(storedRoutines);
    setCompletions(storedCompletions);
    setTaskVersionsMap(versionsMap);
    return { routines: storedRoutines, completions: storedCompletions, taskVersionsMap: versionsMap };
  };

  useEffect(() => {
    (async () => {
      const state = await refreshAll();
      setLoading(false);
      await initNotifications();
      await syncAllNotifications(state.routines);
      await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
    })();

    const listenerPromise = initActionListener({
      onMarkDone: async (taskId) => {
        await setCompletion(taskId, todayKey(), true);
        const state = await refreshAll();
        await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
        const task = findTask(state.routines, taskId);
        if (task) await refreshTaskReminderVisibility(task, state.completions);
      },
      onAddQuantity: async (taskId, amount) => {
        await addToCompletion(taskId, todayKey(), amount);
        const state = await refreshAll();
        await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
        const task = findTask(state.routines, taskId);
        if (task) await refreshTaskReminderVisibility(task, state.completions);
      },
    });

    return () => {
      listenerPromise?.then((handle) => handle.remove());
    };
  }, []);

  const handleSaveRoutine = async ({ routine, tasks, deletedTaskIds }) => {
    await upsertRoutine(routine);
    for (const taskId of deletedTaskIds) {
      await cancelTaskNotifications({ id: taskId });
      await deleteTaskFromStore(taskId);
    }
    for (const task of tasks) {
      await upsertTask({ ...task, routineId: routine.id });
    }
    const state = await refreshAll();
    await syncAllNotifications(state.routines);
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  const handleDeleteRoutine = async (routine) => {
    if (!confirm(`Delete "${routine.title}"? This removes all its tasks too.`)) return;
    for (const task of routine.tasks) {
      await cancelTaskNotifications(task);
    }
    await deleteRoutineFromStore(routine.id);
    const state = await refreshAll();
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  const handleToggleRoutineActive = async (routine) => {
    const updated = { ...routine, active: !routine.active };
    await upsertRoutine(updated);
    const state = await refreshAll();
    const savedRoutine = state.routines.find((r) => r.id === routine.id);
    for (const task of routine.tasks) {
      if (savedRoutine && savedRoutine.active) {
        await scheduleTaskNotifications(task, savedRoutine);
      } else {
        await cancelTaskNotifications(task);
      }
    }
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  const handleToggleTaskActive = async (task) => {
    await upsertTask({ ...task, active: !task.active });
    const state = await refreshAll();
    const savedRoutine = state.routines.find((r) => r.id === task.routineId);
    const savedTask = savedRoutine?.tasks.find((t) => t.id === task.id);
    if (savedTask?.active) {
      await scheduleTaskNotifications(savedTask, savedRoutine);
    } else {
      await cancelTaskNotifications(task);
    }
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  const handleToggleComplete = async (task, done, dateKey = todayKey()) => {
    const next = await setCompletion(task.id, dateKey, done);
    setCompletions(next);
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, next);
      await refreshTaskReminderVisibility(task, next);
    }
  };

  const handleAddQuantity = async (task, delta, dateKey = todayKey()) => {
    const next = await addToCompletion(task.id, dateKey, delta);
    setCompletions(next);
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, next);
      await refreshTaskReminderVisibility(task, next);
    }
  };

  const handleSetQuantity = async (task, value, dateKey = todayKey()) => {
    const next = await setCompletion(task.id, dateKey, value);
    setCompletions(next);
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, next);
      await refreshTaskReminderVisibility(task, next);
    }
  };

  if (loading) {
    return <div className="app-shell loading">Loading…</div>;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="icon-badge app-logo-badge">
          <Logo size={20} />
        </span>
        <h1>Daily Routines</h1>
      </header>

      <main className="app-main">
        {tab === 'today' && (
          <TodayView
            routines={routines}
            completions={completions}
            taskVersionsMap={taskVersionsMap}
            onToggleComplete={handleToggleComplete}
            onAddQuantity={handleAddQuantity}
            onSetQuantity={handleSetQuantity}
          />
        )}
        {tab === 'routines' && (
          <RoutinesView
            routines={routines}
            onSaveRoutine={handleSaveRoutine}
            onDeleteRoutine={handleDeleteRoutine}
            onToggleRoutineActive={handleToggleRoutineActive}
            onToggleTaskActive={handleToggleTaskActive}
          />
        )}
        {tab === 'dashboard' && (
          <DashboardView routines={routines} completions={completions} taskVersionsMap={taskVersionsMap} />
        )}
        {tab === 'history' && (
          <HistoryView routines={routines} completions={completions} taskVersionsMap={taskVersionsMap} />
        )}
      </main>

      <nav className="app-tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            <t.Icon size={20} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export default App;
