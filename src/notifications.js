import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { calcRoutineStreak, getRoutineFraction, todayKey } from './utils/date';
import { quickAddAmountsFor, isTaskDoneToday, MAX_EXTRA_REMINDERS } from './utils/tasks';
import {
  showSummaryNotification,
  cancelSummaryNotification,
  nativeScheduleDueReminder,
  nativeCancelDueReminder,
  nativeDismissDueReminderToday,
  nativeScheduleExtraReminder,
  nativeCancelExtraReminderSlot,
  nativeCancelExtraReminders,
  nativeDismissExtraRemindersToday,
  nativeUpdateGroupSummary,
  nativeCancelGroupSummary,
  nativeScheduleDailyDigest,
  nativeCancelDailyDigest,
} from './nativeNotifications';

const MORNING_HOUR = 8;
const EVENING_HOUR = 21;
const STREAK_RISK_HOUR = 19;
const STREAK_RISK_MIN_STREAK = 2;

/**
 * Every notification in the app now posts through native Kotlin (see CLAUDE.md's "Native
 * notifications" section) - @capacitor/local-notifications schedules nothing anymore. It's kept
 * installed solely for this permission check/request: its Android implementation genuinely
 * requests the runtime `POST_NOTIFICATIONS` permission (confirmed by reading its source,
 * `LocalNotificationsPlugin.java`'s `@Permission` annotation), and replacing that with an
 * equivalent custom permission flow on NativeNotificationsPlugin (Capacitor's
 * `@Permission`/`requestPermissionForAlias` machinery) was judged not worth the risk of a
 * plumbing mistake silently breaking notification permissions for every new install - this is
 * the one remaining real capability keeping the dependency, not an oversight.
 */
export async function initNotifications() {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      await LocalNotifications.requestPermissions();
    }
    return true;
  } catch (err) {
    console.warn('Notification init failed', err);
    return false;
  }
}

/** Full teardown of every native reminder for a task. Used when a task is actually being removed or paused, not just rescheduled. */
export async function cancelTaskNotifications(task) {
  if (!Capacitor.isNativePlatform()) return;
  await nativeCancelDueReminder(task.id);
  await nativeCancelExtraReminders(task.id);
}

/**
 * Dismisses whatever reminder(s) for this task are currently showing in the
 * shade, for today only - used once a task is marked done so the "stays open
 * while pending" notification (see scheduleTaskNotifications) actually goes
 * away, without touching the underlying recurring schedule for future days.
 */
export async function dismissTaskReminders(task) {
  if (!Capacitor.isNativePlatform()) return;
  await nativeDismissDueReminderToday(task.id);
  await nativeDismissExtraRemindersToday(task.id);
}

/** Call after any completion change so a just-completed task's pinned reminder clears immediately. */
export async function refreshTaskReminderVisibility(task, completions) {
  if (!Capacitor.isNativePlatform() || !isTaskDoneToday(task, completions)) return;
  await dismissTaskReminders(task);
}

/**
 * `completions` drives the one piece of content that needs to be *live*, not just recomputed
 * on the next natural fire: a quantity task's body is its current progress (matching the
 * "actual / target unit" format TodayView's own QuantityControl already shows), not a static
 * blurb - so a quick-add can refresh an already-pinned reminder in place (see
 * scheduleTaskNotifications' callers in App.jsx) instead of only updating once the reminder
 * happens to re-fire on its own.
 */
function taskNotificationContent(task, routine, completions = {}) {
  const title = routine && routine.title !== task.title ? `${routine.title} · ${task.title}` : task.title;
  let body = (routine && routine.notes) || 'Time to complete your task';
  if (task.completionType === 'quantity') {
    const actual = completions[task.id]?.[todayKey()] || 0;
    const target = task.target || 0;
    body = `${actual} / ${target}${task.unit ? ` ${task.unit}` : ''}`;
  }
  const group = routine && routine.tasks.length > 1 ? `routine-${routine.id}` : undefined;
  return { title, body, group };
}

/**
 * A real, expandable Android group-summary notification (InboxStyle, one line per
 * currently-pending task) for a multi-task routine, so its individual due reminders collapse
 * into one expandable entry in the shade that always lists exactly which tasks are still
 * pending right now - not just a stale count. Recomputed on every schedule change AND on every
 * completion change (see refreshTaskReminderVisibility's callers in App.jsx), so the pending
 * list is always current.
 */
export async function updateRoutineGroupSummary(routine, completions = {}) {
  if (!Capacitor.isNativePlatform() || !routine) return;
  const activeTasks = routine.tasks.filter((t) => t.active && t.days.length > 0);
  // Only worth a group summary once there are 2+ *active* tasks to collapse -
  // routine.tasks.length alone (used for the `group` tag on individual
  // reminders) undercounts a routine that's mostly paused down to one task.
  if (!routine.active || routine.archived || activeTasks.length <= 1) {
    await cancelRoutineGroupSummary(routine.id);
    return;
  }
  const pendingTaskTitles = activeTasks.filter((t) => !isTaskDoneToday(t, completions)).map((t) => t.title);
  await nativeUpdateGroupSummary(routine.id, routine.title, pendingTaskTitles);
}

export async function cancelRoutineGroupSummary(routineId) {
  if (!Capacitor.isNativePlatform()) return;
  await nativeCancelGroupSummary(routineId);
}

export async function scheduleTaskNotifications(task, routine, completions = {}) {
  if (!Capacitor.isNativePlatform()) return;
  if (!task.active || task.days.length === 0 || routine?.active === false || routine?.archived) {
    await nativeCancelDueReminder(task.id);
    await nativeCancelExtraReminders(task.id);
    if (routine) await updateRoutineGroupSummary(routine, completions);
    return;
  }

  const { title, body, group } = taskNotificationContent(task, routine, completions);
  const [hour, minute] = task.time.split(':').map(Number);

  // The due-by reminder and its extra nudge times are both scheduled natively - one
  // self-rescheduling alarm per (task) for the due-by moment (see nativeScheduleDueReminder)
  // and one per (task, slot) for each extra reminder (see nativeScheduleExtraReminder), each
  // covering every day in task.days with a single alarm rather than one recurring schedule per
  // (day, slot) the way the stock plugin required.
  const extraTimes = (task.reminderTimes || []).slice(0, MAX_EXTRA_REMINDERS);
  for (let slot = 0; slot < extraTimes.length; slot++) {
    const [h, m] = extraTimes[slot].split(':').map(Number);
    await nativeScheduleExtraReminder({
      taskId: task.id,
      slot,
      routineId: routine?.id,
      title,
      body,
      days: task.days,
      hour: h,
      minute: m,
      group,
      completionType: task.completionType,
      quickAddAmounts: task.completionType === 'quantity' ? quickAddAmountsFor(task) : [],
    });
  }
  // Cancel any slots beyond however many extra times are configured now (e.g. the user removed one).
  for (let slot = extraTimes.length; slot < MAX_EXTRA_REMINDERS; slot++) {
    await nativeCancelExtraReminderSlot(task.id, slot);
  }

  await nativeScheduleDueReminder({
    taskId: task.id,
    routineId: routine?.id,
    title,
    body,
    days: task.days,
    hour,
    minute,
    group,
    completionType: task.completionType,
    quickAddAmounts: task.completionType === 'quantity' ? quickAddAmountsFor(task) : [],
    // Lets DueReminderScheduler catch up immediately on an already-overdue, not-yet-done task
    // instead of waiting for its next natural occurrence (which may be a week away) - see
    // DueReminderScheduler.schedule's isDoneToday param for why this can't be computed natively.
    isDoneToday: isTaskDoneToday(task, completions),
  });
  if (routine) await updateRoutineGroupSummary(routine, completions);
}

export async function syncAllNotifications(routines, completions = {}) {
  if (!Capacitor.isNativePlatform()) return;
  for (const routine of routines) {
    for (const task of routine.tasks) {
      await scheduleTaskNotifications(task, routine, completions);
    }
  }
}

function activeDueRoutines(routines, taskVersionsMap, completions, date) {
  return routines
    .map((routine) => ({ routine, fraction: getRoutineFraction(routine, taskVersionsMap, completions, date) }))
    .filter((r) => r.fraction !== null);
}

function formatRoutineList(entries) {
  return entries.map((r) => r.routine.title).join(', ');
}

/** e.g. "Push-ups 30% · Water 60%" - each still-due routine's actual fraction, not just its name. */
function formatRoutineProgress(entries) {
  return entries.map((r) => `${r.routine.title} ${Math.round(r.fraction * 100)}%`).join(' · ');
}

/**
 * Refreshes the persistent "today at a glance" notification. Posted natively (see
 * nativeNotifications.js) with a real setDeleteIntent() rather than through
 * @capacitor/local-notifications, so a swipe-dismiss reappears immediately instead of just
 * vanishing - @capacitor/local-notifications builds its notifications with no exposed hook for
 * a custom delete-intent at all (see CLAUDE.md). Still no live-ticking chronometer display here
 * (that's only feasible via a real foreground service, see the workout session), just a
 * point-in-time snapshot recomputed on every app-open/completion change.
 *
 * Title shows the actual overall completion (average of every due routine's
 * own fraction, itself an average of its due tasks' fractions - see
 * getRoutineFraction), not a coarse done/not-done routine count: a routine
 * sitting at 90% (e.g. 9/10 reps on a quantity task) reads as real progress
 * here instead of counting identically to a routine at 0%. The body lists
 * each still-due routine's own percentage for the same reason.
 */
export async function updateSummaryNotification(routines, taskVersionsMap, completions) {
  if (!Capacitor.isNativePlatform()) return;
  const today = new Date();
  const due = activeDueRoutines(routines, taskVersionsMap, completions, today);
  if (due.length === 0) {
    await cancelSummaryNotification();
    return;
  }
  const overallFraction = due.reduce((sum, r) => sum + r.fraction, 0) / due.length;
  const overallPct = Math.round(overallFraction * 100);
  const remaining = due.filter((r) => r.fraction < 1);
  const body = remaining.length === 0 ? 'All done for today 🎉' : formatRoutineProgress(remaining);

  try {
    await showSummaryNotification(`Today: ${overallPct}% complete`, body, remaining.length > 0);
  } catch (err) {
    console.warn('Failed to update summary notification', err);
  }
}

async function updateStreakRiskNotification(routines, taskVersionsMap, completions) {
  const today = new Date();
  const atRisk = routines.filter((routine) => {
    if (!routine.active) return false;
    const fraction = getRoutineFraction(routine, taskVersionsMap, completions, today);
    if (fraction === null || fraction === 1) return false;
    return calcRoutineStreak(routine, taskVersionsMap, completions) >= STREAK_RISK_MIN_STREAK;
  });

  if (atRisk.length === 0) {
    await nativeCancelDailyDigest('streak-risk');
    return;
  }

  const names = atRisk.map((r) => r.title).join(', ');
  const body =
    atRisk.length === 1
      ? `Finish "${names}" today to keep your streak alive.`
      : `${names} still need finishing to keep their streaks alive.`;
  const title = atRisk.length === 1 ? 'Your streak is at risk' : 'Streaks at risk tonight';

  await nativeScheduleDailyDigest('streak-risk', title, body, STREAK_RISK_HOUR, 0);
}

async function updateMorningDigest(routines, taskVersionsMap, completions) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayDue = activeDueRoutines(routines, taskVersionsMap, completions, yesterday);
  const yesterdayDone = yesterdayDue.filter((r) => r.fraction === 1).length;
  const yesterdaySummary = yesterdayDue.length
    ? `Yesterday: ${yesterdayDone}/${yesterdayDue.length} completed.`
    : 'No routines were due yesterday.';

  const todayDue = activeDueRoutines(routines, taskVersionsMap, completions, new Date());
  const todaySummary = todayDue.length
    ? `Today: ${formatRoutineList(todayDue)}.`
    : 'Nothing due today.';

  await nativeScheduleDailyDigest('morning', 'Good morning', `${yesterdaySummary} ${todaySummary}`, MORNING_HOUR, 0);
}

async function updateEveningDigest(routines, taskVersionsMap, completions) {
  const today = new Date();
  const todayDue = activeDueRoutines(routines, taskVersionsMap, completions, today);
  const todayDone = todayDue.filter((r) => r.fraction === 1).length;
  const todaySummary = todayDue.length
    ? `Today: ${todayDone}/${todayDue.length} completed.`
    : 'Nothing was due today.';

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDue = activeDueRoutines(routines, taskVersionsMap, completions, tomorrow);
  const tomorrowSummary = tomorrowDue.length
    ? `Tomorrow: ${formatRoutineList(tomorrowDue)}.`
    : 'Nothing due tomorrow.';

  await nativeScheduleDailyDigest('evening', 'Evening wrap-up', `${todaySummary} ${tomorrowSummary}`, EVENING_HOUR, 0);
}

/**
 * Refreshes every "computed" notification (persistent summary, streak-risk nudge, morning/
 * evening digests). None of these can be freshly computed at the moment they fire - they need
 * SQLite completions data, which native code must never touch directly - so content reflects
 * whatever it was the last time this ran. Called on every app open, after every completion
 * change, and (via initBackgroundSyncListener in App.jsx) roughly every 15 minutes while the app
 * process is alive thanks to the native background-sync foreground service - see CLAUDE.md for
 * the tradeoffs and the reasoning behind that service.
 */
export async function syncDynamicNotifications(routines, taskVersionsMap, completions) {
  if (!Capacitor.isNativePlatform()) return;
  await updateSummaryNotification(routines, taskVersionsMap, completions);
  await updateStreakRiskNotification(routines, taskVersionsMap, completions);
  await updateMorningDigest(routines, taskVersionsMap, completions);
  await updateEveningDigest(routines, taskVersionsMap, completions);
}
