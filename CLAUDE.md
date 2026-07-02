# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Daily Routines" — an Android habit/routine tracker with local reminders and completion
analytics. React + Vite web app packaged as a native Android app via Capacitor. All data
is stored on-device in SQLite; there is no backend.

## Commands

```bash
npm install
npm run dev      # Vite dev server — fastest way to iterate on UI (notifications are
                  # skipped on web; everything else, including SQLite via jeep-sqlite/IndexedDB,
                  # works in the browser)
npm run build     # production web build (outputs to dist/)
npm run lint      # eslint . — run this after any change, it's fast and catches real issues
```

There is no test suite (no `npm test`). Verify changes by running the app in the browser
with Playwright (see "Testing changes" below) rather than assuming correctness.

### Android build

This dev environment has no Android SDK, so `android/` can't be compiled locally. The
`.github/workflows/android-build.yml` workflow builds a debug APK on every push (GitHub
Actions has full Android SDK/Gradle) and uploads it as an artifact — this is the only way
to get a real APK from this environment. After changing anything under `src/`, sync it
into the native project before pushing:

```bash
npm run build
npx cap sync android
```

CI runs `npm run build` + `npx cap sync android` + `gradlew assembleDebug` itself on every
push, so this local sync isn't required for the APK to build correctly — its main value
locally is catching sync errors early and keeping `android/capacitor.settings.gradle` /
`capacitor.build.gradle` up to date whenever a new Capacitor plugin is added (`npx cap
sync` regenerates those two files; the copied web assets themselves are gitignored).

### Testing changes without an emulator

Chromium is preinstalled at `/opt/pw-browsers/chromium`; Playwright itself lives at
`/opt/node22/lib/node_modules/playwright` (not a project dependency — reference it by
absolute path, or set `NODE_PATH=/opt/node22/lib`, when writing throwaway test scripts).
The standard pattern used throughout this project's history: launch a page, seed
`localStorage` or click through the UI, screenshot, and read the screenshot back to verify
visually — this is the primary way UI changes get validated since there's no test suite
and no real device available in this environment.

**This only exercises desktop Chromium, not the actual Android WebView** — real gaps only
show up on-device. `crypto.randomUUID()` is the concrete example: desktop Chrome has
supported it since 2021, so every browser-based test passed for the entire project history
even though the emulator's system WebView doesn't support it at all, throwing on every
routine/task creation (`src/utils/id.js`'s `generateId()` now falls back to
`crypto.getRandomValues()`, then `Math.random`, so this can't hard-crash regardless of
WebView vintage). If you're testing anything that touches a native plugin (notifications,
SQLite connection lifecycle) or a Web API whose support might lag on older WebView builds,
prefer the emulator harness below over a desktop-browser Playwright script.

### Real-device verification via GitHub Actions emulator

`.github/workflows/android-emulator-verify.yml` (manual `workflow_dispatch` — booting a
KVM-accelerated emulator adds several minutes over the plain APK build, so it doesn't run
on every push) installs a real debug APK on a booted Android emulator and drives it via
`scripts/verify-notification-catchup.mjs`. That script connects to the app's WebView over
raw Chrome DevTools Protocol using Node's built-in `WebSocket`/`fetch` — **not**
Playwright's `connectOverCDP`, which fails immediately ("Browser context management is not
supported") because Android WebView's CDP support only implements page-level domains
(`Runtime`/`Page`/`DOM`), not the `Browser`-level domain Playwright's connection handshake
requires. UI interaction goes through `Runtime.evaluate` executing injected JS (native
setter + `dispatchEvent` for React-controlled inputs, textContent-based click helpers —
see `JS_HELPERS` in the script), and assertions are checked against real
`adb shell dumpsys notification` output, not app-level JS state. Forwards
`Runtime.consoleAPICalled`/`Runtime.exceptionThrown` to CI stdout — this is what surfaced
the `crypto.randomUUID` crash, which otherwise would have failed silently inside a
try/catch with no visibility into why. Use this pattern (not `window.location.reload()`)
when a test needs to simulate "reopen the app": a JS-level reload doesn't tell
`@capacitor-community/sqlite`'s native connection to release itself, since that connection
lives outside the WebView's JS lifecycle — it throws "Connection routines already exists"
instead. Re-triggering the same code path a real action would (e.g. re-saving a routine to
re-run `syncAllNotifications`) is both more faithful to the bug and avoids the SQLite
lifecycle mismatch entirely.

## Architecture

### Data model: Routine -> Task -> Completion

A **Routine** is a named container (icon, notes, active flag, a default day-schedule new
tasks inherit). A **Task** is the actual schedulable/completable unit, with its own time,
days, active flag, and completion type:
- `boolean` — plain done/not-done.
- `quantity` — a numeric `target` (+ optional `unit` and `quickAdd` shortcut amounts);
  completion is `actual / target`, clamped to 1, producing a genuine partial-completion
  fraction rather than a boolean.

A task's `time` is its due-by moment — the one used for "was this due/complete on day X"
analytics (below) and the anchor for its main reminder. `windowStart` (default `'00:00'`,
i.e. no visible change for tasks that don't set one) marks when a task becomes "current";
it only affects the Today-screen countdown display and reminder scheduling, not
analytics/streaks — a task is still due for the whole calendar day regardless of window.
`reminderTimes` is an array of *extra* hardcoded nudge times in addition to `time` itself
(capped at `MAX_EXTRA_REMINDERS` in `src/utils/tasks.js`); see the Notifications section
for why these can't just share one notification id.

Every routine has at least one task. A routine with exactly one task renders as a flat
item everywhere in the UI (Today, History, Dashboard) so the common case looks identical
to a simple single-item routine; a routine with multiple tasks renders as an expandable
group. This "flat when simple" branching (`routine.tasks.length === 1`) is threaded
through `TodayView`, `RoutinesView`, `DashboardView`, and `HistoryView` — check all four
when changing how single-vs-multi-task routines are told apart.

Completions are keyed by `task_id` + `date` (not routine), storing a `value` (1/null for
boolean, a number for quantity). "Was this due/complete on date X" is never read off the
live task row — see versioning below.

### Versioning: every edit is append-only, not an overwrite

Editing a routine or task does not mutate its row in place. It closes the current version
(`effective_to = now`) and inserts a new one (`effective_from = now`). This is the
mechanism behind three separate features at once:
- **Historically accurate analytics** — a target/schedule change only affects days from
  the change forward; past dashboard numbers don't shift retroactively.
- **The audit log** (`ActivityLogView`, and "View history" inside the routine editor) —
  the version tables *are* the log; there's no separate event-logging system.
- **Soft delete** — deleting a routine/task inserts a terminal version
  (`change_type: 'deleted'`) and flips a `deleted` flag rather than removing the row, so
  the audit log still has something to show for it.

Version cutover is day-granular: which version applies to a given calendar day is
"the latest version whose `effective_from` date is `<=` that day" — see
`findEffectiveVersion` in `src/utils/date.js`. Editing a task today changes today's own
math immediately (today isn't "closed" yet) but never touches already-passed days.

Routine-level `active` (pause/resume) is deliberately **not** versioned — it's a simple
current-state gate checked directly in `getRoutineFraction`, unlike task-level `active`
which is versioned like everything else. This was a scope cut made explicit during
design: task-pause needed historical accuracy, routine-pause (pre-dating the task/version
work) stayed simple. If routine-level pause ever needs to become historically accurate
too, this is the spot.

### Fraction-based completion math (`src/utils/date.js`, `src/utils/analytics.js`)

Everything downstream of raw completions works in fractions (0–1), not booleans:
- `getTaskFraction(versions, completions, date)` → `null` if not due that day, else 0–1.
- `getRoutineFraction(routine, taskVersionsMap, completions, date)` → average of its due
  tasks' fractions that day; `null` if the routine had nothing due (so callers skip the
  day rather than counting it as 0%).
- `calcRoutineStreak` → consecutive days at fraction `1` (100%); today gets a grace
  exception (an incomplete-so-far today doesn't break the streak, since the day isn't
  over).
- `analytics.js`'s `getDashboardStats(routines, taskVersionsMap, completions, range)` is
  the single entry point the Dashboard uses; it computes per-routine and nested per-task
  stats, an auto-scaled trend (daily buckets for Week, weekly for Month, monthly for All
  Time), and a day-of-week breakdown, all built on the same fraction functions above.

`taskVersionsMap` (task id -> its versions, sorted ascending, excluding deleted routines)
is loaded once per app-level refresh (`storage.getTaskVersionsForAnalytics()`) and passed
down as a prop rather than queried per-view — every history/dashboard component expects
it.

### Storage layer (`src/storage.js`, `src/db.js`)

SQLite via `@capacitor-community/sqlite`, with `jeep-sqlite` + a **version-pinned**
`sql.js` (1.11.0, not latest) providing the web/browser backend for local dev — jeep-sqlite
ships prebuilt WASM glue tied to a specific sql.js release; using a newer sql.js there
causes a `LinkError` at runtime. If bumping `sql.js`, re-copy
`node_modules/sql.js/dist/sql-wasm.wasm` to `public/assets/sql-wasm.wasm` and re-test in
the browser before assuming it works.

Schema migrations live in `db.js`'s `MIGRATIONS` array (Capacitor's versioned
`addUpgradeStatement` mechanism — each entry's `statements` run once when `DB_VERSION`
increases). `storage.js` also carries a one-time migration path
(`migrateFromPreferencesOnce`) for installs from before SQLite existed (the app's very
first version used `@capacitor/preferences`) — this path independently constructs the full
routine+task+version rows from the old flat JSON shape, so it must be kept in sync by hand
whenever the schema changes (it does not run through the SQL migrations, since it's
migrating from a different storage system entirely, not a schema version bump).

`storage.js` functions always return a fresh read after any write (`return getRoutines()`
/ `return getCompletions()`) rather than trusting in-memory state — callers in `App.jsx`
rely on this.

### Notifications (`src/notifications.js`)

Two categories, both gated behind `Capacitor.isNativePlatform()` (everything no-ops on
web):

- **Per-task reminders** — one recurring `LocalNotifications` schedule per task per
  scheduled weekday, with an `actionTypeId` giving it action buttons (Mark done /
  `+N` quick-add / Snooze) and an `extra: {taskId, routineId}` payload so the shared
  `localNotificationActionPerformed` listener (wired in `App.jsx`) knows which task a tap
  applies to. Action *types* are shared/pre-registered (`registerNotificationActionTypes`)
  — one per distinct quick-add combination in use plus one for boolean tasks — because
  Android attaches action buttons to a registered type, not to each notification
  individually. Multi-task routines' notifications share a `group` string so simultaneous
  pending reminders collapse together in the shade. `updateRoutineGroupSummary(routine)`
  additionally posts a real `groupSummary: true` notification (id from `groupSummaryIdFor`,
  a hash of the routine id offset by `GROUP_SUMMARY_ID_BASE`) whenever a routine has more
  than one active/scheduled task — confirmed via `dumpsys notification` on a real device
  that `group`/`groupSummary` map straight to `NotificationCompat.Builder.setGroup()` /
  `.setGroupSummary()`, not cosmetic. It's cancelled (`cancelRoutineGroupSummary`) the
  moment a routine drops back to ≤1 active task, and is deliberately NOT `ongoing` — only
  the per-task due reminders it groups are pinned; the summary itself is swipeable. Kept
  in sync from every place a routine's active-task count can change:
  `scheduleTaskNotifications` (per-task schedule/cancel), `handleToggleRoutineActive`, and
  `handleToggleTaskActive`'s deactivation branch, plus cancelled outright in
  `handleDeleteRoutine`.
  - The `task.time` (due-by) reminder is scheduled with `ongoing: true, autoCancel: false`
    so it stays pinned in the shade until the task is completed; `dismissTaskReminders`
    (called via `refreshTaskReminderVisibility` from every completion-changing path in
    `App.jsx`, including notification-action taps) clears it once done, using
    `removeDeliveredNotifications` rather than `cancel()` — the former just dismisses
    what's currently shown, the latter would rip out the underlying recurring alarm and
    stop future weeks from firing at all (confirmed from `TimedNotificationPublisher`'s
    self-rescheduling in the native plugin source). `ongoing: true` maps to Android's real
    `FLAG_ONGOING_EVENT`, which genuinely blocks swipe-dismiss and "Clear all" while the
    task is pending — this is not cosmetic. It does not, and cannot, survive the user
    disabling notifications for the app/channel at the OS settings level; that's outside
    what any app-level flag can override.
  - `task.reminderTimes` (extra nudges in addition to `time`) get their *own* ids
    (`extraReminderIdFor`, one fixed slot per array index, not the reminder's clock value)
    rather than sharing the due notification's id. This is a hard Android constraint, not
    a style choice: `LocalNotificationManager` schedules every alarm via
    `PendingIntent.getBroadcast(context, id, ...)` with `FLAG_CANCEL_CURRENT`, so two
    alarms scheduled under the same id don't coexist — the later `schedule()` call cancels
    the earlier one before it ever fires. Slot ids are keyed by array index rather than
    the time value so `cancelTaskNotifications` can always sweep every slot that could
    ever have been used, even after the user removes a reminder and the old time is gone
    from the task object.
- **Computed notifications** (`syncDynamicNotifications`) — the persistent daily summary
  (`ongoing: true` only while something's still due — see below), the streak-at-risk
  nudge, and the morning/evening digests. These have no backend and no background-task
  runner, so their content can only be recomputed when the app is actually open; they're
  refreshed on every app load and after every completion change (including from a
  notification action tap), and rely on `on: {hour, minute}` (no `weekday`) native daily
  recurrence to keep firing even if the app isn't reopened — just with whatever content was
  last computed. A multi-day gap without opening the app means stale content, not a missed
  notification. `updateSummaryNotification`'s title is a real overall percentage
  (`Math.round` of the average fraction across today's due routines, reusing the existing
  `getRoutineFraction` pipeline — no separate math), and its body lists each not-yet-100%
  routine as `Title NN%` (`formatRoutineProgress`) rather than a plain done/not-done count;
  it drops `ongoing` once every due routine hits 100%, since there's nothing left to pin.

`scheduleTaskNotifications(task, routine, completions)` is the single choke point that
decides whether a task's reminders actually get scheduled — it checks `task.active`,
`task.days.length`, and (routine-level pause is deliberately not versioned, see above)
`routine.active`, all three. This matters because `syncAllNotifications` re-syncs *every*
routine's tasks whenever *any* routine is saved (`handleSaveRoutine` in `App.jsx` calls it
with the full current routine list, not just the one edited) — without the `routine.active`
check here, saving an unrelated routine would silently reschedule reminders for a routine
the user had paused. Action-type registration (`registerNotificationActionTypes`) is
unaffected by this gate and registers types for all tasks regardless of active state —
harmless, since an unused registered type just sits there (confirmed from the native plugin
source: each action type is written to its own `SharedPreferences` file keyed by id, so
registrations are additive/idempotent and never clobber each other or get silently dropped).

**`catchUpDueReminderIfNeeded` — why the pinned due-by reminder needs a `completions` param
at all.** `scheduleTaskNotifications` unconditionally calls `cancelTaskNotifications` before
rescheduling (needed so a changed `time`/`days` doesn't leave a stale alarm behind), and
since `syncAllNotifications` runs on every app open and every routine save, that cancel
fires constantly — including for tasks whose due time already passed today. Confirmed from
the native plugin source (`LocalNotificationManager.cancel` calls `dismissVisibleNotification`
*and* `cancelTimerForNotification`, and `DateMatch.postponeTriggerIfNeeded` jumps a full
`WEEK_OF_MONTH` forward once today's `hour:minute` has passed rather than firing later
today): the net effect was that simply reopening the app, or saving any unrelated routine,
silently wiped an already-showing pinned reminder and didn't bring it back until the same
weekday *next week*. `catchUpDueReminderIfNeeded` re-fires the pinned reminder immediately
(no `schedule` field, i.e. fires now, same pattern as `updateSummaryNotification`) whenever
a sync leaves a currently-due, not-yet-done task without one — this is why
`scheduleTaskNotifications`/`syncAllNotifications` need `completions` threaded through from
every call site in `App.jsx`.

**No live-updating countdown/chronometer in the notification itself** — this is a real
Android `Notification.Builder` capability (`setUsesChronometer`) that
`@capacitor/local-notifications` doesn't expose (open upstream feature request, unresolved
as of this writing). The community `capacitor-timer-notification` plugin exists but pins
`@capacitor/core: ^6.0.0` against our v8 — not worth the compatibility risk. Getting a real
one requires a custom native Android plugin; the in-app countdown on the Today screen
(`TodayView.jsx`'s `CountdownLabel`, ticking via a 60s `setInterval`) is the fallback.

### Android signing (`android/debug.keystore`)

The debug keystore is committed to the repo and wired into
`android/app/build.gradle`'s `signingConfigs.debug`. This is intentional and safe (debug
keystores have a universally-known password and no security value) — without it, every CI
run generates its own random ephemeral debug key, so each built APK would have a different
signature and Android would refuse to install an update over the previous one, forcing an
uninstall (and full data loss) on every release. Never regenerate this file casually.

### Design system

Single committed light theme ("Soft Paper" — warm off-white, sage green accent, serif
headers) defined as CSS custom properties in `src/index.css`, consumed throughout
`src/App.css`. No dark mode / no `prefers-color-scheme` branching — this was a deliberate
choice over the previous system-following theme. Icons come from `lucide-react`, looked up
per-routine via `src/utils/icons.js`'s keyword-based `suggestIconId` (falls back to a
generic icon) with a manual override stored on the routine.

One CSS gotcha already hit twice: the fixed bottom tab bar (`.app-tabbar`) must have an
opaque `background` (currently the `Canvas` system color) — `background: inherit`
resolves to transparent here since `.app-shell` sets no background, which only becomes
visible once a scrollable view is taller than one screen.

### A recurring ESLint false-positive

`no-unused-vars` sometimes misfires on a destructured capitalized variable used only as a
JSX tag (e.g. `const { Icon } = someObject; ... <Icon />`) inside certain callback shapes.
The fix used throughout this codebase is to access it as a member expression instead
(`<option.Icon />` or `<props.Icon />`) rather than destructuring the bare identifier —
see `RoutineForm.jsx` and `HistoryView.jsx` for the pattern.
