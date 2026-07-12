import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Sun, ListTodo, BarChart3, Calendar, TrendingUp, Settings as SettingsIcon } from 'lucide-react';
import './App.css';
import TodayView from './components/TodayView';
import RoutinesView from './components/RoutinesView';
import DashboardView from './components/DashboardView';
import AnalyticsV2View from './components/AnalyticsV2View';
import HistoryView from './components/HistoryView';
import Logo from './components/Logo';
import UpdateChecker, { UpdateStatusBar } from './components/UpdateChecker';
import { useUpdateChecker } from './hooks/useUpdateChecker';
import SettingsView from './components/SettingsView';
import WorkoutSessionView from './components/WorkoutSessionView';
import QuantityTimerView from './components/QuantityTimerView';
import {
  isNativeWorkoutSessionAvailable,
  startNativeWorkoutSession,
  initWorkoutSetListener,
  initWorkoutRestartListener,
  startNativeQuantityTimer,
  initQuantityTimerListener,
} from './nativeWorkoutSession';
import {
  initDueReminderActionListener,
  initBackgroundSyncListener,
  initNotificationTapListener,
} from './nativeNotifications';
import {
  getRoutines,
  upsertRoutine,
  archiveRoutine as archiveRoutineFromStore,
  restoreRoutine as restoreRoutineFromStore,
  permanentlyDeleteRoutine as permanentlyDeleteRoutineFromStore,
  upsertTask,
  deleteTask as deleteTaskFromStore,
  getCompletions,
  getCompletionTimestamps,
  setCompletion,
  addToCompletion,
  getTaskVersionsForAnalytics,
  logWorkoutSet,
  getAllWorkoutLogs,
  resetWorkoutSessionForToday,
  getTaskReschedulesForAnalytics,
  setTaskReschedule,
  clearTaskReschedule,
  getExerciseNames,
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
import { computeSessionFraction, buildWorkoutLogSources } from './utils/workouts';
import { runAutoBackup } from './backup';

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
  // A second, additive analytics surface (see CLAUDE.md's "Analytics 2") - deliberately its own
  // tab rather than folded into the existing Dashboard tab above, so nothing about that tab's
  // behavior changes for anyone who never opens this one.
  { id: 'analyticsV2', label: 'Analytics 2', Icon: TrendingUp },
];

function App() {
  const [tab, setTab] = useState('today');
  const [routines, setRoutines] = useState([]);
  const [completions, setCompletions] = useState({});
  const [taskVersionsMap, setTaskVersionsMap] = useState({});
  const [reschedulesMap, setReschedulesMap] = useState({});
  const [workoutLogsByTask, setWorkoutLogsByTask] = useState({});
  // Analytics 2 only - see CLAUDE.md. completionTimestamps powers on-time-rate tracking;
  // exerciseCategories is the exercise repository's own {id, name, category} rows, used to
  // classify workout tasks (Strength/Bodyweight/Stretch & Mobility/Yoga/...) for the Workout
  // Detail screen. Neither is read by any pre-existing screen.
  const [completionTimestamps, setCompletionTimestamps] = useState({});
  const [exerciseCategories, setExerciseCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeSession, setActiveSession] = useState(null);
  const [focusTarget, setFocusTarget] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const updateChecker = useUpdateChecker();
  const handleLogWorkoutSetRef = useRef(null);
  const handleLogQuantityTimerRef = useRef(null);
  const handleRestartWorkoutRef = useRef(null);
  const autoArchiveInFlightRef = useRef(null);

  const refreshAll = async () => {
    const [storedRoutines, storedCompletions, versionsMap, workoutLogs, reschedules, timestamps, exerciseRepo] =
      await Promise.all([
        getRoutines(),
        getCompletions(),
        getTaskVersionsForAnalytics(),
        getAllWorkoutLogs(),
        getTaskReschedulesForAnalytics(),
        getCompletionTimestamps(),
        getExerciseNames(),
      ]);
    setRoutines(storedRoutines);
    setCompletions(storedCompletions);
    setTaskVersionsMap(versionsMap);
    setWorkoutLogsByTask(workoutLogs);
    setReschedulesMap(reschedules);
    setCompletionTimestamps(timestamps);
    setExerciseCategories(exerciseRepo);
    return {
      routines: storedRoutines,
      completions: storedCompletions,
      taskVersionsMap: versionsMap,
      workoutLogsByTask: workoutLogs,
      reschedulesMap: reschedules,
      completionTimestamps: timestamps,
      exerciseCategories: exerciseRepo,
    };
  };

  // Re-derives every screen's data and re-syncs every notification from scratch - the same
  // sequence the app-open effect below already runs. Reused as SettingsView's onImported
  // callback: a restored backup swaps the entire database out from under the app (see
  // backup.js/db.js), so everything on screen and every scheduled reminder/digest needs
  // recomputing against the restored data, not just a plain re-render.
  const refreshAllAndSync = async () => {
    const state = await refreshAll();
    await syncAllNotifications(state.routines, state.completions, state.reschedulesMap);
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
    return state;
  };

  // Auto-archives any routine whose configured endDate has passed - reuses archiveRoutine's
  // exact same mechanism (and its already-correct "history before archival stays intact"
  // cutover, see getRoutineFraction) a manual archive uses, just without the confirm() dialog
  // since this fires unattended. Cancels notifications first, matching handleArchiveRoutine
  // below, so a freshly-expired routine's reminders stop in this same pass rather than lingering
  // until some later resync happens to notice routine.archived flipped. There's no backend/cron
  // here, so this can only ever run when the app process is actually alive to check - called
  // before every refreshAll() below and from the background-sync tick, the same "best effort
  // while the process is alive" tradeoff every other computed-content feature in this app makes.
  //
  // Guarded by an in-flight-promise singleton (the same pattern storage.js's own ready()/
  // readyPromise already uses) rather than plain sequential awaits, because this can genuinely
  // be invoked twice concurrently: React StrictMode double-invokes the mount effect in dev,
  // and in production the app-open effect and the background-sync tick can legitimately race
  // each other. Two concurrent invocations each issuing their own archiveRoutine() write
  // sequence hit this app's known "web SQLite backend can't handle concurrent db.query/db.run"
  // failure mode (the exact "cannot start a transaction within a transaction" error already
  // documented for resolveExerciseIds/permanentlyDeleteRoutine) - caught via a Playwright
  // round-trip reload, not by inspection. A second caller now just awaits the first's
  // already-in-flight promise instead of starting a colliding second write sequence.
  const autoArchiveExpiredRoutines = () => {
    if (!autoArchiveInFlightRef.current) {
      autoArchiveInFlightRef.current = (async () => {
        try {
          const currentRoutines = await getRoutines();
          const today = todayKey();
          for (const routine of currentRoutines) {
            if (routine.archived || !routine.endDate || routine.endDate > today) continue;
            for (const task of routine.tasks) {
              await cancelTaskNotifications(task);
            }
            await cancelRoutineGroupSummary(routine.id);
            await archiveRoutineFromStore(routine.id);
          }
        } finally {
          autoArchiveInFlightRef.current = null;
        }
      })();
    }
    return autoArchiveInFlightRef.current;
  };

  // Native-only, like SettingsView's own identical fetch - there's no installed build to report
  // on web. Surfaced right in the header (not just inside Settings) so which release is running
  // is visible at a glance, without an extra tap.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    CapacitorApp.getInfo()
      .then((info) => setAppVersion(info.version))
      .catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      await autoArchiveExpiredRoutines();
      const state = await refreshAll();
      setLoading(false);
      await initNotifications();
      await syncAllNotifications(state.routines, state.completions, state.reschedulesMap);
      await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
      // Fire-and-forget: a fresh automatic local snapshot every time the app is opened (see
      // backup.js's runAutoBackup for why "on every open" is exactly the right cadence for
      // "seamless, before every release" protection) - nothing on screen waits on this call's
      // own completion, only its *start* is sequenced after the writes above. A real bug found
      // via a Playwright round-trip ("cannot start a transaction within a transaction") when
      // this used to fire concurrently with them: the web SQLite backend's single connection
      // isn't safe for concurrent db.query/db.run calls, the same constraint already documented
      // for resolveExerciseIds/permanentlyDeleteRoutine.
      runAutoBackup().catch((err) => console.warn('Automatic local backup failed', err));
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
      if (task) await scheduleTaskNotifications(task, routine, state.completions, state.reschedulesMap[task.id] || []);
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

    // Fired once when the native "pure timer" screen (a quantity task set up as a timer) logs
    // its one value - see nativeWorkoutSession.js's startNativeQuantityTimer/QuantityTimerScreen.
    const quantityTimerListenerPromise = initQuantityTimerListener(async (taskId, dateKey, seconds) => {
      const state = await refreshAll();
      const task = findTask(state.routines, taskId);
      if (task) await handleLogQuantityTimerRef.current(task, dateKey, seconds);
    });

    // Fired once the user confirms "Restart workout" on the native session screen - the screen's
    // own local state already reset itself synchronously; this just performs the actual
    // destructive DB write (resetWorkoutSessionForToday), same as the web path's onRestartWorkout.
    const workoutRestartListenerPromise = initWorkoutRestartListener(async (taskId, dateKey) => {
      const state = await refreshAll();
      const task = findTask(state.routines, taskId);
      if (task) await handleRestartWorkoutRef.current(task, dateKey);
    });

    // Fired roughly every 15 minutes by the native background-sync foreground service (see
    // BackgroundSyncService.kt) as long as the app process is alive, foreground or backgrounded
    // - keeps digest/summary/streak-risk content fresh without requiring the user to reopen the
    // app. Same call sequence as the app-open effect above.
    const backgroundSyncListenerPromise = initBackgroundSyncListener(async () => {
      await autoArchiveExpiredRoutines();
      const state = await refreshAll();
      await syncAllNotifications(state.routines, state.completions, state.reschedulesMap);
      await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
    });

    return () => {
      dueReminderListenerPromise?.then((handle) => handle.remove());
      notificationTapListenerPromise?.then((handle) => handle.remove());
      workoutListenerPromise?.then((handle) => handle.remove());
      quantityTimerListenerPromise?.then((handle) => handle.remove());
      workoutRestartListenerPromise?.then((handle) => handle.remove());
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
    await syncAllNotifications(state.routines, state.completions, state.reschedulesMap);
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  // One upsertRoutine + upsertTask pass per {routine, tasks} pair aiImport.js's parseAiImportText
  // produced - identical to handleSaveRoutine's own write pattern above, since these are genuine
  // new routines with fresh ids, not an edit to an existing one. Purely additive: nothing already
  // in the app is read, diffed, or touched.
  const handleAiImport = async (results) => {
    for (const { routine, tasks } of results) {
      await upsertRoutine(routine);
      for (const task of tasks) {
        await upsertTask({ ...task, routineId: routine.id });
      }
    }
    await refreshAllAndSync();
  };

  const handleArchiveRoutine = async (routine) => {
    if (
      !confirm(
        `Archive "${routine.title}"? It'll disappear from Today and stop sending reminders, but every bit of its history stays intact. You can restore it anytime from Archived routines.`
      )
    )
      return;
    for (const task of routine.tasks) {
      await cancelTaskNotifications(task);
    }
    await cancelRoutineGroupSummary(routine.id);
    await archiveRoutineFromStore(routine.id);
    const state = await refreshAll();
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  const handleRestoreRoutine = async (routine) => {
    await restoreRoutineFromStore(routine.id);
    const state = await refreshAll();
    const savedRoutine = state.routines.find((r) => r.id === routine.id);
    if (savedRoutine) {
      for (const task of savedRoutine.tasks) {
        await scheduleTaskNotifications(task, savedRoutine, state.completions, state.reschedulesMap[task.id] || []);
      }
      await updateRoutineGroupSummary(savedRoutine, state.completions);
    }
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  const handlePermanentlyDeleteRoutine = async (routine) => {
    if (
      !confirm(
        `Permanently delete "${routine.title}"? This erases all of its tasks, completions, and history from this device. This cannot be undone.`
      )
    )
      return;
    await permanentlyDeleteRoutineFromStore(routine.id);
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
        await scheduleTaskNotifications(task, savedRoutine, state.completions, state.reschedulesMap[task.id] || []);
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
      await scheduleTaskNotifications(savedTask, savedRoutine, state.completions, state.reschedulesMap[savedTask.id] || []);
    } else {
      await cancelTaskNotifications(task);
      if (savedRoutine) await updateRoutineGroupSummary(savedRoutine, state.completions);
    }
    await syncDynamicNotifications(state.routines, state.taskVersionsMap, state.completions);
  };

  const handleToggleComplete = async (task, done, dateKey = todayKey()) => {
    const next = await setCompletion(task.id, dateKey, done);
    setCompletions(next);
    // Analytics 2's on-time-rate tracking (see CLAUDE.md) reads completion timestamps live -
    // without this, it would keep showing stale data until the next full refreshAll() (e.g. app
    // reopen), since these lightweight completion handlers only ever patched `completions`
    // before this field existed.
    setCompletionTimestamps(await getCompletionTimestamps());
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
    setCompletionTimestamps(await getCompletionTimestamps());
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, next);
      const routine = findRoutineForTask(routines, task.id);
      // Refreshes the reminder's live progress body in place (see taskNotificationContent) -
      // a quick-add should never wait for the reminder's next natural fire to reflect it.
      await scheduleTaskNotifications(task, routine, next, reschedulesMap[task.id] || []);
      await refreshTaskReminderVisibility(task, next);
      if (routine) await updateRoutineGroupSummary(routine, next);
    }
  };

  const handleSetQuantity = async (task, value, dateKey = todayKey()) => {
    const next = await setCompletion(task.id, dateKey, value);
    setCompletions(next);
    setCompletionTimestamps(await getCompletionTimestamps());
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, next);
      const routine = findRoutineForTask(routines, task.id);
      await scheduleTaskNotifications(task, routine, next, reschedulesMap[task.id] || []);
      await refreshTaskReminderVisibility(task, next);
      if (routine) await updateRoutineGroupSummary(routine, next);
    }
  };

  // "Something came up" - moves one occurrence of a due task to a different day without
  // touching its recurring schedule (task_reschedules, see storage.js/CLAUDE.md). Unlike the
  // completion handlers above, this needs a full refreshAll() rather than a completions-only
  // patch: a reschedule changes which days are *due* at all (Today's list, Dashboard, History
  // all read due-ness off taskVersionsMap/reschedulesMap together), not just what's logged on
  // one already-due day. Re-syncs the task's notifications afterward for when the native
  // one-off-date reminder scheduler lands - not built yet, so today this is a harmless no-op
  // (the reminder itself still fires on the task's original recurring day/time).
  const handleRescheduleTask = async (task, originalDate, newDate) => {
    await setTaskReschedule(task.id, originalDate, newDate);
    const state = await refreshAll();
    const routine = findRoutineForTask(state.routines, task.id);
    const savedTask = routine?.tasks.find((t) => t.id === task.id);
    if (savedTask) {
      await scheduleTaskNotifications(savedTask, routine, state.completions, state.reschedulesMap[task.id] || []);
    }
    if (routine) await updateRoutineGroupSummary(routine, state.completions);
  };

  const handleClearReschedule = async (task, originalDate) => {
    await clearTaskReschedule(task.id, originalDate);
    const state = await refreshAll();
    const routine = findRoutineForTask(state.routines, task.id);
    const savedTask = routine?.tasks.find((t) => t.id === task.id);
    if (savedTask) {
      await scheduleTaskNotifications(savedTask, routine, state.completions, state.reschedulesMap[task.id] || []);
    }
    if (routine) await updateRoutineGroupSummary(routine, state.completions);
  };

  const handleStartWorkout = (task, routine, dateKey) => {
    if (isNativeWorkoutSessionAvailable()) {
      const logsForDate = workoutLogsByTask[task.id]?.[dateKey] || {};
      const workoutLogSources = buildWorkoutLogSources(routines, workoutLogsByTask);
      startNativeWorkoutSession(task, dateKey, logsForDate, workoutLogSources);
      return;
    }
    setActiveSession({ task, routine, dateKey });
  };

  // A quantity task set up as a timer (RoutineForm's "Input as: Timer" mode) launches the same
  // native foreground-service-backed screen a workout session does (see
  // nativeWorkoutSession.js's startNativeQuantityTimer) - deliberately not a plain in-WebView JS
  // timer, so a long run survives backgrounding/screen-lock. `activeSession` is reused as-is for
  // the web/dev fallback; the render branch below picks WorkoutSessionView vs QuantityTimerView
  // by completionType.
  const handleStartQuantityTimer = (task, routine, dateKey) => {
    if (isNativeWorkoutSessionAvailable()) {
      startNativeQuantityTimer(task, dateKey);
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
    setCompletionTimestamps(await getCompletionTimestamps());
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, nextCompletions);
      await refreshTaskReminderVisibility(task, nextCompletions);
      const routine = findRoutineForTask(routines, task.id);
      if (routine) await updateRoutineGroupSummary(routine, nextCompletions);
    }
  };
  handleLogWorkoutSetRef.current = handleLogWorkoutSet;

  // "Restart workout" - discards today's logged sets for this task and resets its completion
  // fraction, so a session can be redone from scratch. The session view itself resets its own
  // local (synchronous) state the instant the user confirms, rather than waiting on this async
  // round-trip - see WorkoutSessionView.jsx's handleRestart.
  const handleRestartWorkout = async (task, dateKey) => {
    const { workoutLogsByTask: nextLogs, completions: nextCompletions } = await resetWorkoutSessionForToday(
      task.id,
      dateKey
    );
    setWorkoutLogsByTask(nextLogs);
    setCompletions(nextCompletions);
    setCompletionTimestamps(await getCompletionTimestamps());
    if (dateKey === todayKey()) {
      await syncDynamicNotifications(routines, taskVersionsMap, nextCompletions);
      await refreshTaskReminderVisibility(task, nextCompletions);
      const routine = findRoutineForTask(routines, task.id);
      if (routine) await updateRoutineGroupSummary(routine, nextCompletions);
    }
  };
  handleRestartWorkoutRef.current = handleRestartWorkout;

  // The one value a quantity-as-timer session logs - additive (via handleAddQuantity), matching
  // the plain quick-add buttons' own semantics, since a timer can reasonably be run more than
  // once in a day (e.g. two separate meditation sessions) and each run should add to the day's
  // total rather than overwrite it. "New best" for the auto-update-target opt-in is judged
  // against this one run's own seconds, not the day's accumulated total - a single 65s hold
  // against a 60s target is a new best regardless of what else was logged that day.
  const handleLogQuantityTimer = async (task, dateKey, seconds) => {
    await handleAddQuantity(task, seconds, dateKey);
    if (task.autoUpdateTarget && seconds > (task.target || 0)) {
      await upsertTask({ ...task, target: seconds });
      const state = await refreshAll();
      const savedRoutine = state.routines.find((r) => r.id === task.routineId);
      const savedTask = savedRoutine?.tasks.find((t) => t.id === task.id);
      if (savedTask) {
        await scheduleTaskNotifications(savedTask, savedRoutine, state.completions, state.reschedulesMap[task.id] || []);
      }
    }
  };
  handleLogQuantityTimerRef.current = handleLogQuantityTimer;

  if (loading) {
    return <div className="app-shell loading">Loading…</div>;
  }

  if (activeSession && activeSession.task.completionType === 'quantity') {
    return (
      <div className="app-shell">
        <QuantityTimerView
          task={activeSession.task}
          onLog={async (seconds) => {
            await handleLogQuantityTimer(activeSession.task, activeSession.dateKey, seconds);
            handleCloseSession();
          }}
          onClose={handleCloseSession}
        />
      </div>
    );
  }

  if (activeSession) {
    const logsForDate = workoutLogsByTask[activeSession.task.id]?.[activeSession.dateKey] || {};
    const workoutLogSources = buildWorkoutLogSources(routines, workoutLogsByTask);
    return (
      <div className="app-shell">
        <WorkoutSessionView
          task={activeSession.task}
          workoutLogSources={workoutLogSources}
          dateKey={activeSession.dateKey}
          logsForDate={logsForDate}
          onLogSet={(exercise, setIndex, values) =>
            handleLogWorkoutSet(activeSession.task, activeSession.dateKey, exercise, setIndex, values)
          }
          onRestartWorkout={() => handleRestartWorkout(activeSession.task, activeSession.dateKey)}
          onClose={handleCloseSession}
        />
      </div>
    );
  }

  if (showSettings) {
    return (
      <div className="app-shell">
        <SettingsView
          onClose={() => setShowSettings(false)}
          onImported={refreshAllAndSync}
          onAiImport={handleAiImport}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-row">
          <span className="icon-badge app-logo-badge">
            <Logo size={17} />
          </span>
          <h1>Daily Routines</h1>
          {appVersion && <span className="app-version-badge">v{appVersion}</span>}
          <UpdateChecker
            isNative={updateChecker.isNative}
            status={updateChecker.status}
            onCheck={() => updateChecker.runCheck(false)}
          />
          <button
            type="button"
            className="settings-btn"
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            title="Settings"
          >
            <SettingsIcon size={15} />
          </button>
        </div>
        {/* Renders as its own full-width block below the icon row above, not a flex sibling of
            those icons - this is what keeps every header icon (including the settings gear)
            always visible regardless of update status. See useUpdateChecker.js's doc comment. */}
        <UpdateStatusBar
          isNative={updateChecker.isNative}
          status={updateChecker.status}
          downloadFailReason={updateChecker.downloadFailReason}
          onInstall={updateChecker.installReadyUpdate}
          onDismiss={updateChecker.dismiss}
          onRetry={() => updateChecker.runCheck(false)}
        />
      </header>

      <main className="app-main">
        {tab === 'today' && (
          <TodayView
            routines={routines}
            completions={completions}
            taskVersionsMap={taskVersionsMap}
            reschedulesMap={reschedulesMap}
            onToggleComplete={handleToggleComplete}
            onAddQuantity={handleAddQuantity}
            onSetQuantity={handleSetQuantity}
            onStartWorkout={handleStartWorkout}
            onStartQuantityTimer={handleStartQuantityTimer}
            onRescheduleTask={handleRescheduleTask}
            onClearReschedule={handleClearReschedule}
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
            onArchiveRoutine={handleArchiveRoutine}
            onRestoreRoutine={handleRestoreRoutine}
            onPermanentlyDeleteRoutine={handlePermanentlyDeleteRoutine}
            onToggleRoutineActive={handleToggleRoutineActive}
            onToggleTaskActive={handleToggleTaskActive}
          />
        )}
        {tab === 'dashboard' && (
          <DashboardView
            routines={routines}
            completions={completions}
            taskVersionsMap={taskVersionsMap}
            reschedulesMap={reschedulesMap}
            workoutLogsByTask={workoutLogsByTask}
          />
        )}
        {tab === 'history' && (
          <HistoryView
            routines={routines}
            completions={completions}
            taskVersionsMap={taskVersionsMap}
            reschedulesMap={reschedulesMap}
          />
        )}
        {tab === 'analyticsV2' && (
          <AnalyticsV2View
            routines={routines}
            completions={completions}
            taskVersionsMap={taskVersionsMap}
            reschedulesMap={reschedulesMap}
            workoutLogsByTask={workoutLogsByTask}
            completionTimestamps={completionTimestamps}
            exerciseCategories={exerciseCategories}
          />
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
