import { useEffect, useRef, useState } from 'react';
import { Sun, ListTodo, BarChart3, Calendar } from 'lucide-react';
import './App.css';
import TodayView from './components/TodayView';
import RoutinesView from './components/RoutinesView';
import DashboardView from './components/DashboardView';
import HistoryView from './components/HistoryView';
import Logo from './components/Logo';
import UpdateChecker from './components/UpdateChecker';
import WorkoutSessionView from './components/WorkoutSessionView';
import {
  isNativeWorkoutSessionAvailable,
  startNativeWorkoutSession,
  initWorkoutSetListener,
} from './nativeWorkoutSession';
import {
  initDueReminderActionListener,
  initBackgroundSyncListener,
  initNotificationTapListener,
} from './nativeNotifications';
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
  logWorkoutSet,
  getAllWorkoutLogs,
} from './storage';
import {
  initNotifications,
  scheduleTaskNotifications,
  cancelTaskNotifications,
  cancelRoutineGroupSummary,
  updateRoutineGroupSummary,
  syncAllNotifications,
  syncDynamicNotifications,
  refreshTaskReminderVisibility,
} from './notifications';
import { todayKey } from './utils/date';
import { computeSessionFraction } from './utils/workouts';

function findTask(routines, taskId) {
  for (const routine of routines) {
    const task = routine.tasks.find((t) => t.id === taskId);
    if (task) return task;
  }
  return null;
}

function findRoutineForTask(routines, taskId) {
  return routines.find((routine) => routine.tasks.some((t) => t.id === taskId)) || null;
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
  const [workoutLogsByTask, setWorkoutLogsByTask] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeSession, setActiveSession] = useState(null);
  const [focusTarget, setFocusTarget] = useState(null);
  const handleLogWorkoutSetRef = useRef(null);

  const refreshAll = async () => {
    const [storedRoutines, storedCompletions, versionsMap, workoutLogs] = await Promise.all([
      getRoutines(),
      getCompletions(),
      getTaskVersionsForAnalytics(),
      getAllWorkoutLogs(),
    ]);
    setRoutines(storedRoutines);
    setCompletions(storedCompletions);
    setTaskVersionsMap(versionsMap);
    setWorkoutLogsByTask(workoutLogs);
    return {
      routines: storedRoutines,
      completions: storedCompletions,
      taskVersionsMap: versionsMap,
      workoutLogsByTask: workoutLogs,
    };
  };

  useEffect(() => {
    (async () => {
      const state = await refreshAll();
      setLoading(false);
      await initNotifications();
      await syncAllNotifications(state.routines, state.completions);
      await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
    })();

    const handleMarkDone = async (taskId) => {
      await setCompletion(taskId, todayKey(), true);
      const state = await refreshAll();
      await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
      const task = findTask(state.routines, taskId);
      if (task) await refreshTaskReminderVisibility(task, state.completions);
      const routine = findRoutineForTask(state.routines, taskId);
      if (routine) await updateRoutineGroupSummary(routine, state.completions);
    };
    const handleAddQuantity = async (taskId, amount) => {
      await addToCompletion(taskId, todayKey(), amount);
      const state = await refreshAll();
      await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
      const task = findTask(state.routines, taskId);
      const routine = findRoutineForTask(state.routines, taskId);
      // Refreshes the reminder's own body with the new live progress (see
      // taskNotificationContent) if it's already pinned/showing - a partial quick-add from the
      // notification itself is the clearest case where the user needs to see this update
      // immediately, not on the next natural re-fire.
      if (task) await scheduleTaskNotifications(task, routine, state.completions);
      if (task) await refreshTaskReminderVisibility(task, state.completions);
      if (routine) await updateRoutineGroupSummary(routine, state.completions);
    };

    // Native due-reminder and extra-reminder Mark-done/+N action buttons both feed this one
    // listener (see src/nativeNotifications.js and android/.../notify/) - every notification
    // action in the app is native now, there's no stock-plugin listener left to wire.
    const dueReminderListenerPromise = initDueReminderActionListener(handleMarkDone, handleAddQuantity);

    // Tapping any native notification's body (see NotificationTapIntent.kt) lands here, whether
    // the app process was cold or already running - see initNotificationTapListener's own
    // comment for why both starts funnel into the same JS event. Switches to Today and hands the
    // target down so TodayView can scroll to and highlight the exact task/routine.
    const notificationTapListenerPromise = initNotificationTapListener((taskId, routineId) => {
      setTab('today');
      setFocusTarget({ taskId, routineId });
    });

    const workoutListenerPromise = initWorkoutSetListener(async (taskId, dateKey, exercise, setIndex, values) => {
      const state = await refreshAll();
      const task = findTask(state.routines, taskId);
      if (task) await handleLogWorkoutSetRef.current(task, dateKey, exercise, setIndex, values);
    });

    // Fired roughly every 15 minutes by the native background-sync foreground service (see
    // BackgroundSyncService.kt) as long as the app process is alive, foreground or backgrounded
    // - keeps digest/summary/streak-risk content fresh without requiring the user to reopen the
    // app. Same call sequence as the app-open effect above.
    const backgroundSyncListenerPromise = initBackgroundSyncListener(async () => {
      const state = await refreshAll();
      await syncAllNotifications(state.routines, state.completions);
      await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
    });

    return () => {
      dueReminderListenerPromise?.then((handle) => handle.remove());
      notificationTapListenerPromise?.then((handle) => handle.remove());
      workoutListenerPromise?.then((handle) => handle.remove());
      backgroundSyncListenerPromise?.then((handle) => handle.remove());
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
    await syncAllNotifications(state.routines, state.completions);
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  const handleDeleteRoutine = async (routine) => {
    if (!confirm(`Delete "${routine.title}"? This removes all its tasks too.`)) return;
    for (const task of routine.tasks) {
      await cancelTaskNotifications(task);
    }
    await cancelRoutineGroupSummary(routine.id);
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
        await scheduleTaskNotifications(task, savedRoutine, state.completions);
      } else {
        await cancelTaskNotifications(task);
      }
    }
    if (savedRoutine) await updateRoutineGroupSummary(savedRoutine, state.completions);
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  const handleToggleTaskActive = async (task) => {
    await upsertTask({ ...task, active: !task.active });
    const state = await refreshAll();
    const savedRoutine = state.routines.find((r) => r.id === task.routineId);
    const savedTask = savedRoutine?.tasks.find((t) => t.id === task.id);
    if (savedTask?.active) {
      await scheduleTaskNotifications(savedTask, savedRoutine, state.completions);
    } else {
      await cancelTaskNotifications(task);
      if (savedRoutine) await updateRoutineGroupSummary(savedRoutine, state.completions);
    }
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  const handleToggleComplete = async (task, done, dateKey = todayKey()) => {
    const next = await setCompletion(task.id, dateKey, done);
    setCompletions(next);
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, next);
      await refreshTaskReminderVisibility(task, next);
      const routine = findRoutineForTask(routines, task.id);
      if (routine) await updateRoutineGroupSummary(routine, next);
    }
  };

  const handleAddQuantity = async (task, delta, dateKey = todayKey()) => {
    const next = await addToCompletion(task.id, dateKey, delta);
    setCompletions(next);
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, next);
      const routine = findRoutineForTask(routines, task.id);
      // Refreshes the reminder's live progress body in place (see taskNotificationContent) -
      // a quick-add should never wait for the reminder's next natural fire to reflect it.
      await scheduleTaskNotifications(task, routine, next);
      await refreshTaskReminderVisibility(task, next);
      if (routine) await updateRoutineGroupSummary(routine, next);
    }
  };

  const handleSetQuantity = async (task, value, dateKey = todayKey()) => {
    const next = await setCompletion(task.id, dateKey, value);
    setCompletions(next);
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, next);
      const routine = findRoutineForTask(routines, task.id);
      await scheduleTaskNotifications(task, routine, next);
      await refreshTaskReminderVisibility(task, next);
      if (routine) await updateRoutineGroupSummary(routine, next);
    }
  };

  const handleStartWorkout = (task, routine, dateKey) => {
    if (isNativeWorkoutSessionAvailable()) {
      const logsForDate = workoutLogsByTask[task.id]?.[dateKey] || {};
      startNativeWorkoutSession(task, dateKey, logsForDate);
      return;
    }
    setActiveSession({ task, routine, dateKey });
  };

  const handleCloseSession = () => {
    setActiveSession(null);
  };

  const handleLogWorkoutSet = async (task, dateKey, exercise, setIndex, values) => {
    const nextLogsByTask = await logWorkoutSet(task.id, dateKey, exercise, setIndex, values);
    setWorkoutLogsByTask(nextLogsByTask);
    const logsForDate = nextLogsByTask[task.id]?.[dateKey] || {};
    const fraction = computeSessionFraction(task.exercises, logsForDate);
    const nextCompletions = await setCompletion(task.id, dateKey, fraction);
    setCompletions(nextCompletions);
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, nextCompletions);
      await refreshTaskReminderVisibility(task, nextCompletions);
      const routine = findRoutineForTask(routines, task.id);
      if (routine) await updateRoutineGroupSummary(routine, nextCompletions);
    }
  };
  handleLogWorkoutSetRef.current = handleLogWorkoutSet;

  if (loading) {
    return <div className="app-shell loading">Loading…</div>;
  }

  if (activeSession) {
    const logsForDate = workoutLogsByTask[activeSession.task.id]?.[activeSession.dateKey] || {};
    return (
      <div className="app-shell">
        <WorkoutSessionView
          task={activeSession.task}
          logsForDate={logsForDate}
          onLogSet={(exercise, setIndex, values) =>
            handleLogWorkoutSet(activeSession.task, activeSession.dateKey, exercise, setIndex, values)
          }
          onClose={handleCloseSession}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="icon-badge app-logo-badge">
          <Logo size={20} />
        </span>
        <h1>Daily Routines</h1>
        <UpdateChecker />
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
            onStartWorkout={handleStartWorkout}
            focusTaskId={focusTarget?.taskId}
            focusRoutineId={focusTarget?.routineId}
            onFocusHandled={() => setFocusTarget(null)}
          />
        )}
        {tab === 'routines' && (
          <RoutinesView
            routines={routines}
            completions={completions}
            taskVersionsMap={taskVersionsMap}
            onSaveRoutine={handleSaveRoutine}
            onDeleteRoutine={handleDeleteRoutine}
            onToggleRoutineActive={handleToggleRoutineActive}
            onToggleTaskActive={handleToggleTaskActive}
          />
        )}
        {tab === 'dashboard' && (
          <DashboardView
            routines={routines}
            completions={completions}
            taskVersionsMap={taskVersionsMap}
            workoutLogsByTask={workoutLogsByTask}
          />
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
