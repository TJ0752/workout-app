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

## Architecture

### Data model: Routine -> Task -> Completion

A **Routine** is a named container (icon, notes, active flag, a default day-schedule new
tasks inherit). A **Task** is the actual schedulable/completable unit, with its own time,
days, active flag, and completion type:
- `boolean` — plain done/not-done.
- `quantity` — a numeric `target` (+ optional `unit` and `quickAdd` shortcut amounts);
  completion is `actual / target`, clamped to 1, producing a genuine partial-completion
  fraction rather than a boolean.

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
  pending reminders collapse together in the shade (no separate group-summary
  notification is created — untested without a device, kept simple deliberately).
- **Computed notifications** (`syncDynamicNotifications`) — the persistent daily summary
  (`ongoing: true`, no live countdown — see below), the streak-at-risk nudge, and the
  morning/evening digests. These have no backend and no background-task runner, so their
  content can only be recomputed when the app is actually open; they're refreshed on every
  app load and after every completion change (including from a notification action tap),
  and rely on `on: {hour, minute}` (no `weekday`) native daily recurrence to keep firing
  even if the app isn't reopened — just with whatever content was last computed. A
  multi-day gap without opening the app means stale content, not a missed notification.

`scheduleTaskNotifications(task, routine)` is the single choke point that decides whether
a task's reminders actually get scheduled — it checks `task.active`, `task.days.length`,
and (routine-level pause is deliberately not versioned, see above) `routine.active`, all
three. This matters because `syncAllNotifications` re-syncs *every* routine's tasks
whenever *any* routine is saved (`handleSaveRoutine` in `App.jsx` calls it with the full
current routine list, not just the one edited) — without the `routine.active` check here,
saving an unrelated routine would silently reschedule reminders for a routine the user had
paused. Action-type registration (`registerNotificationActionTypes`) is unaffected by this
gate and registers types for all tasks regardless of active state — harmless, since an
unused registered type just sits there (confirmed from the native plugin source: each
action type is written to its own `SharedPreferences` file keyed by id, so registrations
are additive/idempotent and never clobber each other or get silently dropped).

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
