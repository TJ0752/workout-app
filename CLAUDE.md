# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Daily Routines" — an Android habit/routine tracker with local reminders and completion
analytics. React + Vite web app packaged as a native Android app via Capacitor. All data
is stored on-device in SQLite; there is no backend.

## Ground rules for any Claude Code session working here

These apply regardless of which session or which chat is doing the work — read them before
making changes, not just once at project init.

- **Ask before guessing on anything ambiguous, product-decision-shaped, or destructive.** If a
  request could reasonably be done more than one way, or depends on something only the user
  knows (a real-world constraint, a preference, which of two reasonable defaults they want),
  ask rather than silently picking one and running with it. This has been the actual working
  pattern throughout this project's history — e.g. confirming the canonical weight unit was kg
  before building last-used-weight prefill, confirming before merging any branch into `main`.
  Don't treat that as a one-off; treat it as the default.
- **Keep the AI-import JSON schema in lockstep with the app's real config options.** Every time a
  task/routine/exercise field is added, renamed, removed, or changes meaning, update *both*
  `AI_IMPORT_PROMPT` and the matching `convert*` function in `src/aiImport.js` in the same
  change — see "AI-generated routine import" below for why this lives as one module instead of
  two independently-maintained schemas that could drift apart. This is part of what "done" means
  for that change, not a follow-up to do later.
- **Dev-test before pushing to production.** Only `main` builds/publishes the real
  `latest-android` release that the in-app updater installs (see "Test app / product flavors"
  below) — any other branch only ever reaches the `.dev` test app. Verify a change first (at
  minimum a browser Playwright round-trip per "Testing changes without an emulator" below; the
  `android-emulator-verify.yml` real-device harness for anything native-only/notification/SQLite-
  lifecycle related) on a working branch, run `npm run lint`/`npm test`/`npm run build`, and only
  merge to `main` once the user has explicitly confirmed they're happy with it — never push
  straight to `main` unprompted.

## Commands

```bash
npm install
npm run dev      # Vite dev server — fastest way to iterate on UI (notifications are
                  # skipped on web; everything else, including SQLite via jeep-sqlite/IndexedDB,
                  # works in the browser)
npm run build     # production web build (outputs to dist/)
npm run lint      # eslint . — run this after any change, it's fast and catches real issues
npm test          # vitest run — unit tests for the pure logic layer (src/utils/*.test.js)
                  # and mocked-Capacitor notification behavior (src/__tests__/notifications.test.js)
```

The test suite covers the pure business-logic layer only (fraction math, versioning cutover,
streaks, workout stats, and notification scheduling decisions via `vi.mock`'d
`@capacitor/core`/`@capacitor/local-notifications`) — it's a regression safety net for logic
that used to be verified only by hand. It does not cover React components or real native
Android behavior (actual notification flags, WebView compatibility gaps like
`crypto.randomUUID`). For those, still run the app in the browser with Playwright (see
"Testing changes" below) or use the real-device emulator harness further down.

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
`scripts/verify-due-reminder.mjs` and `scripts/verify-group-summary.mjs`. Those scripts
connect to the app's WebView over
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

`scripts/verify-workout-session-notification.mjs` drives the native Compose workout session
Activity (see "Native Android workout session" below) the same way, but with an added
wrinkle: once `WorkoutSessionActivity` launches on top of `MainActivity`, it's *invisible to
CDP* (CDP only sees the WebView's DOM) — interacting with it requires `adb shell
uiautomator dump` (parsed for `<node text="..." bounds="[x1,y1][x2,y2]">`) + `adb shell
input tap/swipe` at computed coordinates. Three non-obvious, real-device-only lessons from
getting this working:
- `uiautomator dump` cannot succeed while the workout timer notification's chronometer text
  is visible on screen — its idle-wait can only complete once nothing is changing, and a
  chronometer updates once a second for as long as it's shown. Confirmed with 70+ retries
  over several minutes at a 0% success rate; this is a hard incompatibility, not a race
  worth retrying through. The swipe-resistance check locates its target by screen geometry
  (`adb shell wm size` + a sweep of plausible row Y-positions) instead of a UI dump, and
  clears every *other* notification first
  (`NativeNotifications.clearAllExceptChannel({ channelId: 'workout-session-timer' })` — see
  "Native notifications" below; this replaced an earlier call to the stock plugin's
  `LocalNotifications.removeAllDeliveredNotifications()`, which stopped clearing anything
  relevant once every notification in the app moved off that plugin) so a blind sweep can't
  accidentally tap a leftover notification from an earlier test routine and tear down the
  session as a side effect — this happened: a stray tap on a re-synced group-summary
  notification brought the app to the foreground and looked exactly like a swipe-resistance
  failure until the actual event log was inspected.
- Compose can merge a clickable's descendant semantics into a single accessibility node, so
  a button's visible glyph may only surface via `content-desc`, not `text` — match both,
  loosely (substring, not equality), and log every candidate node's position/class when a
  lookup might be ambiguous, rather than assuming the first match is correct.
- `boundsMatch.slice(1)` already strips the whole-match element from a regex match array;
  destructuring the result with a leading empty slot (`const [, x1, y1, x2, y2] = ...`)
  skips the real `x1` and silently shifts every field over by one, leaving `y2` undefined.
  This produced coordinates that looked plausible enough not to immediately fail, but never
  actually landed on the intended element — caught only once diagnostic logging of every
  candidate node's parsed bounds made the missing field visible.

The script also taps "Mark set done" (via the same `uiautomator` approach as the close
button) to log a real set mid-session — this is the regression check for the
`WorkoutTimerService`/daily-summary notification-id collision (see "Native Android workout
session" below): logging a set triggers `updateSummaryNotification`, and the workout timer
notification must survive that with `FLAG_FOREGROUND_SERVICE` intact rather than being
overwritten by the summary's plain `notify()` sharing the same raw id.

## Architecture

### Data model: Routine -> Task -> Completion

A **Routine** is a named container (icon, notes, active flag, a default day-schedule new
tasks inherit). A **Task** is the actual schedulable/completable unit, with its own time,
days, active flag, and completion type:
- `boolean` — plain done/not-done.
- `quantity` — a numeric `target` (+ optional `unit` and `quickAdd` shortcut amounts);
  completion is `actual / target`, clamped to 1, producing a genuine partial-completion
  fraction rather than a boolean. `quantityMode` (`'number'`, the default, or `'timer'`)
  switches how the target is set up/logged without changing this math at all — a timer-mode
  task's `target`/`actual` are still plain seconds flowing through the identical
  `actual / target` fraction; see "Quantity-as-timer" below.

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
- **Soft delete** — deleting a task (e.g. removing it from a routine mid-edit) inserts a
  terminal version (`change_type: 'deleted'`) and flips a `deleted` flag rather than removing
  the row, so the audit log still has something to show for it. A whole *routine* no longer has
  an equivalent one-step delete at all — see "Routine archive, restore, and permanent delete"
  below for what replaced it.

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

### Routine archive, restore, and permanent delete (`src/storage.js`, `RoutinesView.jsx`)

Archiving replaced the old "Delete" button on a routine entirely — per an explicit product
decision, a routine is never destructively removed from the active-routines UI in one step
anymore. `routines.archived_at` (nullable, added via `DB_VERSION = 7`'s migration, alongside
the same column on `routine_versions` for audit-log parity) is a **timestamp, not a boolean**,
specifically so it can be *date-aware* the way routine-level `active` (above) deliberately
isn't: `getRoutineFraction` treats a routine's archive moment as a one-time cutover — every day
strictly before `archivedAt` computes its fraction exactly as if the routine had never been
archived (so a routine's entire pre-archive History/Dashboard picture stays 100% intact),
while `archivedAt` itself and every day after are treated as "nothing due," the same outcome a
day that was simply never scheduled produces. This is why archiving can't reuse the `active`
flag's gate above: `active`'s current-value check applies uniformly to every date including
past ones, which would have retroactively erased an archived routine's history instead of
preserving it. `getDayBreakdown` (`utils/analytics.js`, the Dashboard heatmap/consistency-chart
drill-down) duplicates this same date comparison rather than routing through
`getRoutineFraction`, since it iterates task versions directly for its per-day breakdown — kept
in sync by hand, the same way its pre-existing `!routine.active` check already had to be.

- **Archiving** (`archiveRoutine` in `storage.js`) sets `archived_at` to now, closes the
  routine's current `routine_versions` row, and inserts a new one (`change_type: 'archived'`)
  — the audit log gets a real entry, matching every other lifecycle change. `App.jsx`'s
  `handleArchiveRoutine` also cancels every one of the routine's task notifications and its
  group summary first, exactly like the old delete handler did, since an archived routine must
  stop generating reminders immediately. `scheduleTaskNotifications`/`updateRoutineGroupSummary`
  in `notifications.js` also gate directly on `routine.archived` (in addition to the existing
  `routine.active`/`task.active` checks) as a second line of defense — `syncAllNotifications`
  re-syncs *every* routine's tasks on *any* save, so this gate is what keeps a resync from
  silently re-arming an archived routine's reminders.
- **Restoring** (`restoreRoutine`) clears `archived_at` back to `NULL` and inserts a
  `'restored'` version — the routine and its entire history return exactly as they were, since
  nothing about its versions/completions/workout-logs was ever touched. `handleRestoreRoutine`
  re-runs `scheduleTaskNotifications`/`updateRoutineGroupSummary` for its tasks, the same as
  resuming a paused routine would.
- **Permanently deleting** (`permanentlyDeleteRoutine`) is the one genuine hard delete
  anywhere in this codebase — it actually erases the routine's `routines`, `routine_versions`,
  `tasks`, `task_versions`, `completions`, and `workout_logs` rows, a deliberate, explicit
  exception to the append-only versioning philosophy described above. **Only ever allowed for
  an already-archived routine** — enforced in `storage.js` itself (it silently no-ops if
  `archived_at` is `NULL`), not just by the UI only exposing the button on the Archived list,
  since a stray call anywhere else must not be able to trigger real data loss. `App.jsx`'s
  `handlePermanentlyDeleteRoutine` shows an explicit warning confirmation
  (`confirm(...)`) before calling it, per the product requirement that this action must never
  fire without the user explicitly acknowledging it's irreversible. Deletes each task's
  `completions`/`workout_logs`/`task_versions` rows in a sequential `for` loop, not
  `Promise.all`, matching `resolveExerciseIds`' documented reason: the web SQLite backend's
  `db.query`/`db.run` aren't safe to call concurrently on the same connection.
- **UI** (`RoutinesView.jsx`) is a single component with two render branches, toggled by local
  `showArchived` state rather than a separate route/tab — a "Archived (N)" link sits next to
  "+ Add routine" on the normal list, and an archived routine's card shows only "Restore" and
  "Delete permanently" (no Edit/Pause/Archive, which don't make sense for something already
  archived). `TodayView.jsx`'s routine filter gained `&& !routine.archived` alongside its
  existing `routine.active` check — Today needs both: a routine can be currently active-flagged
  but archived, and must still disappear from the checklist.

### Fraction-based completion math (`src/utils/date.js`, `src/utils/analytics.js`)

Everything downstream of raw completions works in fractions (0–1), not booleans:
- `getTaskFraction(versions, completions, date)` → `null` if not due that day, else 0–1.
- `getRoutineFraction(routine, taskVersionsMap, completions, date)` → average of its due
  tasks' fractions that day; `null` if the routine had nothing due (so callers skip the
  day rather than counting it as 0%).
- `calcRoutineStreak` → consecutive days at fraction `1` (100%); today gets a grace
  exception (an incomplete-so-far today doesn't break the streak, since the day isn't
  over).
- `calcLongestRoutineStreak` → the longest run ever seen in the lookback window, not just
  the live one — the habit equivalent of a fitness PR. Unlike `calcRoutineStreak`, it never
  stops early and keeps the best run seen even after a later gap ends it; it also has no
  grace exception for today, since an incomplete today just fails to extend whatever run
  is currently being tracked rather than needing special-casing.
- `analytics.js`'s `getOverallConsistency(routines, taskVersionsMap, completions,
  thresholdFraction, windowDays)` → how many of the last `windowDays` due-days had an
  *overall* (average-across-routines) completion at or above `thresholdFraction` (default
  50%, 21 days). This is deliberately softer than a streak's all-or-nothing 100% bar — a
  routine set sitting at a steady 80% every day scores well here even though it never
  posts a single "complete" day for the streak counter. Also returns the day-by-day
  `series` itself — **one entry per calendar day in the window, not just due days**: a day
  nothing was due gets `{date, pct: null, met: false}` rather than being skipped, so the
  consistency bar chart and completion heatmap (both render from this `series` directly, so
  the two visuals never disagree) can show those days as a distinct "empty" state instead of
  silently omitting them (a gap in a bar chart reads as "forgot to check," not "nothing was
  scheduled" — those are different facts and needed different visuals).
- `analytics.js`'s `getDashboardStats(routines, taskVersionsMap, completions, range)` is the
  single entry point the Dashboard uses; it computes per-routine and nested per-task stats,
  an auto-scaled trend (daily buckets for Week, weekly for Month, monthly for All Time), a
  day-of-week breakdown, and `longestStreak`/`consistency`. All of these — including
  `longestStreak`/`consistency` — are scoped to the *same* `dates` window the selected range
  produces (`windowDays = dates.length`, threaded into `getOverallConsistency`/
  `getLongestOverallStreak`), so switching Week/Month/All Time actually recomputes every
  number on the screen instead of only `completionRate`/`trend` reacting while Consistency
  quietly kept using a fixed 21-day/365-day lookback regardless of the tab — a real,
  user-reported staleness bug from an earlier version of this screen. The one deliberate
  exception is `bestStreak` (current streak): a live streak is inherently "today backward
  until broken," not a windowed stat, so capping it at the selected range would just
  truncate the number without adding information (e.g. showing "7" for Week when the actual
  streak is 12 doesn't mean anything Week-specific).
- `analytics.js`'s `getDayBreakdown(routines, taskVersionsMap, completions, date)` computes
  the per-task completion state for exactly one calendar day, grouped by routine (nested
  tasks for a multi-task routine, flat for a single-task one, matching the "flat when
  simple" convention) — this is what backs the Consistency chart's tap-a-day drill-down.
  Routines/tasks not due that day are omitted rather than shown as some "N/A" row. Both the
  threshold bar chart's columns and the heatmap's cells are clickable and open the same
  drill-down panel (a bottom sheet), including empty days, which show "Nothing was due this
  day" rather than being unclickable.

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

**A real bug found on a real device, not CI or the browser: a migration can report success
(`PRAGMA user_version` correctly advances) while its own `ALTER TABLE` statements silently never
applied.** `DB_VERSION = 8` added `quantity_mode`/`auto_update_target` columns to
`tasks`/`task_versions` (see "Quantity-as-timer" below) using the exact same
`ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT ...` pattern every prior migration had already
used successfully in production. On at least one real device it didn't take: `user_version` was
genuinely at 8, but the columns were missing, surfacing as `table tasks has no column named
quantity_mode` on every single routine save from then on — `addUpgradeStatement`'s own upgrade
runner only ever acts when the stored version is *behind* `DB_VERSION`, so once this happens it
never retries and the device is stuck permanently, with no obvious recovery short of an
uninstall (which loses all data). `openDatabase()` now runs `ensureQuantityModeColumns()` after
every `db.open()` — a cheap `PRAGMA table_info(tasks)` check for the column, adding it directly
via the same `ALTER TABLE` statements if it's missing. A no-op on any device where the migration
ran correctly; a silent, non-destructive repair on one where it didn't. Verified by deliberately
rebuilding a live database's `tasks` table without the column (simulating exactly this broken
state) and confirming the very next `openDatabase()` call repairs it before any save is attempted.
This pattern (verify the actual schema state directly rather than trusting the version-number
bookkeeping alone) is the template to reach for again if a future migration is ever suspected of
the same partial-apply failure — `@capacitor-community/sqlite`'s upgrade mechanism does not
appear to guarantee the two stay in lockstep.

**Save failures were completely silent before this was found.** The bug above was only
diagnosable at all because `RoutinesView.jsx`'s `handleSave` previously had no error handling —
`closeForm()` was chained directly after `await onSaveRoutine(payload)`, so any rejected promise
(this migration bug, or any future storage-layer exception) just left the form sitting open with
zero feedback, indistinguishable from the form simply not responding to the Save tap. Wrapped in
try/catch now: the real `err.message` renders above the form (`.form-error`, the same class the
pre-existing per-task validation messages below already used) and the form stays open with the
user's input intact, turning "Save does nothing" into an actual diagnosable error message. The
three pre-existing validation messages (unnamed task / no days selected / workout needs a named
exercise, `RoutineForm.jsx`) were separately improved to name *which* task is the problem
(`Task N needs a name.`) instead of one generic sentence with no indication of which of several
tasks needs attention — found while chasing a report of this same failure down a different,
initially-plausible-looking path (a multi-task routine's second task missing its own "Task name"
field, easy to miss since it's a small field above whatever new fields drew the user's attention)
before the real migration bug was isolated.

### Exercise repository (`src/storage.js`, `RoutineForm.jsx`)

A workout task's `exercises[]` entries carry a stable `exerciseId` (added via `DB_VERSION = 6`'s
migration, a new `exercises` table: `id`, `name`, `created_at`, with a case-insensitive unique
index on `name`) in addition to their existing per-task-instance `id` — the two answer different
questions. `exercises[].id` is regenerated every time a task is edited/versioned (it's scoped to
one task's own array); `exerciseId` is the cross-routine identity that lets
`getFitnessOverview` in `src/utils/workouts.js` merge "Bench Press" logged under two different
routines' tasks into one PR/volume history, instead of silo-ing by whichever task happened to log
it. `getFitnessOverview` keys its merge by `exercise.exerciseId || name` (name-only fallback for
any exercise that predates this migration and hasn't been backfilled yet) — matching by id, not
name, also means a later rename doesn't split an exercise's history in two: renaming "Bench Press"
to "Barbell Bench" keeps the same `exerciseId`, so its PR/volume history stays merged and the
display just shows whichever spelling was most recently seen.

- **Resolution happens in `upsertTask`, not in the UI.** `resolveExerciseIds(db, exercises)`
  (called from `upsertTask` for every `completionType === 'workout'` task, before the task's
  other fields are computed) resolves each exercise missing an `exerciseId`: a case-insensitive
  name lookup against the `exercises` table, or a new row insert if this is a genuinely new name
  (`resolveExerciseId`). This means naming a *new* exercise "Push-ups" and later naming another
  new exercise "push-ups" (different case) still resolves to the same repository row — the same
  case-insensitivity `RoutineForm.jsx`'s autosuggest surfaces to the user, kept consistent at the
  data layer rather than relying on the UI alone to prevent duplicates. **Resolves sequentially, not
  via `Promise.all`** — a real bug caught by testing a genuinely two-exercise routine (every
  earlier manual/Playwright test happened to use one exercise per routine, so this went
  unnoticed): the web SQLite backend's `db.query`/`db.run` aren't safe to call concurrently on
  the same connection, and `Promise.all` over an async map issues exactly that whenever two
  brand-new exercise names both need an insert at once, throwing "cannot start a transaction
  within a transaction" and silently failing the whole routine save. A plain `for` loop keeps
  each exercise's query+insert pair fully finished before the next one starts.
- **One-time backfill for pre-existing data.** `backfillExerciseRepositoryOnce` (called from
  `ready()`, gated by a `Preferences` marker key so it only ever runs once per install) resolves
  `exerciseId` for every already-existing workout task's exercises that don't have one yet,
  rewriting only the live `tasks` table — per this codebase's append-only versioning philosophy,
  `task_versions` rows are an immutable audit log and are deliberately left untouched; only
  current-state tables are safe to backfill in place.
- **Autosuggest UI, plus a full-repository browse picker.** `RoutineForm.jsx`'s
  `ExerciseNameInput` fetches `getExerciseNames()` once per form mount and filters it
  client-side (substring, case-insensitive) as the user types in an exercise's name field.
  Selecting a suggestion sets both `name` and `exerciseId` on that exercise; typing free text
  instead clears any previously-set `exerciseId` (so an edited name doesn't keep pointing at the
  wrong repository row) and leaves resolution to `upsertTask` on save, exactly like a brand-new
  exercise. A second entry point next to the input (`ExercisePickerModal`, a bottom-sheet reusing
  the same `day-drilldown-*` overlay/panel CSS as the Dashboard's heatmap drill-down) lets a user
  browse the *entire* repository rather than relying on typing to narrow it down — useful for
  reusing an exercise name that isn't top-of-mind at all. It has its own text search box that
  filters the same list client-side, and selecting a row calls the identical
  `onSelectExisting(match)` path the inline autosuggest uses. **Its list rows select on
  `onMouseDown` with `preventDefault()`, not `onClick`** — a real bug hit during manual browser
  testing: with a plain `onClick`, clicking a row first moves focus onto that button (default
  browser behavior), and when the whole modal then unmounts a beat later (its `autoFocus`'d
  search input was still focused up to that point), the browser's fallback-focus behavior on
  removing a focused subtree landed focus back on the *exercise name input behind it* — silently
  re-triggering that input's own `onFocus` handler and reopening its inline autosuggest dropdown
  right after the picker closed. `onMouseDown`+`preventDefault()` (the same trick the inline
  autosuggest list already used, for an unrelated blur-race reason) keeps focus on the modal's
  own search input throughout the click, so when the modal unmounts focus falls through to
  `document.body` instead of anywhere nearby — confirmed via a Playwright script asserting
  `document.activeElement` after a picker selection.

### Exercise type: calisthenics vs. weights (`RoutineForm.jsx`, `WorkoutSessionView.jsx`, native `workout/`)

Each exercise config (`task.exercises[]`) carries an explicit `type: 'calisthenics' | 'weights'`
field, set via a toggle in `RoutineForm.jsx`'s exercise editor (the same `.type-toggle` styling
already used for the Reps/Duration toggle right below it). It does **not** reclassify anything
after the fact — the analytics layer's own weighted-vs-bodyweight decision (`utils/workouts.js`'s
`isWeighted`, described above) stays exactly as it was, based on whether a completed *set* ever
had a weight, not this config field.

**The weight field itself is always offered, for both types — `type` only controls its label.**
This wasn't the original design: `type` originally controlled whether the field was offered *at
all*, forcing `weight: null` on every set logged for a `'calisthenics'` exercise. That was
replaced by a direct user request — *"for calisthenics exercises, add a way to log extra weight
on top of bodyweight (a weighted vest/belt), tracked separately from a plain weighted exercise's
weight"* — and the cleanest fit turned out to be **not** a separate field at all: the same
`weight` value already means "total load" for a `'weights'` exercise and "load added on top of
bodyweight" for a `'calisthenics'` one, so both log into the identical field and feed the
identical prefill/regression-warning/PR/e1RM/volume pipeline unchanged (`getLastUsedWeight`
above, `getExercisePR`/`getExerciseVolume`, the Fitness Stats classification below). The only
change is the label shown at live-logging time — `"Weight (optional)"` vs. `"Added weight
(optional)"` (`isWeighted ? '...' : '...'` in both `WorkoutSessionView.jsx`'s `field-label` span
and `WorkoutSessionScreen.kt`'s equivalent `Text`) — plus, naturally, no more forced-null: a
calisthenics exercise's added weight is a real, intentionally-entered number now, not a stray
value to be defended against.

**The exercise config itself has no `targetWeight` field at all** — it existed only as the final
fallback in the weight-prefill chain (`loggedSet?.weight ?? lastUsedWeight ?? targetWeight`)
before `getLastUsedWeight` (see below) existed, and was removed once that fallback became
redundant for every exercise with any logged history. The one real behavior change from removing
it: a brand-new exercise's very first-ever set now starts with an empty weight field instead of a
pre-set suggestion — a deliberate tradeoff the user chose over keeping a setup-time field whose
only other use was that single first session.

**No backfill/migration needed for exercises saved before this field existed.** `isCalisthenics`
(JS) / the `isWeighted` local (Kotlin) both treat anything other than an explicit `'calisthenics'`
— including a totally absent `type` — as weighted, which is exactly the old behavior (a
`"Weight (optional)"`-labeled field, unconditionally shown). `type` defaults to `'weights'` for brand-new exercises
(`makeExercise()` in `RoutineForm.jsx`, and the `:shared` `Exercise` data class's default
parameter) for the same reason: least-surprise continuity with what every existing user is
already used to seeing, rather than defaulting to the newly-added option. The native JSON parse
(`WorkoutSessionActivity.kt`'s `parseExercises`) mirrors this with `obj.optString("type",
"weights")`. `:shared`'s `Exercise` data class has `type` as its last constructor parameter
specifically so `WorkoutLogicTest`'s existing positional `Exercise(...)` calls keep compiling
unchanged — Kotlin only lets a trailing parameter with a default be omitted positionally.

### Notifications (`src/notifications.js`)

**Every notification in the app is posted by native Kotlin** — `@capacitor/local-notifications`
schedules nothing anymore (see "Native notifications" below for the full native-side design).
Everything here is gated behind `Capacitor.isNativePlatform()` (no-ops on web). This wasn't the
original design — the app started with everything on the stock plugin and migrated one
notification kind at a time as each turned out to need something the plugin couldn't do (see
"Native notifications" for why); the migration is now complete, so `notifications.js` itself is
almost entirely thin JS-side orchestration (compute content, decide what should be
scheduled/cancelled, call the native plugin) rather than scheduling anything on its own.

- **Per-task reminders — merged into one notification per task.** The `task.time` due-by moment
  (`nativeScheduleDueReminder`) and each of `task.reminderTimes`' extra nudge times
  (`nativeScheduleExtraReminder`, one call per slot, capped at `MAX_EXTRA_REMINDERS`) are still
  scheduled as separate native alarms (each covering every scheduled weekday with a single
  self-rescheduling `AlarmManager` entry), but an extra reminder firing no longer posts a second,
  visually distinct notification — it re-alerts (sound/vibration) the *same* due-reminder
  notification that's already showing (or starts showing it, `awaitingCompletion = true`, if the
  due moment itself hasn't happened yet). This was a deliberate UX fix: a task with 2-3 extra
  nudges used to produce that many separate notifications stacking up for one task, which read as
  "doubling," not "another reminder." See Part C below for the mechanics. Extra-reminder slots are
  still keyed by array index, not the reminder's clock value, so `nativeCancelExtraReminderSlot`
  can always sweep exactly the slots that could ever have been used, even after the user removes a
  reminder and the old time is gone from the task object. `dismissTaskReminders` (called via
  `refreshTaskReminderVisibility` from every completion-changing path in `App.jsx`, including
  notification-action taps) clears whichever of these are currently showing for the task once
  it's marked done, via `nativeDismissDueReminderToday`/`nativeDismissExtraRemindersToday`, without
  touching the underlying recurring schedule for future days. A quantity task's reminder body is
  its **live progress** (`"3 / 10 reps"`, computed in `taskNotificationContent` from
  `completions`) rather than a static blurb — `handleAddQuantity`/`handleSetQuantity` in `App.jsx`
  call `scheduleTaskNotifications` again after every quick-add specifically so an already-showing
  reminder's body refreshes immediately, not just whenever it happens to next re-fire naturally.
  Every notification the app posts — reminders, group summary, summary, digests, background-sync —
  shares one flat app-wide `APP_GROUP_KEY` (see "Native notifications" Part D/`AppGroupSummary.kt`)
  so they always collapse together in the shade, replacing the old per-routine `group` string
  scheme that only grouped *sometimes*.
  `updateRoutineGroupSummary(routine, completions)` additionally posts a real, expandable native
  group-summary notification (`nativeUpdateGroupSummary` — confirmed via `dumpsys notification` on
  a real device that Android's `group` collapsing is a genuine OS behavior, not cosmetic) whenever
  a routine has more than one active/scheduled task, listing every currently-pending task by title
  (not just a count), cancelled (`cancelRoutineGroupSummary`) the moment it drops back to ≤1.
  Deliberately **not** reappear-on-dismiss like the reminders it groups, just plain and swipeable.
  Kept in sync from every place a routine's pending-task list can change — not just schedule/cancel
  events (`scheduleTaskNotifications`, `handleToggleRoutineActive`, `handleToggleTaskActive`'s
  deactivation branch) but also every completion-changing handler (`handleToggleComplete`,
  `handleAddQuantity`, `handleSetQuantity`, `handleLogWorkoutSet`, and the notification-action-driven
  Mark-done/`+N` handlers) — a routine with 3 tasks where the last one just got marked done needs
  its pending list to drop immediately, not wait for the next full resync. Cancelled outright in
  `handleDeleteRoutine`.
- **Tap-to-open deep linking.** Every notification's body now carries a `setContentIntent()` (see
  "Native notifications" below) that opens the app directly to the relevant task/routine on the
  Today screen, instead of doing nothing (the pre-overhaul behavior — none of these builders set a
  content intent at all). `initNotificationTapListener` in `nativeNotifications.js`, wired in
  `App.jsx`'s top-level `useEffect`, switches to the Today tab and passes `focusTaskId`/
  `focusRoutineId` down to `TodayView`, which expands the task's group if needed, scrolls to it,
  and applies a brief `.today-item-focused` highlight (see `TodayView.jsx`'s two focus effects).
- **Computed notifications** (`syncDynamicNotifications`) — the persistent daily summary, the
  streak-at-risk nudge, and the morning/evening digests, all posted natively
  (`nativeScheduleDailyDigest`/`nativeCancelDailyDigest` for the latter two;
  `showSummaryNotification`/`cancelSummaryNotification` for the summary). None of these have a
  real backend, so their content can only be *recomputed* when JS is actually running — they're
  refreshed on every app load, after every completion change (including from a notification
  action tap), and now also roughly every 15 minutes while the app process is alive thanks to
  the native background-sync foreground service (see below) — a real improvement over the
  original design, where a multi-day gap without opening the app meant stale content on a still
  correctly-firing digest. `updateSummaryNotification`'s title is a real overall percentage
  (`Math.round` of the average fraction across today's due routines, reusing the existing
  `getRoutineFraction` pipeline — no separate math), and its body lists each not-yet-100%
  routine as `Title NN%` (`formatRoutineProgress`) rather than a plain done/not-done count. Since
  this runs on *every* app open regardless of whether anything changed, `showSummary` (and the
  group summary above) now skip the repost entirely when content is identical to what's already
  showing — see "Native notifications" below for why this matters: `NotificationCompat` re-alerts
  on every `notify()` call by default, so without this check simply reopening the app with nothing
  new would re-sound these notifications every time.

`scheduleTaskNotifications(task, routine, completions)` is the single choke point that decides
whether a task's reminders actually get scheduled — it checks `task.active`,
`task.days.length`, and (routine-level pause is deliberately not versioned, see above)
`routine.active`, all three. This matters because `syncAllNotifications` re-syncs *every*
routine's tasks whenever *any* routine is saved (`handleSaveRoutine` in `App.jsx` calls it
with the full current routine list, not just the one edited) — without the `routine.active`
check here, saving an unrelated routine would silently reschedule reminders for a routine
the user had paused. `completions` is threaded through this call chain from every site in
`App.jsx` purely so it can compute `isDoneToday` for the native due-reminder catch-up decision
— see "Native notifications" below.

**`@capacitor/local-notifications` stays installed, but schedules nothing.** Its only remaining
call site is `initNotifications()`'s `checkPermissions()`/`requestPermissions()` — confirmed by
reading its Android source (`LocalNotificationsPlugin.java`'s `@Permission` annotation) that
this genuinely requests the runtime `POST_NOTIFICATIONS` permission, and it's the only code path
in this app that does so. Fully uninstalling it would require an equivalent native permission
flow on `NativeNotificationsPlugin` (Capacitor's own `@Permission`/`requestPermissionForAlias`
machinery) — possible, but judged not worth the risk of a plumbing mistake silently breaking
notification permissions (for every native notification, not just new ones) on a fresh Android
13+ install, when this one small dependency costs nothing to keep around for exactly this one
capability. A real future step, not an oversight.

**No live-updating countdown/chronometer in any of these** — that's a real Android
`Notification.Builder` capability (`setUsesChronometer`) neither the stock plugin nor a plain
`NotificationCompat.Builder` call gets you for free reason to reach for; it only shows up
anywhere in this app on the workout session's foreground-service notification further below,
which is the one notification that's backed by a real running `Service` rather than a one-shot
`AlarmManager`-fired post. The in-app countdown on the Today screen (`TodayView.jsx`'s
`CountdownLabel`, ticking via a 60s `setInterval`) remains the fallback everywhere else.

### Native notifications (`android/app/.../notify/`)

Every notification in the app is posted by one native plugin, `NativeNotificationsPlugin`
(`@CapacitorPlugin(name = "NativeNotifications")`,
`android/app/src/main/java/com/tharuka/routines/notify/`, JS wrapper
`src/nativeNotifications.js`). This wasn't a single migration — it happened in three passes:

1. **The persistent daily summary and the per-task due-by reminder** moved first, specifically
   to make both notifications **reappear immediately if swiped away before they're supposed to
   be dismissed** (task done / nothing left due) — confirmed by reading the stock plugin's
   native source (`TimedNotificationPublisher.java`) that it builds/posts the entire
   `Notification` object natively at `schedule()`-call time with no exposed hook for a custom
   `setDeleteIntent()`, and its own `NotificationDismissReceiver` never calls back to JS for any
   notification type.
2. **Everything else** (extra reminders, the multi-task group summary, and the morning/evening/
   streak-risk digests) moved in a second pass, for consistency/reliability rather than any one
   specific missing capability — plus a new **persistent background-sync foreground service**
   (see below) that keeps the app process alive so all of this computed content can actually
   stay fresh without the user reopening the app.
3. **A UX overhaul pass** (once everything was already native) fixed several rough edges found
   after living with the fully-native design: extra reminders visually doubling up with the due
   reminder instead of just re-alerting it, notifications from this app only grouping together
   *sometimes* rather than always, the group summary showing a bare task count instead of the
   actual pending list, no notification deep-linking anywhere (tapping one did nothing beyond
   whatever `autoCancel` did), no live progress display for quantity tasks, and the persistent
   summary/group-summary re-alerting every time the app was simply reopened even when nothing had
   changed. Covered in Parts B-D and the two new subsections below.

**"Reappear on dismiss," not true non-dismissibility — a real Android policy change, not a
missing flag.** Android 13 made foreground-service notifications swipe-dismissible by
default, and Android 14+ went further: even `setOngoing(true)` no longer reliably blocks
swipe-dismiss for a general-purpose notification, with **no supported opt-back-in flag** —
confirmed against official Android docs
(`developer.android.com/develop/background-work/services/fgs/changes`,
`.../about/versions/14/behavior-changes-14`) and matching third-party reports (the `notifee`
library hit the identical regression). True non-dismissibility is off the table on modern
Android for any notification type this app could use; "briefly disappears on swipe, then
immediately reposts if not yet legitimately satisfied" is the actual achievable goal the due
reminder and summary implement below — every other notification in this section is plain and
swipeable by design (it always was, even on the stock plugin), so this constraint doesn't apply
to them.

Same constraint as the workout session below applies here too: native code must never touch
the app's SQLite file directly, so all persisted state for this plugin lives in
SharedPreferences (`SummaryNotificationStore`, `DueReminderStore`, `ExtraReminderStore`,
`DailyDigestStore` — the group summary needs no store at all, see Part D), never the DB —
`storage.js` remains the sole DB reader/writer.

**Notification-id ranges are split across three independently-maintained Kotlin packages and
must stay disjoint** — nothing enforces this invariant automatically, so any new hardcoded id
needs to be checked against this whole list by hand:
- `notify/` (this package): `DUE_REMINDER_ID_BASE = 600,000,000` (one id per task via
  `DUE_REMINDER_ID_BASE + hashToInt(taskId)`), `SUMMARY_NOTIFICATION_ID = 800,000,001`,
  `EXTRA_REMINDER_ID_BASE = 450,000,000` (one id per `(taskId, slot)` via
  `EXTRA_REMINDER_ID_BASE + hashToInt("$taskId:$slot")`), `RESCHEDULE_REMINDER_ID_BASE =
  480,000,000` (one id per `(taskId, newDate)` via
  `RESCHEDULE_REMINDER_ID_BASE + hashToInt("$taskId:$newDate")`), `GROUP_SUMMARY_ID_BASE =
  700,000,000` (one id per routine via `GROUP_SUMMARY_ID_BASE + hashToInt(routineId)`),
  `MORNING_DIGEST_ID = 900,000,002`, `EVENING_DIGEST_ID = 900,000,003`, `STREAK_RISK_ID =
  900,000,004` (fixed, not hashed — only ever these 3 digest kinds), and
  `BACKGROUND_SYNC_NOTIFICATION_ID = 950,000,001` (also fixed — exactly one background-sync
  notification ever exists), and `APP_GROUP_SUMMARY_ID = 960,000,001` (`AppGroupSummary.kt`,
  also fixed — the one notification flagged `setGroupSummary(true)` for the whole app, see
  Part D).
- `update/`'s `UPDATE_READY_NOTIFICATION_ID = 970,000,001` (`UpdateReadyNotification.kt`, also
  fixed — exactly one update-ready notification ever exists) is a *third* independently
  maintained id, in yet another package — checked against every range in this list at the time it
  was added, same discipline as everything else here.
- `workout/`'s `WorkoutTimerService.NOTIFICATION_ID = 850,000,001` (see below) is a *second*,
  independently maintained id in a completely different package — **this is exactly the gap
  that caused a real collision**: `WorkoutTimerService` originally hardcoded `800000001` before
  the native notifications migration existed, and when that migration picked `800,000,001` for
  the daily summary, nothing cross-referenced the already-existing workout package. Since
  `updateSummaryNotification` fires on every completion change — including every set logged
  during a workout — the two notifications fought over one raw id for the entire duration of
  any workout session (`startForeground(800000001, ...)` vs. plain `notify(800000001,
  ...)`/`cancel(800000001)`), which crashed/froze the app. Fixed by moving the workout timer to
  `850,000,001`.
- The old JS-side id constants this replaced (`notificationIdFor`/`snoozeIdFor`,
  `EXTRA_REMINDER_ID_BASE = 500,000,000`, `GROUP_SUMMARY_ID_BASE = 700,000,000` (JS-side —
  coincidentally the same numeric value the native `GROUP_SUMMARY_ID_BASE` above now uses, pure
  coincidence since the two never coexisted), `MORNING_DIGEST_ID`/`EVENING_DIGEST_ID`/
  `STREAK_RISK_ID`) are gone entirely — nothing in `src/notifications.js` schedules anything
  under a raw numeric id anymore, native code owns every id in this app.

**Any future new native notification id must be checked against every range in this list, not
just the ones in its own package.**

**Part A — summary.** `showSummary`/`cancelSummary` write the `{title, body, ongoing}`
content to `SummaryNotificationStore` *before* posting/cancelling, in that order — this
ordering is what lets `SummaryDismissReceiver` (the notification's real `setDeleteIntent()`
target) tell an organic user-swipe (entry still present → repost) apart from a legitimate
JS-driven cancel (entry absent → no-op) without any race. No alarm is needed here: JS
already reactively reposts this on every app open and completion change via
`syncDynamicNotifications`. `showSummary` now compares the incoming content against
`SummaryNotificationStore.read()` first and no-ops (skips both the store write and the
`notify()` call) if it's identical — added once it became clear `syncDynamicNotifications`
running on every single app open, with no content changed, was re-sounding this persistent
notification every time the user reopened the app (`NotificationCompat` re-alerts on every
`notify()` call by default; nothing here previously suppressed that). This doesn't weaken the
reappear-on-dismiss guarantee: an organic swipe still goes through `SummaryDismissReceiver`,
which reposts unconditionally whenever `awaitingCompletion` is true, entirely independent of
this equality check.

**Part B — due-by reminder.** `DueReminderStore` holds one persisted entry per task
(`{taskId, routineId, title, body, days, hour, minute, group, completionType,
quickAddAmounts, awaitingCompletion}`) — the source of truth for every receiver below, all
of which must work with the app process fully dead. `DueReminderScheduler.schedule()`
compares the new entry against the stored one by content (`.copy(awaitingCompletion =
false)` equality, ignoring the one bookkeeping field) and no-ops if unchanged, which is what
lets a plain resync (app reopen, saving an unrelated routine — `syncAllNotifications`
re-syncs *every* task on *any* save) leave an already-showing reminder alone instead of
destructively cancelling and re-arming it every time. When something *did* change, it
re-arms via `arm()`/`armAt()`, which compute the next trigger through `:shared`'s
`computeNextOccurrenceDaysFromNow(days, hour, minute, todayWeekday, nowHour, nowMinute)` — a
correct replacement for the stock plugin's `DateMatch.postponeTriggerIfNeeded`, which jumps
a full week forward once today's time has passed rather than checking whether another
active day still qualifies this week. `days`/`todayWeekday` use JS's `Date.getDay()`
convention (0=Sunday..6=Saturday) so `task.days` passes through unchanged; only the Android
caller's own `Calendar.DAY_OF_WEEK` (1=Sunday..7=Saturday) needs a `-1` conversion at that
one boundary. Alarms are one-shot and self-reschedule on every fire
(`DueReminderAlarmReceiver` re-arms via `arm()` immediately after posting) rather than using
`AlarmManager.setRepeating()`, mirroring the stock plugin's own confirmed
`TimedNotificationPublisher` self-rescheduling; exact-alarm scheduling degrades gracefully
via `canScheduleExactAlarms()` the same way the stock plugin does, never hard-requiring
`SCHEDULE_EXACT_ALARM`. This same `arm()`/`armAt()`/`canScheduleExactAlarms()` pattern, and the
same day-of-week conversion, is reused as-is by `ExtraReminderScheduler` (Part C) and
`DailyDigestScheduler` (Part E) below.

- **The `isDoneToday`/catch-up mechanism, and a real regression found and fixed during the
  cutover.** `DueReminderScheduler.schedule()` takes an `isDoneToday` boolean computed by
  the JS caller (`isTaskDoneToday(task, completions)` in `src/notifications.js`) — native
  code can't compute this itself, since that means reading SQLite completions, which is
  exactly what native code must never do (see above). Combined with `:shared`'s
  `isOverdueToday(days, hour, minute, todayWeekday, nowHour, nowMinute)`, this lets
  `schedule()` immediately build-and-post the reminder when a task is due today, already
  overdue, and not done — the direct native replacement for the old (now-deleted)
  `catchUpDueReminderIfNeeded`, which existed for the same reason: `AlarmManager` never
  retroactively fires an alarm for a time that's already passed, so without an explicit
  catch-up a brand-new or just-edited overdue task would otherwise stay silent until its
  next natural occurrence, possibly a full week away. Getting this right took two attempts
  in this migration: the first cutover pass had `scheduleTaskNotifications` call the *full*
  `cancelTaskNotifications` (which clears `DueReminderStore`'s entry) before every
  reschedule, which defeated the no-op-if-unchanged comparison above on literally every
  single sync, since there was never a previous entry left to compare against — fixed by
  splitting a `cancelStockNotifications` helper (extra reminders/snooze/legacy per-day ids,
  safe to re-run every sync — since deleted entirely, once extra reminders moved off the stock
  plugin too and there was nothing stock-side left to sweep) out of the full
  `cancelTaskNotifications` (which also clears the native due reminder, called only when a task
  is genuinely being removed or paused).
- **Reappear-on-dismiss and action buttons.** `DueReminderDismissReceiver` (the delete-intent
  target) reposts if `awaitingCompletion` is still `true`, no-ops otherwise.
  `DueReminderActionReceiver` + `DueReminderBridge` (a same-process singleton, the same
  `var onAction: ((JSObject) -> Unit)?` idiom as `WorkoutSessionBridge` below) dispatch
  Mark-done/`+N` taps to JS via `notifyListeners("dueReminderAction", ..., true)` when the
  process is alive. If the process is dead, the action's `PendingIntent` relaunches
  `MainActivity` carrying the action as typed extras
  (`EXTRA_PENDING_TASK_ID`/`EXTRA_PENDING_ACTION_ID`/`EXTRA_PENDING_AMOUNT`), consumed once
  in `NativeNotificationsPlugin.load()` — an accepted tradeoff: unlike the stock plugin, a
  cold-start Mark-done tap visibly brings the app forward, matching what already happens
  tapping the notification body today, not a new class of behavior. Snooze never touches
  completions (a pure +15min re-post, matching the stock plugin's own original `scheduleSnooze`,
  since deleted), so it's handled entirely natively by re-arming the same per-task alarm slot
  via `armAt()` — no JS round-trip needed. The dispatch function itself
  (`dispatchDueReminderAction`, top-level in `DueReminderActionReceiver.kt`, not a method on the
  class) is reused as-is by `ExtraReminderActionReceiver` (Part C) for its own Mark-done/`+N`
  handling — JS's `"dueReminderAction"` listener dispatches purely by `actionId`/`taskId`, with
  no notion of which native mechanism sent it, so no second JS listener was needed for extra
  reminders.
- **Live quantity progress and tap-to-open.** `buildDueReminderNotification` sets a
  `setContentIntent()` (`notificationTapPendingIntent`, see the "Tap-to-open deep linking"
  subsection below) carrying `entry.taskId`/`entry.routineId`, and — for a `completionType ==
  "quantity"` task — a body computed as live progress (`"3 / 10 reps"`,
  `taskNotificationContent` in `src/notifications.js`) instead of a static blurb. Neither of
  these needed a new native mechanism: the body is just whatever `entry.body` the JS caller
  computed, already refreshed on every `scheduleTaskNotifications` call (including the ones
  `handleAddQuantity`/`handleSetQuantity` in `App.jsx` now make after every quick-add
  specifically so this repost happens immediately) and gated by `schedule()`'s own existing
  content-equality/overdue logic above — a quick-add on an already-overdue (hence already
  showing) reminder changes the body, which isn't content-unchanged, so `schedule()` reposts it
  with the new progress the same way it would for any other content change.
- **Boot survival.** `DueReminderBootReceiver` (manifest, listens for
  `BOOT_COMPLETED`/`QUICKBOOT_POWERON`, needs `RECEIVE_BOOT_COMPLETED` added explicitly
  since the stock plugin's own manifest contract shouldn't be load-bearing for a completely
  different notification type) re-arms every `DueReminderStore` entry on boot —
  `AlarmManager` alarms do **not** survive reboot on their own, confirmed by the stock
  plugin needing its own equivalent (`LocalNotificationRestoreReceiver`) for the exact same
  reason. `ExtraReminderBootReceiver` and `DailyDigestBootReceiver` (Parts C and E) mirror
  this exactly, one per store.
  - **A real crash, found via a user's on-device bug report, not CI.** All three boot
    receivers originally were `directBootAware="true"` and also listened for
    `LOCKED_BOOT_COMPLETED`, on the assumption that re-arming alarms as early as possible
    after a reboot — even before the user has unlocked the device once — was strictly
    better. This crashed on *every* reboot, for both flavors, with `Fatal signal 6
    (SIGABRT)` → `IllegalStateException: SharedPreferences in credential encrypted storage
    are not available until after user (id 0) is unlocked`, thrown from
    `DueReminderStore.prefs()`'s `context.getSharedPreferences(...)` call.
    `LOCKED_BOOT_COMPLETED` fires *before* first unlock specifically so direct-boot-aware
    components can run in that window (e.g. showing a lock-screen alarm clock) — but the
    default `getSharedPreferences()` a `Store` class calls is backed by **credential
    encrypted storage**, which is only unlocked once the user enters their PIN/pattern/
    biometric for the first time post-reboot; reading it any earlier throws exactly this
    exception, unconditionally, regardless of device state otherwise. Diagnosed from a real
    bug report (`adb`/computer not available to the reporting user, so via Android's
    on-device "Take bug report" flow, then searching the resulting log text for `FATAL
    EXCEPTION` — the same diagnostic approach already used once before for the workout
    timer's `ACTIVITY_RECOGNITION` crash) — found as `Unable to start receiver
    com.tharuka.routines.notify.DueReminderBootReceiver`, immediately followed by the
    identical trace for the `.dev` flavor. Fixed by dropping `directBootAware="true"` and
    the `LOCKED_BOOT_COMPLETED` action from all three receivers, keeping only
    `BOOT_COMPLETED`/`QUICKBOOT_POWERON` — those fire once the device has actually finished
    booting into a normal, unlocked-at-least-once state, exactly when regular
    SharedPreferences become readable. The tradeoff (alarms re-arm slightly later — once the
    user first unlocks post-reboot, rather than the instant the device powers on — instead
    of immediately) is strictly better than a guaranteed crash on every single reboot; no
    store was migrated to device-protected storage (`createDeviceProtectedStorageContext()`)
    to preserve the original pre-unlock timing, since that would touch every read/write site
    across three independent `Store` classes for a narrow edge case (a reminder due in the
    few minutes between a physical reboot and the user's first unlock) that isn't worth the
    added risk right now.

**Part C — extra reminders.** `ExtraReminderStore`/`ExtraReminderScheduler`/
`ExtraReminderNotificationBuilder`/`ExtraReminderAlarmReceiver` are their own small, dedicated
file set (not a generalization of the due-reminder classes) keyed by `"$taskId:$slot"` — deliberately
mirroring Part B's shape rather than sharing it, both because a task can have up to
`MAX_EXTRA_REMINDERS` of these per task (vs. exactly one due reminder) and to avoid regressing
the already-verified due-reminder path while adding this. The one real difference from the due
reminder: **no catch-up/overdue-today logic** — these were always plain one-shot nudges leading
up to the real due-by moment, never pinned/reappearing, so `ExtraReminderScheduler.schedule()`
is just "is the content the same as last time, and if not, save + re-arm," with no `isDoneToday`
parameter and no immediate-fire path. Same Mark-done/`+N`/Snooze actions as the due reminder
(reusing `dispatchDueReminderAction`, see Part B), but no delete-intent — swiping one away just
dismisses it, same as it always did.

**An extra reminder firing re-alerts the due reminder's own notification, it doesn't post a
second one.** `ExtraReminderAlarmReceiver.onReceive()` reads `DueReminderStore` for the same
task and, if an entry exists (the normal case — `scheduleTaskNotifications` always schedules a
due reminder alongside any extra reminders), sets `awaitingCompletion = true` on it and calls
`buildDueReminderNotification` + `NotificationManagerCompat.notify(dueReminderNotificationId(taskId),
...)` — the *due reminder's* id, not the extra reminder's own. Since `NotificationCompat` re-alerts
(sound/vibration) on every `notify()` call to an id by default, this makes an extra reminder read
as exactly what it's meant to be: "another nudge toward the same task," reusing whatever's already
pinned (or newly pinning it, if the due moment hasn't happened yet) rather than stacking a second,
visually distinct notification for the same task — the pre-overhaul behavior, which read as
"doubling." Every *other* task's notifications are untouched by this — only the firing task's own
due-reminder id is touched. `ExtraReminderAlarmReceiver` only falls back to posting its own
dedicated notification (`buildExtraReminderNotification`, the pre-merge behavior, still kept for
this one case) if no `DueReminderStore` entry exists for the task at all — shouldn't normally
happen, but keeps an extra reminder from being silently dropped if that invariant is ever
violated.

**Part D — group summary, and the app-wide group.** No alarm, and no *persisted* (SharedPreferences)
store — but it does keep a small in-memory `lastPostedContent` map (`GroupSummaryNotificationBuilder.kt`,
keyed by `routineId`) purely to skip a redundant repost, and thus a redundant re-alert, when
nothing actually changed; more below. `buildAndPostGroupSummaryNotification(context, routineId,
title, pendingTaskTitles)` builds and posts directly, the same "compute now, post now" shape as
the summary notification's own `showSummary` — the caller (JS, via `updateRoutineGroupSummary`)
already recomputes and re-calls this on every routine-active-task-count *and* completion change
(see the "Notifications" section above), so there's nothing to reconcile against on a resync
beyond the repost-suppression check. Renders as a real `NotificationCompat.InboxStyle`
notification, one line per currently-pending task title (not just a count) — "N pending" /
"All done for today 🎉" as the collapsed summary text, the full list visible once expanded.
Reuses the `routine-reminders` channel (the same one the due/extra reminders it groups use), and
is deliberately plain/swipeable, not reappear-on-dismiss — see Part B's explanation of which
notifications actually need that behavior and which don't.

- **Suppressing redundant re-alerts.** `lastPostedContent[routineId]` holds the last `(title,
  pendingTaskTitles)` pair actually posted; `buildAndPostGroupSummaryNotification` no-ops
  entirely (skips the `notify()` call) if the new content matches it exactly, and
  `cancelGroupSummary` clears the entry so a routine that later regrows the exact same pending
  list isn't silently skipped. In-memory rather than SharedPreferences-backed on purpose — this
  cache only exists to avoid one process's redundant re-alerts, not to survive process death like
  `DueReminderStore`/`DailyDigestStore` do; a cold start naturally treats its first post as
  "changed from nothing," which is correct anyway. Added for the same reason as `showSummary`'s
  equality check in Part A: this gets called on every app open and background-sync tick
  regardless of whether the pending list changed, and `NotificationCompat` re-alerts on every
  `notify()` by default.
- **`APP_GROUP_KEY` and the real OS group summary (`AppGroupSummary.kt`).** Every notification
  this app posts (due/extra reminders, the group summary above, the daily summary, digests,
  background-sync) shares one flat `APP_GROUP_KEY` string, and `postAppGroupSummary` (called once
  per app-process/bridge start, from `NativeNotificationsPlugin.load()`) posts the single
  notification flagged `setGroupSummary(true)` (`APP_GROUP_SUMMARY_ID = 960,000,001`) — the
  Android-required anchor for reliable, launcher-independent collapsing (without an explicit
  summary, some launchers only auto-generate a collapsed view once 4+ notifications share a
  group). This replaced an earlier per-routine `group` string scheme (`"routine-$routineId"`,
  still passed through from JS as harmless dead weight in some payloads) that left several
  notification kinds — the daily summary, digests, background-sync — with no group key at all,
  which is exactly why "everything from this app groups together" only used to happen
  *sometimes*. A single flat app-wide group, not a per-routine one, is deliberate: Android has no
  concept of nested groups, so "stack everything from this app together" and "stack this
  routine's own tasks together" can't both be true with per-routine keys — routine identity is
  still communicated via each notification's own title (`taskNotificationContent`'s
  `"{routine} · {task}"` format), not a separate OS-level grouping tier.
  `postAppGroupSummary` sets `setOnlyAlertOnce(true)` since its content never changes and it's
  only ever (re)posted once per process start, not on a resync path like the summary/group
  summary above.

**Part E — daily digests.** Morning digest, evening digest, and streak-risk are structurally
identical (single computed title/body, fires once a day at one hour:minute, no actions, plain
dismissible) — unlike extra reminders, these genuinely warrant one shared mechanism rather than
three near-duplicate file sets. `DailyDigestEntry(kind, title, body, hour, minute)` +
`DailyDigestStore` are keyed by `kind` (`"morning"` / `"evening"` / `"streak-risk"`), and
`DailyDigestScheduler` arms one alarm per kind across every day of the week (`days=[0..6]`),
through the same `computeNextOccurrenceDaysFromNow`/no-op-if-unchanged pattern as Parts B/C. No
catch-up logic here either — digest/streak-risk content is recomputed and re-pushed by JS on
every sync, not caught up natively; a gap without a resync just means stale content on an
otherwise still-firing daily notification, matching this feature's original design from before
the native migration. Streak-risk is the one kind that ever needs `cancelDailyDigest` (morning/
evening always have *some* content, even "Nothing due today") — and unlike a plain resync,
resolving a streak needs the *already-showing* notification actively removed, not just the next
day's alarm skipped, since the alarm that would otherwise refresh/clear it isn't due for another
24h. `cancelDailyDigest` therefore calls `NotificationManagerCompat.cancel(...)` in addition to
clearing the store and the pending alarm, the same pattern `cancelGroupSummary`/`cancelSummary`
already established — a gap in the first version of this method (it only cleared the store/alarm,
leaving a resolved streak's notification visibly stuck until manually swiped) caught by writing
`scripts/verify-daily-digest.mjs`'s cancel-when-resolved check before declaring this migration
stage done, not after.

**Tap-to-open deep linking (`NotificationTapIntent.kt`, `NotificationTapBridge.kt`).** Every
builder above now calls `notificationTapPendingIntent(context, requestCode, taskId, routineId)`
and attaches the result via `setContentIntent()` — before this, none of these builders set a
content intent at all, so tapping a notification's body did nothing beyond whatever
`setAutoCancel` did. `taskId`/`routineId` are both nullable: a due/extra reminder carries both,
the group summary carries only `routineId`, and the summary/digests/background-sync carry
neither (they just bring the app to the foreground with nothing specific to focus).
`requestCode` is always the same id already used for the notification itself
(`dueReminderNotificationId`, `groupSummaryNotificationId`, etc.) — this matters because
`PendingIntent.FLAG_UPDATE_CURRENT` overwrites an existing PendingIntent's extras whenever its
`requestCode` + Intent-filter already matches one, so a colliding `requestCode` across two
different tasks' content intents would let one task's already-posted notification silently
start opening a *different* task the moment the second is built.

- **Cold start vs. warm start.** `MainActivity` is declared `android:launchMode="singleTask"` in
  the manifest, so `FLAG_ACTIVITY_NEW_TASK` on the content intent reuses the existing Activity
  instance (routed through `onNewIntent`) when the app process is already alive, rather than
  creating a second one. Cold start (process not alive) is handled the same way the existing
  pending-due-reminder-action mechanism (Part B) already was: `NativeNotificationsPlugin.load()`
  reads `EXTRA_OPEN_TASK_ID`/`EXTRA_OPEN_ROUTINE_ID` straight off the launch `Intent` once the
  bridge is ready and fires `notifyListeners("notificationTapped", ...)`. Warm start needs a
  different path, since a running Activity's original launch intent is long gone by the time a
  new one arrives — `MainActivity.onNewIntent()` (Java) calls
  `NotificationTapBridgeKt.dispatchNotificationTapFromIntent(intent)`, a top-level Kotlin
  function (deliberately *not* `internal` — Kotlin mangles internal member names on the JVM
  specifically to discourage direct Java access, which would make this awkward to call from
  Java) that reads the same extras and invokes `NotificationTapBridge.onOpenTarget` (the same
  same-process-singleton idiom as `DueReminderBridge`/`WorkoutSessionBridge`), wired in
  `NativeNotificationsPlugin.load()` to the identical `notifyListeners("notificationTapped",
  ...)` call. JS sees one event (`initNotificationTapListener` in `nativeNotifications.js`)
  regardless of which path fired it.
- **JS/UI side.** `App.jsx`'s listener switches to the Today tab and stores `{taskId,
  routineId}` in a `focusTarget` state; `TodayView.jsx` receives `focusTaskId`/`focusRoutineId`
  props and runs two effects — one that jumps to today's date and expands the task's group if
  it's collapsed (so the target element actually exists in the DOM), and a second, dependent on
  the first's result, that finds the element by id (`today-task-{taskId}` or
  `today-routine-{routineId}`, added to the relevant `<li>`s), scrolls it into view, and applies
  a temporary `.today-item-focused` outline (`App.css`) before calling `onFocusHandled` to clear
  the state.

### Persistent background-sync foreground service (`BackgroundSyncService.kt`)

None of the computed notifications above (summary, streak-risk, digests) can be freshly computed
by native code — they need SQLite completions data, and native code must never touch the app's
DB directly (see above) — so their content is only ever as fresh as the last time JS actually
ran `syncDynamicNotifications`. Before this service existed, that meant app-open and
completion-change only; leaving the app running in the background for hours (without force-
closing it, but also without interacting with it) produced stale digest/summary/streak-risk
content, since nothing ever re-triggered a resync on its own.

`BackgroundSyncService` is a low-priority, always-on foreground service — the same underlying
mechanism as the workout timer below, applied to a different problem — that keeps the app
process (and its JS engine) alive indefinitely once the app has been opened, and ticks every 15
minutes (`TICK_INTERVAL_MS`, a `Handler(Looper.getMainLooper())` self-rescheduling
`postDelayed` loop — no `WorkManager` needed, since the service itself is the long-lived
context) to re-run the same JS sync an app-open already runs. Started unconditionally from
`NativeNotificationsPlugin.load()` — which fires once per app-process/bridge lifecycle,
independent of Activity foreground/background state, matching "as long as the app process is
running" rather than being tied to one Activity instance the way starting it from
`MainActivity.onCreate()` would be. `BackgroundSyncBridge` (a same-process singleton, the same
`var onTick: (() -> Unit)?` idiom as `DueReminderBridge`/`WorkoutSessionBridge`) calls
`notifyListeners("backgroundSyncTick", ..., true)` on every tick; `initBackgroundSyncListener`
in `src/nativeNotifications.js` wires this to the exact same `refreshAll()` →
`syncAllNotifications` → `syncDynamicNotifications` sequence App.jsx's own app-open effect
already runs, in the same top-level `useEffect`.

- **`specialUse`, not `dataSync`, as the foreground service type — confirmed against current
  Android docs before implementation, not assumed.** `dataSync` looked like the obvious
  semantic fit for "periodically sync data in the background," but Android 15+ (this app
  targets SDK 36) caps `dataSync`/`mediaProcessing` foreground services at 6 cumulative hours
  per 24-hour period while the app is backgrounded — after which the system calls
  `Service.onTimeout()` and requires `stopSelf()` within seconds or throws a fatal
  `RemoteServiceException`. That limit would have silently killed this exact feature (staying
  alive for many hours while backgrounded, which is the entire point) a few hours into any day
  the app isn't reopened. A first pass at researching this (a single `WebFetch` on Android's
  timeout docs) came back with an incorrect summary ("no time limit for `dataSync`"); a
  follow-up `WebSearch` for the same question surfaced a more literal excerpt confirming the
  real 6-hour cap — this project has been burned twice before by trusting a single
  confidently-wrong source on an Android platform-behavior question (the workout timer's
  `ACTIVITY_RECOGNITION` crash and its "promoted" notification API that failed to compile), so
  cross-checking a load-bearing platform claim against a second source before writing code
  against it is now the standing practice, not a one-off. `specialUse` has no such execution
  cap — Android's documented catch-all for foreground-service use cases that don't fit a
  specific category — at the cost of a
  `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="..."/>`
  manifest declaration and the `FOREGROUND_SERVICE_SPECIAL_USE` permission (no runtime prompt),
  plus (only relevant if this app ever ships to the Play Store, which it doesn't today — see
  "Android build" above) Play Console justification-review friction.
- **Notification and Stop action.** Ongoing, `onlyAlertOnce`, "Daily Routines" / "Keeping
  reminders and summaries up to date", on its own `background-sync` channel
  (`IMPORTANCE_MIN`, created by the service itself since only it ever posts to this channel —
  unlike the other three channels, which live in the shared `createNotificationChannels()`
  below). One "Stop" action (`BackgroundSyncActionReceiver` → `ServiceCompat.stopForeground(...,
  STOP_FOREGROUND_REMOVE)` + `stopSelf()`, the same explicit-detach-before-stop pattern the
  workout timer needed — see below for why `stopSelf()` alone isn't sufficient) gives the user
  an escape hatch. Stopping is **session-scoped only** — there's no persisted "disabled" flag,
  so reopening the app restarts it via `load()` again on the next cold start. Good enough for a
  v1 opt-out; a user who wants it permanently off would need to force-stop the app itself
  instead, which already fully prevents any background activity.
- **Testability.** `triggerBackgroundSyncTick()` (`NativeNotificationsPlugin`) exists purely so
  `scripts/verify-background-sync.mjs` can fire a tick on demand via `Runtime.evaluate` instead
  of waiting a real 15 minutes in CI — it calls `BackgroundSyncBridge.onTick?.invoke()` directly,
  bypassing the `Handler` loop entirely.

**Same OEM-battery-optimization caveat as the due reminder applies here, arguably more so** —
this is a long-lived foreground service, exactly the kind of thing aggressive OEM battery
management (OnePlus/OxygenOS named specifically in Part B above) is most likely to kill outright
regardless of `specialUse`'s lack of an OS-level execution cap. A `specialUse` foreground
service with a visible notification is the strongest signal this app can give the OS that it
should be left alone, but it's still a signal, not a guarantee — no app-level code fully
overcomes an OEM that's decided to kill background processes aggressively.

**Verification.** `scripts/verify-due-reminder.mjs` proves the due-reminder catch-up and
reappear-on-dismiss behavior on a real emulator (see "Real-device verification" above) — its
dismiss check needs an actual swipe gesture (`uiautomator dump` + `adb shell input swipe`, safe
here since this notification has no chronometer-driven ticking text, unlike the workout timer
below), not a broadcast straight to `DueReminderDismissReceiver` like the summary check gets,
since the due reminder's delete-intent carries a per-task `taskId` extra this script has no way
to know independently (the id is `crypto.randomUUID()`-generated inside the app and never
exposed to the DOM or `dumpsys`). `scripts/verify-group-summary.mjs` covers the (unrelated)
group-summary notification and the summary's own reappear-on-dismiss check, which *can* use a
plain no-args broadcast since its delete-intent carries no per-instance extra.
`scripts/verify-extra-reminder.mjs` solves the same per-task-id problem a different way: since
extra reminders have no catch-up path to lean on (see Part C), it reads the app-generated task
id directly off the app's own already-open SQLite connection via
`window.Capacitor.Plugins.CapacitorSQLite.query(...)` (a page-JS-side read through the
connection the app itself owns, not a second SQLite driver — see the workout session section
below for why that distinction matters), then broadcasts straight to
`ExtraReminderAlarmReceiver`/`ExtraReminderActionReceiver` to exercise the alarm-fire and
Mark-done/Snooze paths deterministically. `scripts/verify-daily-digest.mjs` covers all 3 digest
kinds, including streak-risk's cancel-when-resolved path (calling
`NativeNotifications.scheduleDailyDigest`/`cancelDailyDigest` directly to simulate "at risk" and
"resolved," rather than re-deriving real multi-day streak state through the UI just to exercise
native plumbing already covered structurally by the mocked-Capacitor unit tests).
`scripts/verify-background-sync.mjs` writes a completion directly through the SQLite plugin
(bypassing `storage.js` and every JS path that would normally trigger a resync on its own) to
isolate the tick's own effect, then calls `triggerBackgroundSyncTick()` and confirms the summary
notification picks up the change, before confirming the Stop action removes the notification.
All five replace the older, single `verify-notification-catchup.mjs` this project started with.

### Live overtime timer for duration-based workout exercises (`WorkoutSessionView.jsx`, `WorkoutSessionScreen.kt`)

A duration-based exercise's set no longer logs from a plain manually-typed number — `DurationTimer`
(a sub-component in `WorkoutSessionView.jsx`, above the default export) is a live, auto-continuing
countdown that replaces this without introducing a new completion type at all: a meditation/plank/
hold-style activity is still just a `'workout'`-completion-type task with one duration exercise: no
separate "timer" mode was needed once this existed. This was a deliberate simplification over an
earlier plan for a wholly separate timer completion type — reusing the existing duration-exercise
flow (and the rest-timer's already-built depleting-ring visual, see `RestRing` just above it in the
same file) covers the same need with far less new surface area.

- **Phases: idle → running → stopped (review).** Tapping "Start" begins a countdown from the
  exercise's `targetDurationSeconds`. **At zero, it does not stop or wait for a tap** — the
  numeric display keeps ticking upward into overtime automatically (`+Ns`, styled in
  `--gold-ink`/`AppPalette.GoldInk` — the same "achievement" hue this app reserves for
  streaks/PRs, since exceeding a target reads as a small win, not a warning) for as long as the
  user keeps going. There is deliberately no "Continue" button anywhere in this flow — a first
  draft of this design had one, and it was explicitly rejected: "there should be no manual click
  needed to continue timing after the initial target time is completed. it should keep going."
  The only manual actions are "Stop" (below) and, once stopped, "Start again" (see the review
  step below) — there is no in-place pause/resume.
- **The countdown renders inside the exact same ring used everywhere else progress "fills in
  step by step"** — the momentum ring that fills as sets complete on every other completion
  type — not a second, differently-styled ring, per explicit product feedback ("use the same
  circle as shown on the start screen"). Both platforms refactored their momentum-ring
  composable/component to take a `fraction` (elapsed/target, capped at 1, instead of
  completed-sets/total-sets) plus custom center content, so `DurationTimer` renders its own copy
  of the identical ring rather than a separate `RestRing`-style depleting ring: web extracted a
  standalone `MomentumRing({fraction, interactive, onClick, pulseKey, hint, children})` function
  component (previously this markup was inlined directly in `WorkoutSessionView`'s render); native
  changed `MomentumRing`'s signature from `(currentSetNumber, totalSets, completedCount, hint)` to
  `(fraction, centerContent: @Composable () -> Unit)`. The ring fills up (0 → 1) as elapsed
  approaches the target and then just stays full through overtime, rather than draining down the
  way the between-sets `RestRing` does — a deliberate visual distinction from resting, matching
  how progress "fills up" everywhere else in this app rather than depleting.
- **Review step, not an immediate log.** Stopping moves to a review screen (still shown below
  the same ring, now frozen at its final fill/value) offering choices matching a direct product
  requirement almost verbatim ("give the option to either log or disregard extra time, or even
  edit and amend extra time, or final logged time"): "Log full time" (target + overtime, the
  default/primary action), "Log target only" (disregard the overtime — only rendered when
  `overtime > 0`, since there's nothing to disregard if the user stopped before ever reaching the
  target), "Edit custom time" (a plain number input, prefilled with the full elapsed value, with
  its own Confirm button), and **"Start again"** (discards this attempt entirely with nothing
  logged and immediately restarts the timer from zero — a direct redo affordance for a mis-timed
  or aborted set, added per explicit request; it's just `start()` called from the review step
  rather than a separate code path). All four/log options funnel into the identical
  `onLog(finalSeconds)` callback → `markDoneWithDuration` → the same `logSetValues` pathway a
  manually-typed duration always used — no analytics-layer changes were needed at all, since
  `getExerciseDurationPR`/`getExerciseTotalDuration` already operate on the raw logged value, not
  the clamped 0–1 completion fraction; confirmed directly against a real `workout_logs` row via a
  Playwright round-trip (typing 99 into "Edit custom time" for a 2s-target exercise persisted
  `duration_seconds: 99`, not `2` or a clamped value).
- **`markDone()` split into a shared `logSetValues`/`onLogSet` core plus two thin entry points** —
  a reps-based `markDone()` (the ring's own tap, non-duration only) and
  `markDoneWithDuration(finalSeconds)` (`DurationTimer`'s `onLog` callback) — on both platforms,
  since a duration set is now only ever logged through `DurationTimer`'s own Stop → review flow,
  never by tapping a ring directly (the reps-mode ring keeps its original tap-to-log behavior
  unchanged, using its own `MomentumRing`/`fraction` call with `interactive = true`).
- **Remounted via `key`, not manually reset.** `<DurationTimer key={`${exerciseIndex}-${setIndex}`}
  .../>` on web, `key(exerciseIndex, setIndex) { DurationTimer(...) }` on native — the parent
  forces a full remount on every set change instead of writing effects to reset `DurationTimer`'s
  internal `phase`/`elapsed`/`editing` state by hand, the simplest way to guarantee no state leaks
  from one set's timer into the next.
- **Weight still applies.** The weight field below the timer (labeled "Weight" or "Added weight"
  per the exercise's `type`, same as every other exercise) is untouched by any of this — a
  weighted plank (added weight on top of bodyweight) logs its weight exactly as it always did,
  independent of which review option picked the duration value.
- **Native gotcha: `Modifier.weight()` only resolves inside a `ColumnScope`/`RowScope` receiver.**
  `DurationTimer` is a plain `@Composable` function, not a `ColumnScope` extension, so its own
  internal wrapping `Column` cannot call `.weight(1f)` on itself the way the reps-mode ring's
  direct parent `Column` can (that one compiles because the `MomentumRing(modifier =
  Modifier.weight(1f), ...)` call for reps sits lexically inside the *outer* `WorkoutSessionScreen`
  `Column`, which is genuinely a `ColumnScope`). `DurationTimer`'s own ring uses a fixed
  `Modifier.fillMaxWidth().height(230.dp)` instead — sized to match the reps ring's typical
  rendered size (both are capped at 230dp by `MomentumRing`'s own `BoxWithConstraints` logic
  either way) without needing an extension-function receiver dance.
- **Ported to native Compose with the identical phase/review structure.** The real app's workout
  session is the native `WorkoutSessionScreen.kt` (see "Native Android workout session" below),
  not `WorkoutSessionView.jsx` — the web view is only ever reached via `npm run dev` in a browser,
  so shipping this feature to actual devices required porting it there too, not just building it
  once on web (a real gap: a user tried the timer on-device before this port landed and saw the
  unchanged old manual-entry field, since native hadn't been touched yet).
- **A real on-device layout bug: the review screen's extra content pushed the weight field
  toward/past the bottom of the screen.** Found via a real device screenshot, not the emulator or
  browser testing — the review step stacks more content than any other state of this screen (ring
  + total + up to three log buttons), and on a real phone's actual viewport height that was
  visibly tight, unlike the idle/running states which only ever show one Start/Stop button below
  the ring. Fixed per direct user feedback by combining "Edit custom time" and "Start again" onto
  one shared row (`.workout-duration-review-secondary` on web, a plain `Row` on native, each
  button taking half width) instead of each getting its own full-width stacked row — reclaims one
  row's height unconditionally, regardless of whether "Log target only" is also showing.
- **Counts down by default, not up — a later, deliberate reversal of the original "always counts
  up from zero" design above.** The live number now shows *remaining* (`target - elapsed`) while
  short of the target, matching an ordinary kitchen-timer expectation, then switches to the exact
  same `+overtime` count-up display once it's reached — nothing about the overtime phase changed,
  only what's shown before it. Every displayed time (the ring's own number, the "Target: …"
  label, and the review step's button text/logged totals) now goes through a shared `formatHms`
  (`src/utils/tasks.js` / a Kotlin mirror in `WorkoutSessionScreen.kt`) rendering `M:SS` or
  `H:MM:SS` instead of a raw `Ns` string — a duration target long enough to need H:M:S setup input
  (see below) needs a matching display, not just a bigger number of seconds.
- **The ring now fills with one continuous sweep instead of a once-a-second step.** The original
  design (described above) re-derived `fraction` from `elapsed` every second and let
  `MomentumRing`'s existing spring animation catch up to the new value each time — technically
  smooth-looking per step, but a fresh spring "catch-up" motion every second reads as discrete
  jumps, not the single continuous fill the rest screen's `RestRing` already had. Fixed by giving
  `MomentumRing` a second animation mode: an optional `animateSeconds` (+ `animateKey` to restart
  it) that, when set, switches from the per-render spring toward `fraction` to a single linear
  animation from empty to full spanning that many real seconds — web via the same two-frame CSS
  `transition: stroke-dashoffset {n}s linear` trick `RestRing` already used (just filling instead
  of depleting), native via the identical `Animatable`/`tween(..., easing = LinearEasing)` pattern
  `RestRing` already used. `DurationTimer` passes `animateSeconds` only while `phase === "running"`
  and target > 0; the idle/stopped states and the reps-tap ring elsewhere are untouched, still
  driven by the original spring-toward-`fraction` path. Because both the ring's sweep and the
  once-a-second `elapsed` counter derive from the same real wall-clock time independently, the
  ring naturally finishes exactly as overtime begins with no explicit hand-off logic needed —
  matching the same "deliberately decoupled from the numeric countdown" relationship `RestRing`
  already had between its ring and its own remaining-seconds label.
- **`MomentumRing`/`DurationTimer` moved out of `WorkoutSessionView.jsx` into their own shared
  file, `src/components/DurationTimer.jsx`**, once a second, unrelated feature (quantity-as-timer
  tasks, below) needed the identical widget with none of the surrounding exercise/weight/reps
  chrome. `DurationTimer` never referenced any of that chrome to begin with, so this was a
  straight extraction, not a rewrite — `WorkoutSessionView.jsx` now imports both and is otherwise
  unchanged. The native side has no equivalent extraction to make: `DurationTimer`/`MomentumRing`
  were already plain top-level `@Composable` functions in `WorkoutSessionScreen.kt`, just marked
  `private`; making `DurationTimer` (not `MomentumRing`, never called directly outside this file)
  non-private was the only change needed for `QuantityTimerScreen.kt` to reuse it (see
  "Quantity-as-timer" below).
- **Setup-time durations (the exercise's "Duration/set", and the new quantity-timer target below)
  are now entered as separate hours/minutes/seconds fields instead of one raw-seconds number** —
  `DurationHMSInput` in `RoutineForm.jsx`, backed by `hmsToSeconds`/`secondsToHms`
  (`src/utils/tasks.js`, both pure and unit-tested) converting to/from the single total-seconds
  value that's all that's ever actually persisted (no schema/versioning change was needed for this
  input style — it's purely a setup-form affordance). Typing "10 minutes" as `600` was always
  possible but never pleasant; this replaced the plain number input outright rather than adding it
  as a second, togglable mode.

### Native Android workout session (`android/shared/`, `android/app/.../workout/`)

The live workout session screen is the one part of the app rebuilt as genuine native
Android (Kotlin + Jetpack Compose), specifically to get a real foreground-`Service`-backed
notification — the two gaps called out just above (no swipe-resistant `ongoing`, no
chronometer) have no JS-side fix. Everything else (Routines, Dashboard, History, all
storage/versioning/analytics) stays untouched in React/JS. `WorkoutSessionView.jsx` is kept
as the **web/dev-loop path** — `src/nativeWorkoutSession.js`'s
`isNativeWorkoutSessionAvailable()` gates on `Capacitor.isNativePlatform()` (same pattern as
every other native-only feature), so `npm run dev` still exercises the full workout UI
in-browser.

**Critical constraint driving the whole bridge design:** native Kotlin code must never open
the app's SQLite database file directly. `@capacitor-community/sqlite` always loads
`net.zetetic:sqlcipher-android`'s `libsqlcipher.so` (confirmed by reading its native
source), never Android's own `libsqlite.so`, even in this app's `'no-encryption'` mode. A
second, independently-linked SQLite library opening the same file in the same process is
the "two copies of SQLite in one process" corruption/deadlock scenario SQLite's own docs
warn about (each library keeps private, non-cooperating POSIX advisory-lock bookkeeping).
**All data exchange between native code and JS goes through the Capacitor plugin bridge
only** — `storage.js` remains the sole DB reader/writer.

- **`:shared` (Kotlin Multiplatform module, `androidTarget()` only for now)** — pure-Kotlin
  ports of `src/utils/workouts.js`'s `computeSessionFraction`/`getExerciseVolume`/
  `getExercisePR` and `WorkoutSessionView.jsx`'s `findNextPosition`, verified against the
  same edge cases as `workouts.test.js`. `commonMain` stays platform-free (no Android/JSON
  imports) so real iOS targets can be added later without touching this logic — iOS itself
  is deferred, not blocked, since it needs a Mac/Xcode toolchain unavailable both locally
  and on `ubuntu-latest` CI runners.
- **`WorkoutSessionPlugin` (`@CapacitorPlugin(name = "WorkoutSession")`)** — `start(payload)`
  launches `WorkoutSessionActivity` via `startActivityForResult` + `@ActivityCallback`,
  passing `taskId`/`taskTitle`/`dateKey`/`exercises`/`logsForDate`/`workoutLogSources` as one
  JSON Intent extra (`exercises`/`logsForDate` shape matches `task.exercises`/
  `workoutLogsByTask[taskId][dateKey]` exactly — no JS-side translation needed;
  `workoutLogSources` is `buildWorkoutLogSources`'s flattened cross-routine output, see
  "Last-used-weight prefill" above). Since `@ActivityCallback` only fires once (on Activity finish),
  per-set progress during the session needs a separate channel: `WorkoutSessionBridge` is a
  same-process singleton (`var onSetLogged: ((JSObject) -> Unit)?`) the Activity calls
  directly and the Plugin wires in `load()` to `notifyListeners("workoutSetLogged", ...,
  true)` — an unofficial but standard Capacitor pattern for mid-flight Activity-to-Plugin
  events. Bounded risk: full process death mid-session loses at most one in-progress
  (not-yet-marked-done) set, since every prior set already went through the normal
  `handleLogWorkoutSet` SQLite write. `App.jsx`'s `handleStartWorkout` branches on
  `isNativeWorkoutSessionAvailable()` but reuses `handleLogWorkoutSet`/`handleCloseSession`
  **unmodified** on both the web and native paths — the payload shapes above were designed
  specifically so no translation layer is needed.
- **`WorkoutSessionActivity` + `WorkoutSessionScreen`** — a full-screen `ComponentActivity`
  (not a Fragment, to avoid entangling Compose with `BridgeActivity`'s WebView hierarchy)
  whose Compose UI is a direct port of `WorkoutSessionView.jsx`'s render tree (exercise nav
  chips, set-input panel, rest screen, finished screen).
- **`WorkoutTimerService`** — a genuine foreground `Service`, started from
  `WorkoutSessionActivity.onCreate()` and stopped from `onDestroy()`. This is the actual fix
  for both gaps described above:
  - `ServiceCompat.startForeground(..., ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)` —
    `health` (not `specialUse`) is Android's documented recommendation for fitness/exercise
    trackers and avoids `specialUse`'s Play Store justification-review friction. Confirmed
    on a real emulator: the resulting notification carries genuine
    `FLAG_FOREGROUND_SERVICE` and survives a real swipe gesture, unlike
    `@capacitor/local-notifications`' `ongoing` flag alone.
  - **Real crash, found via a real device's bug report, not CI**: Android 16 additionally
    requires a `health`-typed foreground service to hold at least one of
    `ACTIVITY_RECOGNITION`/`HIGH_SAMPLING_RATE_SENSORS`/a Health Connect read permission *in
    addition to* `FOREGROUND_SERVICE_HEALTH` itself — enforced server-side
    (`ActiveServices.validateForegroundServiceType`) and thrown synchronously back into
    `Service.onStartCommand()` as `SecurityException: Starting FGS with type health ...
    requires permissions: all of [FOREGROUND_SERVICE_HEALTH] any of [ACTIVITY_RECOGNITION,
    ...]` — every workout session crashed on the reporting user's real Android 16 device from
    the moment this feature was built, well before the notification-id collision or
    ProgressStyle work below. `android-emulator-verify.yml` only runs API 30, which doesn't
    enforce this, so nothing caught it before a real device did; diagnosed by walking the
    user through Android's on-device "Take bug report" flow (no computer available) and
    searching the resulting text for `Process: com.tharuka.routines` to isolate this app's
    crash from the thousands of unrelated lines in a full system bug report.
    `WorkoutSessionActivity.startTimerServiceOncePermitted()` now requests
    `ACTIVITY_RECOGNITION` (declared in the manifest; a runtime/dangerous permission on API
    29+) before ever calling `WorkoutTimerService.start()`/`startForegroundService()` — never
    after, since once that call is made the service is contractually required to call
    `startForeground()` within a few seconds or Android kills it with a *different* crash
    (`ForegroundServiceDidNotStartInTimeException`), so catching the `SecurityException`
    inside the service after the fact isn't sufficient on its own. If the user denies the
    permission, the session still works fully, just without the live timer notification.
  - `setUsesChronometer(true)` (+ `setChronometerCountDown` while resting) gives a real live
    elapsed/rest-countdown display — solved for this one screen; every other screen still
    only has the `setInterval`-based fallback described above.
  - **Stopping a foreground service's notification is not as simple as `stopSelf()`** —
    confirmed on a real device: calling `stopSelf()` alone left the notification and service
    visibly running after the session closed. The fix is calling
    `ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)` first,
    explicitly detaching and removing the notification before stopping the service, rather
    than relying on implicit cleanup via `onDestroy()`.
  - Runs on its own notification channel (`workout-session-timer`), fully separate from
    `notifications.js`'s three JS-created channels.
  - **Its notification id (`NOTIFICATION_ID`) collided with `notify.SUMMARY_NOTIFICATION_ID`
    for a while** — both were `800_000_001`, since this package predates the native
    notifications migration and nothing cross-referenced it when that migration picked the
    same value (see the "Notification-id ranges" paragraph above, which now covers all three
    packages). `updateSummaryNotification` fires on every completion change — including every
    set logged during a workout, via `handleLogWorkoutSet` — so the two notifications fought
    over one raw id for the entire duration of any session, crashing/freezing the app. Now
    `850_000_001`, clear of every other range.
  - **Live in-app stats bar** — the active set-logging screen shows the current exercise's PR
    and running session volume via `getExercisePR`/`getExerciseVolume` (logic that already
    existed in both `:shared` and `utils/workouts.js` but was never surfaced anywhere). The
    PR line is omitted when null (bodyweight/duration exercise, or nothing logged for it
    yet); the volume line is omitted at exactly 0 so an all-bodyweight session never shows a
    meaningless "0". Implemented in both `WorkoutSessionScreen.kt` and
    `WorkoutSessionView.jsx` for parity.
  - **"Up next" preview on the rest screen** — the rest countdown now also shows what's coming
    up (`"Up next: Squats · Set 1 of 3"`), so finishing a set doesn't drop you into an unlabeled
    countdown with no idea what you're resting *for*. No new state or lookahead logic was
    needed: `markDone()` already advances `exerciseIndex`/`setIndex` to the upcoming position
    *before* entering the resting state (so the rest screen could show the right set-dot/ring
    numbers once rest ends), which means `exercise`/`setIndex` already describe the next set for
    the whole duration of the rest screen — the preview just reads them. Never needs a
    "nothing next" fallback either, since the rest screen only ever appears when there *is* a
    next set or exercise (`markDone`'s own `hasNextSet || hasNextExercise` guard) — the
    genuinely last set of a workout skips straight to the finished screen instead.
  - **Radial rest-timer ring** — the rest screen's plain numeric countdown was replaced with a
    ring that visually depletes from full to empty over the rest duration, per the original
    request: *"I want rest period to have a light which smoothly goes round some clean element...
    which indicated rest over when it blinks back to where it started."* Both companions
    deliberately drive this through the platform's own animation system rather than a per-second
    JS/Compose-state redraw loop, since a stepped redraw reads as discrete ticks, not the
    continuous sweep the request asked for:
    - **Web** (`RestRing` in `WorkoutSessionView.jsx`) uses a two-frame CSS-transition trick: an
      SVG circle renders fully "lit" (`strokeDashoffset: 0`, no transition) for exactly one frame,
      then on the next `requestAnimationFrame` tick flips to `strokeDashoffset: CIRCUMFERENCE`
      together with `transition: stroke-dashoffset {duration}s linear` — the browser interpolates
      the change smoothly over the full duration on its own compositor thread.
    - **Native** (`RestRing` in `WorkoutSessionScreen.kt`, placed next to `MomentumRing`) uses the
      Compose equivalent: a single `Animatable<Float>` animated from `1f` to `0f` via
      `tween(totalSeconds * 1000, easing = LinearEasing)` inside a `LaunchedEffect`, drawn as a
      `drawArc` sweep (the same `Canvas`/`Stroke`/`StrokeCap.Round` pattern `MomentumRing` already
      established for its own fill ring).
    - Both use `resetKey` (an incrementing counter, not the raw duration) as the animation's
      restart trigger — two back-to-back rests can have an identical configured duration, and a
      plain `totalSeconds` dependency wouldn't re-fire the effect/LaunchedEffect for the second
      one.
    - The "blinks back to where it started" completion signal is a brief alpha pulse on the ring
      only (not the countdown number): web fades the ring to 15% opacity and back via a CSS
      `@keyframes` triggered on `transitionend`; native mirrors this with a second `Animatable`
      (`blinkAlpha`) driving a `graphicsLayer { alpha = ... }` on the ring's `Canvas`, sequenced
      after the depletion tween in the same `LaunchedEffect`.
    - **The same "capture before reassignment" bug class hit twice in this feature, in both
      companions.** `exercise.restSeconds` can't be read at *render* time on the resting screen,
      because `markDone()` calls `goNext()` (which reassigns `exercise` to the upcoming one)
      shortly after starting the rest — reading it later would silently animate using the wrong
      exercise's configured rest duration whenever the finishing and upcoming exercises differ.
      Both sides fix this the same way: a dedicated `restTotalSeconds` (web state /
      native `remember`) captured at the exact moment rest starts, before `goNext()` runs, and
      used for the ring's duration instead of re-deriving it from `exercise.restSeconds` later.
  - **Last-used-weight prefill, dual kg/lb fields, weight steppers, and a regression warning** —
    the weight input in both companions now prefills with `getLastUsedWeight` (`:shared`'s
    `WorkoutLogic.kt` / `utils/workouts.js`, kept in exact parity like `getExercisePR`/
    `getExerciseVolume` above) — the most recently *logged* weight for that exercise, looking
    back through every prior date and, for today, sets already logged earlier in this same
    session. This fully replaced the exercise config's old `targetWeight` setup field (since
    removed entirely, see "Exercise type" above) — a static per-exercise number set once at
    setup time and never revisited stays stale the moment a lifter actually progresses past it,
    where `getLastUsedWeight` never does. Canonical storage stays kg (all pre-existing weight data is kg
    — confirmed with the user rather than assumed, since the app had never labeled a unit
    before); a second, independently-typed lb field (`kgToLb`/`lbToKg`, both pure functions with
    parity tests on both sides) shows the live conversion, and editing either field recomputes
    only the *other* one, never the field currently being typed into — re-deriving the
    in-progress field on every keystroke would fight the user's own typing with rounding, since
    kg→lb→kg doesn't perfectly round-trip at display precision. Two `±2.5kg` (a common gym plate
    increment) stepper buttons flank the fields for quick adjustment without opening the
    keyboard. If the value about to be logged is lower than `getLastUsedWeight`, both fields and
    a label turn `AppPalette.Bad`/`--bad` (red) as a warning — not a block, since an intentional
    deload is a legitimate training choice, just one worth flagging rather than logging silently.
    - **Cross-routine, not per-task.** `getLastUsedWeight` searches every workout task across
      every routine, matched by `exerciseId` (the cross-routine exercise-repository identity —
      see "Exercise repository" above), not just the one task currently being logged — so
      "Bench Press" logged under one routine prefills/warns against what was last lifted under
      *any* routine that logs it, per a direct user request ("I want the last used weight to
      apply even across routines, if it's the same exercise"). `buildWorkoutLogSources(routines,
      workoutLogsByTask)` (`utils/workouts.js`) flattens every workout-type task into a
      `{taskId, exercises: [{id, exerciseId}], logsByDate}` list — `getLastUsedWeight(sources,
      exerciseId, onOrBeforeDateKey)` then scans that flat shape directly, picking whichever
      `(date, setIndex)` pair across every matching source is latest overall. This flattened
      shape is the actual reason it's a separate exported step rather than folded into
      `getLastUsedWeight` itself: the native companion has no `Routine`/`Task` object model at
      all (`WorkoutSessionActivity` only ever receives flat exercises/logs shapes across the
      plugin bridge — see "Native Android workout session" below), so both platforms scan the
      identical flattened shape with the identical algorithm instead of native needing its own
      differently-shaped traversal. Falls back to matching by exercise *name* when `exerciseId`
      is missing (pre-migration data not yet backfilled), mirroring `getFitnessOverview`'s same
      fallback.
    - **A real race condition, found via a Playwright round-trip, not by inspection.** The web
      companion's `onLogSet` persists through `App.jsx`'s async SQLite write before
      `workoutLogsByTask` updates — so advancing to the very next set immediately after logging
      one would compute `getLastUsedWeight` against *stale* props, prefilling the new set's
      weight field empty instead of with what was just lifted, until some *later* unrelated
      re-render happened to catch up (the initializing effect only reruns on `[exerciseIndex,
      setIndex]`, not when `workoutLogsByTask` eventually arrives). Fixed with a local
      `sessionLogs` mirror, seeded from the `logsForDate` prop once and updated synchronously
      inside `markDone()` itself — the exact same pattern `WorkoutSessionScreen.kt`'s own
      `logsByExercise` local state already used for this reason, which is why the native side
      never had this bug in the first place. `getLastUsedWeight` is called against
      `workoutLogSources` with the current task's own entry's `logsByDate` overridden to merge
      in `sessionLogs`/`logsByExercise` (web/native) — every *other* task's source is used as-is,
      since only the current task is being edited this session — the static cross-session
      history merged with this session's own live edits, rather than either alone.
  - **Rich live notification on Android 16+ (API 36)** — `buildNotification()` branches to
    `buildProgressStyleNotification()` when `Build.VERSION.SDK_INT >= 36` and not resting: a
    real `Notification.ProgressStyle` with one `Segment` per exercise (sized by its planned
    set count, current exercise highlighted in the app's accent color vs. a neutral gray for
    the rest), overall `setProgress` = total sets completed so far, plus the existing
    chronometer, the current exercise name, its last logged set, and a "🏆 New PR!" subtext
    when `isNewPR` (a pure function in `:shared`, comparing the exercise's PR before vs. after
    the just-logged set) says so. `WorkoutSessionScreen`'s `onProgressUpdate` callback feeds
    this — fired on every navigation (`jumpTo`/manual `‹`/`›`) and every logged set, the same
    pattern as the existing `onRestStart`/`onRestEnd` — through `WorkoutSessionActivity` to a
    new `WorkoutTimerService.updateProgress(...)` entry point. The PR/last-set attribution is
    deliberately careful: it's attached to the exercise that was *just* logged, not wherever
    auto-advance lands next, and only clears once navigation actually moves to a *different*
    exercise (see the comments in `WorkoutSessionScreen.markDone()`) — so it stays visible for
    a moment rather than being immediately overwritten by the auto-advance that follows.
    Below API 36, or during rest, this is skipped entirely in favor of the exact original
    plain chronometer notification — zero behavior change for any pre-Android-16 device.
    - **Not attempted: "promoted"/Live-Update prominence.** Android 16 has a separate concept
      (`setRequestPromotedOngoing`/`EXTRA_REQUEST_PROMOTED_ONGOING`) that gives a notification
      higher shelf/lock-screen prominence — confirmed via Android's own docs to be a
      prominence upgrade only, *not* a dismiss-blocker (this notification's actual
      swipe-resistance already comes from being a real foreground service, same as every
      other Android version). A first attempt at wiring this up
      (`notification.putExtra(Notification.EXTRA_REQUEST_PROMOTED_ONGOING, true)`, based on a
      documentation summary that turned out to be paraphrased/inaccurate rather than a literal
      quote) failed to compile — `Unresolved reference` for both the method and the constant
      against this project's compileSdk 36 — while the `ProgressStyle` API used right next to
      it compiled cleanly on the first try. Rather than guess again, this is left as a
      documented follow-up: the exact real API needs to be confirmed against the actual
      `android.jar` or a real device before attempting it a second time. The
      `POST_PROMOTED_NOTIFICATIONS` manifest permission is left declared (harmless, no runtime
      dialog) for whenever that lands.

See "Real-device verification via GitHub Actions emulator" above for how this is actually
proven to work (not just compile) on a real emulator, and for hard-won lessons about
driving a native Compose screen that has nothing to do with the WebView. The
`Notification.ProgressStyle` branch above can only be exercised on a real Android 16 device
or a future API-36 CI emulator image — `android-emulator-verify.yml` currently runs API 30,
which exercises the unchanged plain-notification fallback path, not the new one.

**Restart workout, and a live upward-ticking session timer.** Both platforms' header gained a
live `formatHms`-formatted elapsed-time display (`workout-session-timer` / a plain `Text` in
`TopAppBar`'s `actions`) that ticks every second from when the session screen opened, computed
as a `Date.now()`/`System.currentTimeMillis()` diff against a captured `sessionStartedAt`
(matching the same wall-clock-diff pattern `DurationTimer`'s own live number already uses,
rather than a naive per-tick increment that would drift) — and a Restart action (↺) next to
Close that discards every set logged today for this task and starts the session over from the
first exercise/set, the whole-session analog of `DurationTimer`'s own "Start again" for one set.
- **Confirmed before anything is discarded** — a plain `window.confirm` on web, a Material
  `AlertDialog` on native (the first `AlertDialog` anywhere in this native codebase; every other
  icon-like button in this file is a plain `Text` glyph, not a vector icon, so Restart follows
  suit with "↺" rather than pulling in a new icon library dependency for one button).
- **The actual destructive write (`storage.js`'s `resetWorkoutSessionForToday(taskId, dateKey)`)
  deletes both `workout_logs` and the `completions` row for that task/date outright** — no
  soft-delete/versioning, since neither table is versioned to begin with (this is deliberately
  in the same "genuine hard delete" category as `permanentlyDeleteRoutine`, just narrower in
  scope: one task, one day). Every screen's own local state (`sessionLogs` /
  `logsByExercise`, `exerciseIndex`/`setIndex` back to 0, `finished`/`resting` cleared,
  `sessionStartedAt`/`elapsedSeconds` reset) resets **synchronously, the instant the confirm
  fires** — not after awaiting the DB round-trip — the same reasoning `sessionLogs` itself
  already existed for (the web SQLite write is async; waiting on it before updating the screen
  would leave a stale set/timer visible for a beat).
- **Native still can't touch SQLite directly**, so the actual delete happens JS-side: confirming
  Restart calls `onRestartWorkout()` → `WorkoutSessionBridge.onRestartRequested` →
  `WorkoutSessionPlugin`'s new `workoutSessionRestarted` event → `nativeWorkoutSession.js`'s
  `initWorkoutRestartListener` → `App.jsx`'s `handleRestartWorkout` — the exact same
  same-process-bridge-event shape `onSetLogged`/`onQuantityTimerLogged` already established, one
  more field on `WorkoutSessionBridge` rather than a new mechanism.
- **The finished screen shows the session's total elapsed time** (`WorkoutCompleteScreen` gained
  an `elapsedSeconds` param on both platforms) alongside the existing "N of M sets logged" line.
- Verified on web via a Playwright round-trip logging a set, confirming the header timer
  advances (`0:00` → `0:02` after a ~2s wait), then confirming Restart both resets the on-screen
  set count to `0/3` *and* leaves `workout_logs` genuinely empty (read directly off the app's own
  SQLite connection, not just inferred from the UI). The native Kotlin side follows the identical
  shape but — like every other native-only change in this section — can only be compile-checked
  by `android-build.yml`'s CI run in this environment (no local Android SDK); a real-device or
  emulator pass is the next step to prove it beyond code review, the same caveat every other
  native-only addition here carries until it's had one.

### Quantity-as-timer (`RoutineForm.jsx`, `TodayView.jsx`, `QuantityTimerView.jsx`, native `workout/QuantityTimerScreen.kt`)

A `quantity`-completionType task can be set up as a timer instead of a plain number —
RoutineForm's "Input as: Number / Timer" toggle sets a new `task.quantityMode` (`'number'`, the
existing/default behavior, or `'timer'`). In timer mode the task's `target` (still the same `REAL`
column, still fed straight into the existing `actual/target` fraction math with zero analytics
changes) is interpreted as whole seconds and set up via the same `DurationHMSInput` the exercise
duration field uses, and completion is logged by running the identical `DurationTimer`
widget/review-flow the workout session's duration exercises use (count down, overtime, "Log full
time"/"Log target only"/"Edit custom time"/"Start again") — with none of the weight/reps/exercise
chrome around it, since `DurationTimer` never touched those fields to begin with. `unit` and
`quickAdd` are cleared and hidden in timer mode; they don't apply to a duration.

- **Runs natively on-device, not as a plain WebView `setInterval` — a direct product
  requirement** ("I also want the timer to be native, add it needs to be able to run for a long
  time and avoid backgrounding"), since Android throttles/suspends JS timers the moment the app
  backgrounds, and a meditation/hold-style timer is exactly the kind of task likely to be run with
  the screen off or the app backgrounded. Rather than build a whole second native
  Activity/Service/plugin from scratch, a timer-mode quantity task reuses the *exact* same
  `WorkoutSessionActivity`/`WorkoutTimerService`/`WorkoutSessionPlugin` foreground-service host a
  real workout session already uses (see "Native Android workout session" above) via a much
  smaller `pureTimer: true` payload (`startNativeQuantityTimer`, `nativeWorkoutSession.js` — same
  file/plugin as the workout session launcher, not a separate registration, since it's the same
  underlying Activity) carrying just `targetSeconds`/`initialSeconds`, no
  exercises/logs/workoutLogSources at all. `WorkoutSessionActivity.onCreate()` branches on
  `pureTimer` before parsing anything exercise-related, rendering `QuantityTimerScreen` (a new,
  minimal file: `TopAppBar` + the shared `DurationTimer`, nothing else) instead of the full
  `WorkoutSessionScreen`. `startTimerServiceOncePermitted()`/the foreground service/its
  chronometer notification are reused completely unchanged — a "Ready"/"Remaining"/"Overtime"
  chronometer notification is exactly as meaningful for a plain timer as for a workout, and this
  is what actually gives it the backgrounding survival the request asked for. Logging fires a new
  `quantityTimerLogged` bridge event (`WorkoutSessionBridge.onQuantityTimerLogged`, mirroring the
  existing `onSetLogged` field/idiom) instead of the workout session's `workoutSetLogged`, since a
  pure timer has no `Exercise`/`setIndex` to attach to the event — and, unlike a workout set
  (which stays on screen for the next set), immediately calls the same `finishWithResult()` the
  close (✕) button does, since a quantity task logs exactly one value per run, not a sequence.
  `WorkoutSessionView.jsx`'s web/dev-loop counterpart is `QuantityTimerView.jsx` — same
  `DurationTimer` reuse, reached the same way (`activeSession`, branched by
  `task.completionType` in `App.jsx`, `isNativeWorkoutSessionAvailable()` gating which path is
  taken) as the workout session's own web fallback.
- **Logs additively (`onAddQuantity`), not as an absolute set** — a timer can reasonably be run
  more than once in a day (two separate meditation sessions), and each run should add to the
  day's total the same way the plain quick-add buttons already do, not overwrite it.
- **Auto-update-target opt-in ("new best").** A per-task `autoUpdateTarget` checkbox (default
  off, versioned like every other task field) makes a timer-mode task raise its own `target` to
  whatever was just logged, whenever that run's own seconds exceed the *current* target — judged
  against the single run's value, not the day's accumulated total, since a 65s hold against a 60s
  target is a new best regardless of what else was logged that day. `handleLogQuantityTimer`
  (`App.jsx`) does the additive completion write via the existing `handleAddQuantity`, then
  separately `upsertTask`s the raised target (a genuine new task version, same as any manual
  RoutineForm edit) if the condition holds. The "Target duration" field the task was set up with
  *is* this same value — editing it directly in RoutineForm afterward (including lowering it, no
  floor enforced) is how a fluke session or a deliberate deload gets corrected; the field's label
  switches to "Target duration (your current best)" and its hint text says so explicitly once
  `autoUpdateTarget` is on, since otherwise nothing distinguishes "a value you set" from "a value
  the app silently raised for you."
- **Countdown, H:M:S formatting, and the smooth-fill ring are inherited for free** from the
  `DurationTimer` changes described in "Live overtime timer for duration-based workout exercises"
  above — this feature shares the identical component, not a parallel implementation.

### Fitness Stats (`src/components/DashboardView.jsx`, `src/utils/workouts.js`)

Unlike the workout session screen above, this is **not** native — it's a second sub-tab
inside the ordinary JS `DashboardView` (alongside the existing "Overall" completion
analytics), rendered in the WebView on every platform exactly like Routines/Today/History.
It exists because `getExercisePR`/`getExerciseVolume` (the only fitness stats that existed
before this) both silently skip any set without a `weight` — a bodyweight exercise like
push-ups or a duration one like a plank produced zero PR and zero volume, not just an
undisplayed one.

- **Adaptive, per-type metrics, not one universal set.** A weighted exercise's meaningful
  "how strong am I" number is an **estimated 1-rep max** (`epley1RM`/`getExerciseE1RM`,
  Epley's formula: `weight * (1 + reps/30)`) rather than raw top weight — 100kg×1 and
  85kg×8 aren't comparable by weight alone, and e1RM is the standard way lifting apps
  normalize across rep ranges (confirmed: 85kg×8 has a *higher* e1RM than 100kg×1, despite
  the lower raw weight). A bodyweight/reps exercise gets `getExerciseRepPR`/
  `getExerciseTotalReps` (most reps in one set / total reps, the reps-denominated
  equivalents of PR/volume). A duration exercise gets `getExerciseDurationPR`/
  `getExerciseTotalDuration` (longest hold / total time-under-tension). Which metric a
  given exercise shows is decided at render time from whether any completed set for it
  ever had a `weight` — not from the exercise's configured `unit`, since a nominally
  bodyweight exercise logged with added weight one session should still count as weighted
  that session. **This stays log-based on purpose, deliberately independent of the
  exercise's own `type` field** (see "Exercise type" below) — `type` only changes the live
  logging screen's field label ("Weight" vs. "Added weight"), not how already-logged
  sessions get classified after the fact. This is exactly why a calisthenics exercise
  logged with real added weight (a vest/belt) shows up here with a genuine e1RM/volume
  trend rather than being silently excluded — the classification only ever looks at
  whether a set actually had a weight, never at the exercise's configured type.
- **Every exercise type gets the same single-best-effort-vs-total-volume pair of trend
  charts, not just weighted ones.** Expanding an exercise in the "By exercise" list shows
  two stacked bar-chart trends over its last 8 sessions: the top one is always a
  *single-best-set* metric (e1RM for weighted — Epley's formula already picks the one best
  set of the session, not a sum — `bestReps`/`bestDuration` for bodyweight/duration, the
  reps/duration-denominated equivalent), and the bottom one is always the *session total*
  ("Volume trend": kg × reps for weighted via `series[].volume`, total reps/total duration
  for bodyweight/duration via `series[].totalReps`/`series[].totalDuration`) — `getFitnessOverview`'s
  `series` already carries one entry per date with every metric computed, so no separate
  query is needed for either. This wasn't the original design: the volume trend first
  shipped weighted-only (`getExerciseVolume` requires a `weight` on every set, so it's
  always 0 for bodyweight/duration exercises), and the primary trend for those types used
  to be `totalReps`/`totalDuration` directly — which meant the "second chart" for
  bodyweight would have just duplicated the first one. Fixed by giving the primary trend
  its own single-best-set metric (`bestReps`/`bestDuration`, computed the same way
  `getExerciseRepPR`/`getExerciseDurationPR` already compute an all-time PR, just scoped to
  one session's `completedSets` instead of `entry.logs`) — the exact same
  single-effort-vs-total-work duality e1RM/volume already had for weighted exercises, now
  true for every kind. The exercise-list headline was updated to match (`latest.bestReps`/
  `latest.bestDuration`, not the session total) for the same reason. The volume trend's
  bars use `--accent-chart` (not the primary trend's `--accent-soft`) specifically so the
  two stacked charts read as distinct series at a glance, matching this app's "UI chrome
  vs. chart marks get two different shades of the same hue" design-token convention (see
  "Design system" below) — genuinely useful here since, with few logged sessions, the
  best-set and volume metrics can trend in the *same* direction and look superficially
  similar at a glance; confirmed with a deliberately divergent test case (a 1-rep-max
  single set vs. a many-rep lighter set) that e1RM and volume move independently and
  correctly in opposite directions when the underlying sets genuinely warrant it.
- **`getFitnessOverview(routines, workoutLogsByTask)` merges by exercise *name*, not
  exercise id**, across every workout-type task in the app. Exercise ids are per-task (a
  "Bench Press" added to two different routines gets two different ids), so a PR/trend
  computed per-id would silo the same real-world exercise's history by which routine it
  happened to be logged under. This is the one place in the codebase that deliberately
  looks across every routine at once, rather than one task/routine at a time like
  `getWorkoutStats` (still used by the native session's own in-app stats bar) — the two
  coexist because they answer different questions: "what's this one session's context" vs.
  "what's this exercise's history everywhere."
- **Calisthenics-vs-weightlifting is a session-count/percentage chart, not kg-vs-reps.**
  Weighted volume (kg) and bodyweight volume (reps) are different units and can't share an
  axis — plotting both as two lines on one chart would be a real dual-axis mistake, not
  just a style choice. `getSessionMixByWeek` instead classifies each date's *session* as
  weighted or bodyweight (any weighted set logged that day counts the whole session as
  weighted, since mixed sessions are common) and buckets by week, so the chart tracks
  training-style mix as a percentage — a unit both categories can actually share.
- The overview tiles are genuinely adaptive: a routine with only bodyweight exercises
  shows only the bodyweight-PR tile, not an empty/zero weighted one, and vice versa.

### Data backup & recovery (`src/backup.js`, `src/db.js`, `SettingsView.jsx`)

Two independent layers, deliberately both present rather than picking one:

- **Android Auto Backup** (`android:allowBackup="true"` plus explicit
  `android:dataExtractionRules`/`android:fullBackupContent` XML in `android/app/src/main/res/xml/`)
  is a passive, OS-scheduled safety net — it runs in the background on Android's own timing (WiFi,
  charging, idle) and only actually restores itself on a genuinely fresh install tied to the same
  Google account. The XML rules explicitly `<include>` the SQLite database and this plugin's own
  notification-schedule SharedPreferences rather than relying on the (equally inclusive by default)
  implicit behavior — being explicit here is what gives a clean, documented place to later
  `<exclude>` something sensitive, e.g. once an API key lands in EncryptedSharedPreferences for the
  planned Claude-chat feature.
- **On-demand manual export/import** (`SettingsView.jsx`, reachable via the gear icon in the app
  header) is the verifiable, user-controlled counterpart — export whenever you want a snapshot
  (before trying something risky, moving to a new phone, or just for peace of mind), not just
  whenever Android feels like it.
- **Automatic local versioned backups** (`runAutoBackup`/`listAutoBackups`/`restoreAutoBackup` in
  `backup.js`) are the third layer, added specifically for "seamless, before every release"
  protection: a fresh snapshot is written every time the app is opened (App.jsx's top-level
  mount effect, fire-and-forget so nothing on screen waits on it), to app-private storage
  (`Directory.Data` → Android's `getFilesDir()/auto-backups/`), pruned to the 5 most recent. This
  is a deliberately different mechanism from the manual export above, and a different tradeoff:
  no OAuth/Drive-API integration (a real, standalone feature on the scale of the planned Claude
  chat work — considered and explicitly not pursued, since a normal in-place app update never
  touches this directory at all; only a genuine uninstall wipes it, and the actual risk "before
  every release" is a *bad build corrupting data*, not the update process deleting it) and no
  scoped-storage permission complexity (`Directory.Documents`/`External` need permissions that
  vary awkwardly across Android versions, for a benefit — surviving a deliberate uninstall —
  Auto Backup above already covers for free once its `file` domain include covers this folder).
  `SettingsView.jsx`'s "Recent local backups" list restores any of the last 5 snapshots directly
  (`Filesystem.readFile` → the same `importDatabaseJson` restore path the manual import uses),
  with the same destructive-replace confirmation. Native-only (no-op on web) — there's no
  separate "reinstall" story worth protecting against on a dev machine.

**Export/import go through the sqlite plugin's own `exportToJson`/`importFromJson`, not
hand-rolled per-table `SELECT`s** (`exportDatabaseJson`/`importDatabaseJson` in `db.js`) — this
automatically covers every table (including ones added by future migrations) with zero
export-code changes needed per schema bump, and the exported JSON's own `version` field is the
DB's `PRAGMA user_version` at export time, which is what makes restoring safe: importing recreates
the schema at that exact version rather than needing this app's own migration array to replay.
Import is a **full, destructive replace** (`overwrite: true`), never a merge — `SettingsView.jsx`
confirms this explicitly before touching anything, since it can't be undone.

- **Connection-lifecycle care on restore**, following the same discipline as the native/web SQLite
  warnings elsewhere in this doc: `importDatabaseJson` explicitly closes and nulls the existing
  `dbInstance`/`initPromise` in `db.js` *before* calling `importFromJson` (which rewrites the same
  underlying file from under any already-open handle), then storage.js's own cache is invalidated
  too (`invalidateDbCache`, called from `backup.js`'s `importBackup`) so the next read anywhere in
  the app opens a genuinely fresh connection against the restored data rather than reusing a stale
  handle.
- **A real bug caught by testing this in the browser, not assumed correct**: on the web backend,
  calling `saveToStore` immediately after `importFromJson` — with no connection reopened in
  between — fails with `"No available connection for routines"`, because `importFromJson` alone
  doesn't leave a connection registered for the web backend to persist through. Fixed by having
  `importDatabaseJson` call `getDb()` again (reopening a live connection against the just-restored
  data) before calling `saveToStore`. Found via a real Playwright round-trip in the browser dev
  loop — same "test in browser first" discipline this project has followed since the very first
  SQLite migration — not by inspection alone: create routine A, export, create routine B, import
  A's snapshot back, confirm B is gone and A survives *a full page reload* (proving the restore
  actually persisted to IndexedDB, not just an in-memory illusion), all before ever touching a real
  device.
- Native (`Filesystem`/`Share` from `@capacitor/filesystem`/`@capacitor/share`) writes the export
  to `Directory.Cache` and hands it to the OS Share sheet — the existing FileProvider
  (`file_paths.xml`'s `<cache-path path="."/>`, already present in this project's manifest for
  other plugins) already covers the cache directory, so no new provider config was needed. Web
  gets a plain `Blob` + anchor-`download` browser download instead, both because there's no OS
  share target in a desktop browser and because it doubles as the dev-loop verification path
  above. Import needs no native file-picker plugin at all on either platform — a hidden
  `<input type="file" accept="application/json">` already gets a real native file-chooser from the
  Android WebView, standard HTML5 behavior Capacitor doesn't need to wrap.

**Version display.** `SettingsView.jsx` shows "Version {versionName} (build {versionCode})" right
below the header, native-only (`Capacitor.isNativePlatform()`, fetched via `App.getInfo()`) since
there's no installed build to report on web. Added per a direct user request to "easily identify
which version my app is on" — both numbers are set at CI build time from the same GitHub Actions
run number (`versionName = 1.0.{run_number}`, `versionCode = {run_number}`, see
`android-build.yml`), so either alone already uniquely identifies the exact build; showing both
just makes it easier to read at a glance. Appends "· Test build" when `applicationId` ends in
`.dev`, so it's obvious at a glance which of the two installed flavors (see "Test app / product
flavors" below) is being looked at.

### Android signing (`android/debug.keystore`)

The debug keystore is committed to the repo and wired into
`android/app/build.gradle`'s `signingConfigs.debug`. This is intentional and safe (debug
keystores have a universally-known password and no security value) — without it, every CI
run generates its own random ephemeral debug key, so each built APK would have a different
signature and Android would refuse to install an update over the previous one, forcing an
uninstall (and full data loss) on every release. Never regenerate this file casually.

### Test app / product flavors (`android/app/build.gradle`)

Two product flavors share one codebase: `prod` (applicationId `com.tharuka.routines`, unchanged)
is the real, everyday-use app; `dev` (applicationId `com.tharuka.routines.dev`, labeled "Daily
Routines (Test)" via `src/dev/res/values/strings.xml`) installs *alongside* it as a fully separate
Android app — different applicationId means different app, with its own SQLite DB/SharedPreferences,
not an update to the same one. This exists so work-in-progress builds can be installed and driven
on a real device without any risk to the real app's data.

CI (`android-build.yml`) builds both flavors on every push (`assembleDebug` is AGP's synthetic
aggregate task once `flavorDimensions` exist, so this needed no command changes) and publishes two
independent GitHub Releases: `latest-android` (the `prod` APK, what `src/utils/updateCheck.js`'s
in-app updater checks against) only moves on pushes to `main`, while
`latest-android-dev` (the `dev` APK) tracks the ongoing working branch instead. This means the real
app only ever updates once something has actually been merged to `main` — day-to-day iteration on
the working branch no longer pushes unfinished work to the one app real usage depends on.
`android-emulator-verify.yml` builds and installs only the `prod` flavor, since its verification
scripts assume the real `com.tharuka.routines` applicationId.

**A real bug this introduced**: both flavors share the exact same web bundle (Capacitor copies
one `dist/` into both; flavors only change native Android config), so `updateCheck.js`'s
`checkForUpdate()` can't hardcode a single release tag the way it did before flavors existed —
the `dev` app was checking (and trying to install) the `prod` release's APK, a different Android
package, which fails at the OS installer level ("package appears to be invalid") rather than
updating in place. Fixed by reading the running app's actual applicationId
(`App.getInfo().id`) at check time and picking `latest-android` vs. `latest-android-dev`
accordingly (`releaseTagFor` in `updateCheck.js`, unit-tested directly). One-time consequence for
any device that already had the buggy version installed: since the fix itself ships inside the
very release the broken checker fails to fetch, one manual APK install is needed to get off the
broken version — after that, the in-app updater self-corrects permanently.

**A second, related bug in the same area**: fixing the tag wasn't enough on its own, because
`checkForUpdate()` picked the release's download asset with `.find(a => a.name.endsWith('.apk'))`
— and the `latest-android` tag *predates* the flavor split, so it still carries a leftover
`app-debug.apk` asset (the pre-flavor build's filename) sitting alongside the current
`app-prod-debug.apk`. `softprops/action-gh-release` only adds/overwrites the files it's given on
each run; it never prunes assets that are no longer produced, so that stale asset just sits there
indefinitely. `.find()` returning array order meant the OLD, much-lower-versionCode asset could
get picked over the real one — installing an older build over a newer already-installed one trips
Android's downgrade protection, which (at least on the reporting device) surfaces as the exact
same "package appears to be invalid" toast as the cross-flavor bug above, even though the actual
cause is unrelated. Fixed with `assetNameFor(applicationId)` (`app-prod-debug.apk` /
`app-dev-debug.apk`), matching by exact filename instead of "any `.apk`", with the old loose
`.find()` kept only as a fallback if the exact name is ever missing. The stale asset itself was
left in place (no tool available to delete a release asset from this environment) — harmless now
that it's never matched by name, but worth knowing about if the "one `.apk` asset per release"
assumption is relied on again anywhere else.

**A third bug, found by the "check what version am I on" workflow this section's own version
badge exists for**: the "publish dev release" step's `if:` condition was hardcoded to one
specific working-branch name (`refs/heads/claude/android-routines-app-mvp-gjl4kh`, a leftover
from the session that introduced flavors). It silently stopped publishing the moment a later
session's working branch had a different name — `latest-android-dev` sat stuck on a days-old
build with no error surfaced anywhere, since the workflow step itself still reported success
(it just skipped, matching its `if:` being false). Found only because the app header's version
badge (see "Design system" below) let a user notice the installed build's number wasn't moving.
Fixed by changing the condition to `github.ref != 'refs/heads/main'` — tracks whatever branch is
actively being pushed to, matching the workflow's own catch-all `branches: ['**']` push trigger,
so it can't go stale the same way again the next time a session's branch is named differently.

### In-app update installer (`android/app/.../update/`, `src/utils/updateCheck.js`)

This app is sideloaded, not distributed through the Play Store — only a privileged installer
(Play Store itself, or root) can install a package with zero user interaction at all. A regular
app has no permission that grants that, so a literal zero-tap Play-Store-style silent auto-update
is architecturally impossible here. What *is* achievable, and what this implements, is collapsing
every other step down to nothing: `checkForUpdate()` already ran silently on every app open before
this existed; the gap being closed here is everything between "an update exists" and "it's
installed," which used to require manually tapping Download, waiting for a browser download,
opening Downloads, tapping the file, and finally confirming the install — five-plus taps for
something that can be almost entirely automatic.

- **Flow.** `UpdateChecker.jsx`'s existing silent on-open check, on finding `updateAvailable`, now
  immediately calls `downloadUpdate()` (`utils/updateCheck.js` → native `UpdateInstaller` plugin)
  with no user action required. `UpdateInstallerPlugin.downloadUpdate()` enqueues the APK via
  Android's own `DownloadManager` (reliable large-file transfer, retries, progress — no reason to
  hand-roll this with `fetch`/`Filesystem`) with its own notification hidden
  (`VISIBILITY_HIDDEN`), since this app posts its own notification once the download completes
  instead of relying on DownloadManager's generic one. `UpdateDownloadReceiver` (dynamically
  registered from `UpdateInstallerPlugin.load()`, not manifest-declared — Android 8+ restricts
  manifest-declared receivers for most implicit broadcasts, including this one on some OS
  versions; a runtime-registered receiver has no such restriction and works as long as the app
  process is alive, which it already is thanks to `BackgroundSyncService`, see above) posts a
  plain, dismissible "Update ready" notification whose tap target is the install confirmation
  directly (`Intent.ACTION_VIEW` + `application/vnd.android.package-archive` MIME type against
  `DownloadManager.getUriForDownloadedFile()`'s own content URI). The user's total involvement:
  tap that notification, tap "Install" in the mandatory system dialog. Two taps, both genuinely
  unavoidable — the second is Android's own confirmation, and even Play Store apps get an
  equivalent one the very first time (though not on subsequent updates, which is the one piece
  this app structurally cannot replicate).
- **Deliberately routed through a real notification tap, not an auto-launched install intent the
  instant the download finishes.** Android's background-activity-start restrictions make an
  unprompted `startActivity()` call from a `BroadcastReceiver` unreliable once the app isn't in
  the foreground — exactly the kind of platform assumption this project has been burned by
  confidently guessing wrong on before (the workout timer's `ACTIVITY_RECOGNITION` crash, the
  `dataSync` 6-hour cap). A notification's `PendingIntent`, by contrast, is unconditionally exempt
  from that restriction regardless of foreground/background state — it's the one mechanism in
  this flow guaranteed to work every time, not just when the user happens to still be looking at
  the app when the download finishes.
- **`UpdateDownloadStore`** (SharedPreferences, not the app's DB — native code must never touch
  that directly, see above) tracks the one in-flight/ready download by `versionCode`, letting
  `downloadUpdate()` no-op a repeat call for a build that's already downloading or ready instead
  of re-downloading the identical APK every time the app happens to be reopened before the user
  installs it — the common case, since the check already runs on every app open.
  `installReadyUpdate()` (wired to the in-app "Install" banner's button, and to `UpdateChecker`'s
  `updateReady` listener showing that banner in the first place) re-fires the identical install
  intent directly via `context.startActivity()` — safe here specifically because it's called from
  a live in-app button tap, not a background receiver, so there's no activity-start restriction to
  worry about.
- **`REQUEST_INSTALL_PACKAGES`** (declared in the manifest, non-runtime — no permission dialog of
  its own) is required for this app to request any package install at all on Android 8+. The
  *first* time the install intent actually fires, Android shows a one-time "allow installs from
  Daily Routines" settings toggle if not already granted (the same interstitial the user would
  already be used to seeing from whatever app they used to open a downloaded `.apk` manually
  before); every install after that proceeds straight to the normal confirmation dialog.
- **The old browser-download path (`openDownload`, `window.open(url, '_system')`) is gone
  entirely** — replaced, not kept as a fallback, since `UpdateChecker` already gates its whole
  render on `Capacitor.isNativePlatform()` and the native plugin is registered unconditionally
  alongside every other plugin in `MainActivity.java`, the same way this codebase treats every
  other "native-only, no web fallback needed" feature.
- **A real crash, found via a user's on-device bug report, not CI or the emulator harness.**
  `DownloadManager.Request.setNotificationVisibility(VISIBILITY_HIDDEN)` throws
  `SecurityException: Invalid value for visibility: 2` from `DownloadManager.enqueue()`
  unconditionally unless the app declares `android.permission.DOWNLOAD_WITHOUT_NOTIFICATION`
  — confirmed against AOSP's `DownloadProvider` manifest source
  (`protectionLevel="normal"`, so a plain manifest declaration is sufficient, no runtime
  prompt) rather than assumed. This app hadn't declared it, so the very first silent
  auto-download after this feature shipped crashed the app on every reopen — a genuine
  crash loop, since the same check-and-download runs again on every app open until the
  update is actually installed. Fixed by adding the permission. This also exposed a second,
  more structural gap: the exception was thrown *inside* a `@PluginMethod` body with no
  `try`/`catch`, and it propagated uncaught through Capacitor's plugin-dispatch
  `HandlerThread` and killed the whole process — an uncaught exception on *any* thread
  crashes the app by default, not just the main thread, the same failure class as the boot
  receivers' credential-storage crash above. Both `downloadUpdate()`/`installReadyUpdate()`
  and `UpdateDownloadReceiver.onReceive()` now wrap their bodies in `try`/`catch` and
  `call.reject(...)`/no-op respectively, so a future unexpected failure degrades to "the
  update silently isn't offered this time" instead of taking the whole app down. This is
  also the answer to whether this feature was "verified on a real device beyond
  compile-correctness" — it was, and that verification is exactly what caught this.
- **A real bug, found via a user's on-device report: the second update ever downloaded silently
  failed.** The first auto-update worked end-to-end; every one after produced the "Downloading
  update…" toast and then nothing — no notification, no "Install" banner. Root cause: every
  version downloads to the exact same fixed destination filename (`assetNameFor` returns
  `app-{flavor}-debug.apk` regardless of version, by design — the filename only needs to identify
  the flavor, not the version), and nothing ever deleted the previous download once it was
  installed. `DownloadManager.enqueue()` fails outright the second time a destination file already
  exists — a well-documented pitfall of reusing a destination path (confirmed against Android's own
  DownloadManager issue tracker, not assumed), and the resulting exception was swallowed by
  `downloadUpdate()`'s own `try`/`catch` from the fix above, rejecting the JS promise with no
  visible error beyond the toast's own auto-hide timeout. Fixed by having `downloadUpdate()` call
  `DownloadManager.remove(existing.downloadId)` (clears both the bookkeeping row and the
  underlying file in one call) for whatever entry `UpdateDownloadStore` was already holding, plus
  an explicit `File.exists()`/`delete()` check on the destination path itself as a second line of
  defense for a file left over from before this fix existed, or from a failed download whose
  `UpdateDownloadStore` entry `UpdateDownloadReceiver` already cleared without removing its
  partial file — both run unconditionally before every `enqueue()` call now, not just when a
  version mismatch is detected.
- **`UpdateChecker.jsx` also re-checks on every foreground transition, not just cold app-open** —
  per a direct user request, since the persistent background-sync process (see above) already
  keeps the app process alive for long stretches while backgrounded, and a silent check that only
  ever ran once per fresh launch missed exactly that case. `App.addListener('appStateChange', ({
  isActive }) => { if (isActive) runCheck(true) })` re-runs the same silent check
  `checkForUpdate()`/`downloadUpdate()` path used on mount. This surfaced a latent bug of its own:
  `startDownload()` used to unconditionally set status to `'downloading'` before awaiting
  `downloadUpdate()`, ignoring what it actually resolved with — harmless when only ever called
  once per cold open, but a foreground re-check firing while a previous download was already
  sitting `'ready'` (its Install banner showing) would silently stomp that back to a transient
  "downloading" toast that then auto-hides to idle, dropping the banner for no real reason. Fixed
  by checking `response?.status === 'ready'` first and short-circuiting straight back to the
  `'ready'` state instead of falling through to the downloading-toast path.
- **A real bug, found via a user report: a failed download was completely indistinguishable from
  one still in progress.** `UpdateDownloadReceiver.onReceive()` previously checked only whether
  `COLUMN_STATUS == STATUS_SUCCESSFUL`; any other outcome (a bad redirect, no space left, a flaky
  connection, `DownloadManager` giving up for any reason) just called `UpdateDownloadStore.clear()`
  and returned — no notification, no JS event, nothing. From the user's side this looked identical
  to "still downloading": the `"Downloading update…"` toast shows, its own 4-second display timer
  expires back to idle (see the toast-vs-actual-completion distinction in `UpdateChecker.jsx`'s
  `startDownload`), and then nothing ever happens — no error, no retry prompt, no way to tell
  a transient hiccup from a permanent failure. Fixed with a real failure path on both sides:
  `UpdateDownloadReceiver` now reads `COLUMN_REASON` on any non-success status (`describeDownloadFailureReason`
  maps `DownloadManager`'s own `ERROR_*` constants, or reports a raw HTTP status code per its own
  documented convention for `COLUMN_REASON` on an HTTP failure) and forwards it through
  `UpdateInstallerBridge.onFailed` → a new `updateFailed` plugin event, mirroring the exact shape
  `onReady`/`updateReady` already used. `initUpdateFailedListener` (`updateCheck.js`) wires this to
  a new `'download-failed'` `UpdateChecker.jsx` state showing the actual reason plus a **Retry**
  button (`runCheck(false)`) — since a failed download's store entry is already cleared, a retry
  re-enqueues cleanly rather than getting no-op'd as "already downloading." The `getUriForDownloadedFile()
  == null` case (a success status but no retrievable URI — theoretically possible, previously an
  early `return` with the exact same silent-nothing symptom) now goes through the identical failure
  path instead of a bare early exit. This can't be exercised on the emulator harness (which builds
  a debug APK from this repo itself, so its own update-check always reports "up to date") — verified
  by code inspection and matching against `DownloadManager`'s documented `COLUMN_REASON` contract;
  a real device is needed to observe an actual reason code in the wild, which is exactly what this
  fix now makes possible on the next occurrence instead of a dead end.

### Routine start/end date, auto-archive (`RoutineForm.jsx`, `App.jsx`, `utils/date.js`)

A routine can now be scoped to run only for a specific window instead of indefinitely from
creation: two optional `startDate`/`endDate` fields (nullable `'YYYY-MM-DD'` dates,
`DB_VERSION = 9`) live on `routines`/`routine_versions`.

- **These are current-state gates, checked directly, not per-day-resolved through
  `routine_versions` cutover** — the exact same design as `archived`/`archivedAt` above, for the
  exact same reason: they answer "is this routine even in scope on day X at all," not "what did
  this routine look like on day X," and a per-version resolution would mean an edited end date
  only affecting "today forward," which conflicts with wanting the *current* end date to always
  be what auto-archive checks against. They still flow through the ordinary
  `routineFieldsOf`/`upsertRoutine` diff-and-version path when edited via `RoutineForm`, purely
  for audit-log parity (so "View history" shows when they were set/changed) — `routine_versions`
  carries the same two columns, mirroring `archivedAt`'s own presence on both tables.
- **`endDate` needs no analytics-layer cutover of its own at all.** Once today reaches it,
  `App.jsx`'s `autoArchiveExpiredRoutines()` just calls the existing `archiveRoutine()` — every
  bit of "history before archival stays intact" behavior `archivedAt`'s own cutover in
  `getRoutineFraction` already provides comes for free, no new code path needed. Checked before
  every `refreshAll()` call on app-open and on every background-sync tick (there's no
  backend/cron in this app, so this is inherently "best effort while the process is alive," the
  same tradeoff every other computed-content feature here already makes) — cancels the routine's
  task notifications and group summary first, matching `handleArchiveRoutine`'s own sequence,
  just without the `confirm()` dialog since this fires unattended.
- **`startDate` mirrors `archivedAt`'s cutover on the other end** — a day before it computes as
  "nothing due" (not a miss) in both `getRoutineFraction` and `getDayBreakdown`'s independent
  duplicate of the same check (kept in sync by hand, exactly like the `archivedAt` check already
  had to be). `TodayView.jsx`'s own due-list filter needed a separate, explicit fix: its
  `isTaskDueOn` helper calls `getTaskFraction` directly (not `getRoutineFraction`), so it never
  saw the routine-level `startDate` gate at all — without this, a not-yet-started routine's tasks
  still showed as due on Today. `scheduleTaskNotifications`/`updateRoutineGroupSummary` in
  `notifications.js` gained the identical `startDate > todayKey()` check alongside their existing
  `active`/`archived` gates, so a routine's reminders don't fire before it's actually started.
- **A real concurrency bug, found via a Playwright reload round-trip, not by inspection.**
  `autoArchiveExpiredRoutines()`'s own `archiveRoutine()` write sequence, run concurrently with
  the pre-existing fire-and-forget `runAutoBackup()` call in the same mount effect, hit this
  app's known "web SQLite backend can't handle concurrent `db.query`/`db.run`" failure mode
  (`"cannot start a transaction within a transaction"`, the same class of bug already documented
  for `resolveExerciseIds`/`permanentlyDeleteRoutine`) — fixed by moving `runAutoBackup()`'s
  *start* (still not awaited, still fire-and-forget for its own completion) to after the
  auto-archive/refresh sequence's writes finish. A second, related bug from the same root cause:
  React's `<StrictMode>` (`main.jsx`) double-invokes the mount effect in dev, so
  `autoArchiveExpiredRoutines()` itself could race against its own second invocation — fixed with
  an in-flight-promise singleton (`autoArchiveInFlightRef`, the exact same pattern
  `storage.js`'s own `ready()`/`readyPromise` already uses), so a concurrent call just awaits the
  first invocation's already-in-flight promise instead of starting a colliding second write
  sequence. This matters beyond dev/StrictMode too: the app-open effect and the background-sync
  tick both call this function and can legitimately overlap in production.
- **`RoutineForm.jsx`** adds two plain `<input type="date">` fields under a "Run for a specific
  duration (optional)" label, with a client-side validation error if an end date is set before
  the start date (`hasInvalidDateRange`, folded into the existing `invalidTask` submit-blocking
  gate alongside the unnamed-task/no-days/invalid-workout checks).
- **`RoutinesView.jsx`** shows a not-yet-started routine visibly (not hidden — a deliberate choice
  over hiding it entirely, consistent with how a paused routine still shows in the list) at
  reduced opacity (`.routine-card.upcoming`) with a gold "Starts {date}" chip
  (`.upcoming-chip`, reusing `--warn`/`--warn-soft`) in place of the usual "N% this month" rate
  chip, which is suppressed entirely rather than showing a misleading "0%" for a routine that
  hasn't started accumulating any history yet.

### Per-occurrence task reschedule (`utils/reschedule.js`, `TodayView.jsx`, `RoutineForm.jsx`)

"Something came up" - move *one week's* occurrence of a due task to a different day without
touching its recurring `days` schedule at all. A task normally due Mon/Wed/Fri whose Wednesday
falls through can have just that Wednesday moved to, say, Thursday; every other Wed/Mon/Fri
keeps firing exactly as configured. Deliberately modeled as a one-time move, not a schedule
edit - the distinction versioning already draws between "what does this task look like going
forward" (a `task_versions` edit) and "what happened on one specific day" (unversioned,
completion-adjacent).

- **`task_reschedules`** (`DB_VERSION = 10`) is a small, unversioned table - one row per moved
  occurrence, upserted per `(task_id, original_date)` via its own unique index (rescheduling the
  same original date again replaces the previous move, not stacks a second one). `original_date`
  stops counting as due that week (treated as nothing-scheduled, exactly like a day that was
  never on the schedule - not a miss); `new_date` becomes due in its place, even though it falls
  outside `task.days`. This is why it's *not* a `task_versions` row: it doesn't change what the
  task looks like on any other day, only this one week's single occurrence.
- **`getTaskFraction` (`utils/date.js`) takes a new `reschedules` parameter** (default `[]`,
  fully backward compatible): a date matching some reschedule's `originalDate` returns `null`
  before the normal day-of-week check ever runs; a date matching some reschedule's `newDate` is
  treated as due even when `version.days` says otherwise. `getRoutineFraction` takes the matching
  `reschedulesMap` (task id -> its own reschedules, the identical "load once, pass down" shape
  `taskVersionsMap` already uses) and threads it into every task's `getTaskFraction` call - every
  analytics helper built on top (`calcRoutineStreak`, `calcLongestRoutineStreak`,
  `calcRoutineCompletionRate`, `getDashboardStats`, `getOverallConsistency`, `getDayBreakdown`,
  `getLongestOverallStreak`) got the identical trailing optional parameter, so a reschedule is
  reflected consistently everywhere due-ness is computed - Today, Dashboard, and History all read
  the same `reschedulesMap` App.jsx loads once via `storage.js`'s new
  `getTaskReschedulesForAnalytics()`, mirroring `taskVersionsMap`'s own loading/threading pattern
  exactly.
- **`TodayView.jsx`'s own manual `isTaskDueOn` helper needed the same fix `startDate` did above**
  - it calls `getTaskFraction` directly (not `getRoutineFraction`), so it silently ignored
  reschedules entirely until given the same `reschedules` argument.
- **`utils/reschedule.js`** is a small, pure, fully unit-tested module: `getRescheduleRange`
  returns the inclusive `[min, max]` dateKey bounds a reschedule's `newDate` may land in -
  **future-only, from `originalDate` itself out to 8 days after it**, always, for every task.
  Deliberately anchored to the original day rather than a Monday-Sunday calendar week: this app
  has no other notion of "a week" that isn't already a rolling N-days-back window (the
  Dashboard's "Week" range, every streak/consistency lookback - see `rangeStartDate`/`lastNDates`
  in `analytics.js`/`date.js`, both `today - 6` forward, never calendar-aligned), so a
  calendar-week-based reschedule bound would have been the one inconsistent "week" concept in the
  codebase. Anchoring to the original day itself (not "today") also means the available range is
  the same size regardless of which weekday the task happens to be due on - a Monday-due task and
  a Sunday-due task both get an identical 9-day window, where a calendar-week-anchored range
  would have given the Monday task nearly double the room. Handed straight to a native
  `<input type="date">`'s own `min`/`max` attributes rather than enumerating individual eligible
  dates as a list.
  - **Superseded an earlier per-task `allowCrossWeekReschedule` toggle design** (Monday-Sunday
    week ± 1 day, opt-in per task) - replaced by this single fixed rule for every task, a
    deliberate product simplification rather than a bug fix. The `allow_cross_week_reschedule`
    column (`DB_VERSION = 10`) is left in the schema - harmless, always defaults to 0, no code
    reads or writes it anymore - rather than dropped via a rebuild-and-swap migration, since this
    feature hasn't shipped to production yet and the column costs nothing sitting unused; a real
    column drop is the correct move if this is ever revisited.
- **`RescheduleControl`** (`TodayView.jsx`) renders inline for a due task, in one of two states:
  an eligible normal due day shows a plain "Reschedule" button that opens an inline
  `getRescheduleRange`-bounded date picker with Confirm/Cancel; a day that's due *because* of an
  incoming reschedule shows "Moved from {date}" plus an Undo button
  (`onClearReschedule` → `clearTaskReschedule`) instead. Deliberately rendered as a sibling after
  the row's own markup, never nested inside it - the simple-routine boolean row wraps its
  checkbox in a `<label>`, and nesting another button inside that label would have silently
  double-fired the checkbox's own toggle on every click (the same class of click-delegation
  gotcha `ExercisePickerModal`'s `onMouseDown` trick above already had to work around, for a
  different reason). Wired into all six task-row shapes this view renders (simple/grouped ×
  quantity/workout/boolean) - `QuantityControl`/`WorkoutTaskCard` gained the same three new
  optional props and render `RescheduleControl` once internally, rather than duplicating the
  wiring at each of their four call sites.
- **App.jsx's `handleRescheduleTask`/`handleClearReschedule`** call `setTaskReschedule`/
  `clearTaskReschedule` then a full `refreshAll()` - not just a completions patch like
  `handleToggleComplete`/`handleAddQuantity` above, since a reschedule changes which days are due
  at all, not what's logged on an already-due day. Both re-sync the task's notifications
  afterward, which now actually moves the reminder too - see below.
- **The reminder now moves with the task, via a genuinely new native alarm type
  (`notify/RescheduleReminder*.kt`).** Every pre-existing scheduler
  (`DueReminderScheduler`/`ExtraReminderScheduler`/`DailyDigestScheduler`) only ever knows how to
  arm a recurring alarm across a set of weekdays - none of them can fire once, on one specific
  calendar date, which is exactly what a moved occurrence needs. `RescheduleReminderScheduler`
  parses `entry.newDate` (`'YYYY-MM-DD'`) directly into a `Calendar` moment instead of reusing
  `computeNextOccurrenceDaysFromNow`'s day-of-week arithmetic, since there's no recurrence to
  compute - `RescheduleReminderAlarmReceiver` fires exactly once and clears its own store entry
  immediately after posting rather than self-rescheduling. `RescheduleReminderStore` is keyed by
  `(taskId, newDate)`, the same multi-entry-per-task shape `ExtraReminderStore` already
  established (a task can have more than one active reschedule at once, across different weeks).
  Reuses the due reminder's channel and its exact Mark-done/`+N`/Snooze action-dispatch plumbing
  (`dispatchDueReminderAction`) as-is.
  - **`scheduleTaskNotifications` (`src/notifications.js`) rebuilds every reschedule reminder
    from scratch on every sync** (`nativeCancelRescheduleReminders` unconditionally, then one
    `nativeScheduleRescheduleReminder` call per current `task_reschedules` row) rather than
    diffing against what was previously armed, the way the due/extra reminders carefully avoid
    doing. This is safe specifically *because* it's a one-shot alarm: unlike the due reminder,
    it has no persisted `awaitingCompletion`/reappear-on-dismiss state a destructive cancel+rearm
    could lose - re-arming to the identical trigger moment is invisible to the user either way.
  - **The original day's recurring due/extra reminders must not fire visibly for a rescheduled-away
    occurrence, or the task would get a reminder for a day it's no longer due on.**
    `DueReminderEntry` gained a `skipDates: List<String>` field - the task's own outgoing
    `task_reschedules.originalDate`s, computed in JS and passed straight through
    `scheduleDueReminder`. `DueReminderAlarmReceiver` checks `todayDateKey()` against
    `entry.skipDates` before posting (but *always* re-arms next week's occurrence regardless -
    the recurring schedule itself is untouched, only this one week's visible post is
    suppressed), and `DueReminderScheduler.schedule()`'s immediate overdue-catch-up path gets the
    identical check, so a freshly-rescheduled task doesn't get an instant catch-up post for the
    day it was just moved off of. `ExtraReminderAlarmReceiver` (which re-alerts the *due*
    reminder's own notification id, not a separate one, when it fires) checks the same
    `skipDates` on the due entry it reads before re-alerting, and - unlike its existing
    no-due-entry fallback - does *not* fall back to posting its own dedicated notification when
    skipped, since a nudge toward a task that isn't due today would be actively wrong, not just
    redundant.
  - **Content-equality no-op discipline extends for free.** `skipDates` is just another field on
    the `DueReminderEntry` data class, so it participates in the exact same
    content-unchanged-means-do-nothing comparison `DueReminderScheduler.schedule()` already used
    for every other field - a reschedule changes it, which correctly triggers a re-save (and a
    harmless re-arm to the same trigger time), while an unrelated resync with no reschedule
    changes leaves everything untouched. `getTaskReschedulesForAnalytics()` gained an explicit
    `ORDER BY original_date ASC` specifically so the `skipDates` list JS derives from it is
    order-stable between reads, keeping that equality check meaningful (list equality is
    order-sensitive) rather than occasionally flagging a no-op resync as "changed" over pure
    result-ordering noise.
  - **`permanentlyDeleteRoutine` also deletes `task_reschedules` rows for each of a routine's
    tasks** - the one place in this codebase that does genuine hard deletes (see the versioning
    philosophy above), so this is the one spot orphaned reschedule rows are actually worth
    cleaning up; a soft-deleted task's stale reschedule rows are left alone, matching how its
    other history is preserved, since they're already excluded from every live query by the
    `deleted = 0` filter.
- Verified via a Playwright round-trip: the Reschedule button appears on an eligible due task
  with the date picker's `min`/`max` correctly bounded to `[originalDate, originalDate + 8]`
  (confirming with the original date itself stays disabled - a no-op move - while the 8-days-out
  bound confirms successfully); confirming a reschedule immediately removes the task from today's
  due list (rescheduled away, not missed);
  the underlying `task_reschedules` row persists with the correct task/date pair (confirmed via a
  direct SQLite query, the same technique this project's native `scripts/verify-*.mjs` scripts
  already use). The "moved-in" display and Undo path are covered by unit tests
  (`date.test.js`/`reschedule.test.js`) rather than an end-to-end UI walk-through - a freshly
  created test task is only ever "effective" (via `findEffectiveVersion`) from its own creation
  date forward, and `TodayView`'s date nav can't browse into the future either, so no date exists
  that's simultaneously old enough to already have an effective version and new enough to be
  UI-navigable within one fresh test session; a task that's actually existed for a while (the
  real-world case) doesn't have this limitation. The native reminder-moving half
  (`skipDates`/one-shot scheduling) is covered by `src/__tests__/notifications.test.js`'s
  `scheduleTaskNotifications` payload assertions (a task with no reschedules gets an empty
  `skipDates` and zero one-shot reminders scheduled; a task with an active reschedule gets its
  `originalDate` in `skipDates` and a matching `scheduleRescheduleReminder` call mirroring the
  due reminder's own content) rather than an on-device alarm-firing test - this environment has
  no Android SDK/emulator to actually let a `RescheduleReminderAlarmReceiver` alarm fire and
  confirm the real notification appears; that's the one piece only the
  `android-emulator-verify.yml` real-device harness (or a manual on-device try) can prove beyond
  compile-correctness and code review.

### Forward date navigation on Today (`TodayView.jsx`)

`DateNav` no longer caps navigation at today - a future day is projected with the exact same
due-ness math (`getTaskFraction`/`getRoutineFraction`) every other date already uses, since
neither function special-cases past/present/future at all; there's nothing to load or compute
differently the further out you go, so there's no forward limit. A future day is deliberately a
*planning/reschedule-only* view, not a way to log ahead of time: `TodayView`'s own `isFuture`
(`dateKey > todayKey()`) gates every completion-input control - the boolean checkbox, quantity
quick-add/Custom buttons, and (via their pre-existing `!isToday` gates, unaffected by this change)
timer/workout starts - while `RescheduleControl` stays fully available on any future day, since its
own range logic (`getRescheduleRange`) was already anchored to the *viewed* date, not "today," and
needed no changes at all. A gold "Planning ahead" tag (`.date-nav-future-tag`, reusing
`--warn`/`--warn-soft`) marks a future day at a glance.

### Ad-hoc/one-off workouts, and skipping a scheduled one (`TodayView.jsx`'s `WorkoutPickerModal`, `storage.js`, `notifications.js`)

A "Start Workout" button (today-only, hidden entirely if no workout task exists anywhere yet)
opens a picker listing every workout-type task across every routine - not just what's due today -
so a workout can be logged regardless of schedule. This needed no new analytics plumbing at all:
`handleLogWorkoutSet` already writes both `workout_logs` (keyed by task id + date, merged
cross-routine by `exerciseId` via `getFitnessOverview` - see "Exercise repository" above) and a
`completions` row for that task/date unconditionally, and `getTaskFraction`/`getRoutineFraction`
only ever look at a task's own `days`/version to decide due-ness, never at whether a completions
row exists - so logging a set for a task that isn't due today just writes an inert completions row
for a date that was never going to count toward that task's own streak/consistency anyway, while
the exercise-level PR/volume/e1RM history updates immediately and correctly, exactly like any other
logged set.

- **Cancelling ("skip") one of today's scheduled workouts, with no analytics effect, reuses the
  existing per-occurrence reschedule mechanism instead of inventing a second concept** - a direct
  product decision (see the git history for this feature): a skip is a reschedule with no landing
  date. `task_reschedules.new_date` was `NOT NULL` since it was introduced (`DB_VERSION = 10`);
  `DB_VERSION = 12` rebuilds the table (SQLite can't relax a `NOT NULL` constraint via `ALTER
  TABLE`, only a create/copy/drop/rename) to make it nullable, with the usual
  `ensureTaskRescheduleNullable` self-heal check (`PRAGMA table_info`'s `notnull` column) alongside
  every other schema-drift guard this codebase has needed since `DB_VERSION = 8`'s real partial-
  apply bug. `storage.js`'s `skipTaskOccurrence(taskId, date)` is a thin, intent-naming wrapper over
  `setTaskReschedule(taskId, date, null)` - no new storage primitive was needed.
- **`getTaskFraction`/`getRoutineFraction` needed zero code changes for this.** `originalDate`
  already stops counting as due regardless of what (if anything) `newDate` is - that check never
  looked at `newDate` to begin with. The "does some reschedule land on this date" check
  (`reschedules.some((r) => r.newDate === dateKey)`) already only ever matches a real date string,
  so a `null` `newDate` simply never matches anything - a skip row produces no landing day, for
  free.
- **Undo reuses the identical `onClearReschedule` path a real reschedule's Undo already uses** -
  `WorkoutPickerModal` calls `onRescheduleTask(task, todayKey(), null)` to skip and
  `onClearReschedule(task, todayKey())` to undo, both already-existing `TodayView` props. No new
  `App.jsx` handler was needed for either action.
- **A skipped task disappears from the normal due list entirely** (since it's no longer due), so
  there'd be no way to undo it from there - unlike a genuine move, which shows "Moved from {date}" +
  Undo on the *new* day via the ordinary `RescheduleControl`. `WorkoutPickerModal` computes its own
  "Scheduled today" section independent of the live due list - by checking `isTaskDueOn(task,
  taskVersionsMap, today, [])` (an empty reschedules array, i.e. the *naive* schedule ignoring any
  reschedule) rather than reading off `dueRoutines` - specifically so a just-skipped task still
  shows up there with a "Skipped today" tag and its own Undo button, instead of silently vanishing
  the moment it's cancelled.
- **"Swap out" a scheduled workout is just these two existing actions used together** - Skip the
  scheduled task, then Start a different one from the same picker - rather than a single compound
  "swap" action. Both are independently useful (skip-without-replacing covers "cancel one of
  several scheduled today"; starting a different workout without skipping anything covers "log an
  extra session alongside what's scheduled"), so a single fused action would have removed
  flexibility without saving a meaningful number of taps.
- **Native reminders**: `scheduleTaskNotifications`'s existing one-shot reschedule-reminder loop
  (`RescheduleReminderScheduler`, see "Per-occurrence task reschedule" above) now skips any row with
  `newDate == null` - a skip already suppresses the original day's recurring due/extra reminders via
  the pre-existing `skipDates` mechanism (which never depended on `newDate` either), but there's no
  landing date to arm a one-shot alarm for.

### Routine editor usability (`RoutinesView.jsx`, `RoutineForm.jsx`)

Three small fixes to the routine-editing flow, all found by direct user report of friction while
actually using the app, not from a design review:

- **Auto-scroll to the form on Edit.** `RoutineForm` renders above `routine-list` in
  `RoutinesView.jsx`, so clicking "Edit" on a card the user had scrolled down to find used to open
  the form entirely off-screen with no visible feedback that anything happened. A `formRef` +
  `useEffect` (keyed on `[showForm, editing]`) calls `scrollIntoView({behavior: 'smooth', block:
  'start'})` whenever the form opens or its target changes.
- **Confirm before discarding an in-progress edit.** `RoutineForm` keeps its own `routine`/`tasks`
  state internally (seeded once from the `initial` prop) and exposes no "dirty" flag to its
  parent, so nothing previously stopped a user mid-edit of one routine from clicking "Edit" on a
  *different* card and silently losing whatever they'd typed. `confirmDiscardIfEditing` in
  `RoutinesView.jsx` gates `startEdit`: if the form is already open and the clicked routine isn't
  the one currently being edited, a plain `window.confirm(...)` (the same pattern already used for
  archive/permanent-delete elsewhere in this app) must be accepted before the switch proceeds.
  **A real bug found while verifying this fix, not a pre-existing one**: adding the confirm gate
  alone wasn't sufficient — `RoutineForm` was never given a `key` prop, so React kept the *same*
  mounted instance across the switch and its `useState(() => ...initial)` lazy initializers never
  re-ran, meaning the form kept showing the routine that was being edited *before* the switch even
  after the user confirmed discarding it. Fixed with `key={editing?.id ?? 'new'}` on the
  `<RoutineForm>` element in `RoutinesView.jsx`, forcing a genuine remount (and therefore a fresh
  `useState` seed from the new `initial`) every time the edit target actually changes. Caught by a
  Playwright round-trip asserting the title input's value after switching, not by inspection.
- **Exercise cards collapse by default, with an Expand all/Collapse all toggle.** Before this,
  `ExerciseListEditor` (inside a workout task's editor) rendered every exercise as a fully expanded
  `form-card` unconditionally — the one part of `RoutineForm` that had no collapse mechanism at
  all, unlike the multi-task list one level up, which already defaulted to collapsed
  `task-edit-row` summaries (`editingTaskId` starting at `null`). Now mirrors that exact pattern:
  `editingExerciseId` (single id or `null`) controls which one card is expanded, each collapsed row
  shows a summary line (`exerciseSummary`: type · sets × reps-or-duration) with Edit/Delete
  buttons, and a per-exercise "Done" button collapses it back. `addExercise()` still auto-opens the
  newly created exercise (so it's immediately editable, matching `addTask`'s equivalent behavior),
  which also means every *previously* open exercise collapses back down the moment a new one is
  added — the same implicit "only one open at a time" behavior the task list already had. A
  separate `expandAll` boolean (only shown once there's more than one exercise) overrides
  `editingExerciseId` entirely while true, so every card renders expanded at once; toggling it back
  off resets `editingExerciseId` to `null` rather than leaving whatever was last open still
  expanded.

### Supersets (`src/utils/supersets.js`, `RoutineForm.jsx`, `WorkoutSessionView.jsx`, native `SupersetLogic.kt`/`WorkoutSessionScreen.kt`)

Two or more exercises in a workout task's `exercises[]` can be linked into a superset:
performed back-to-back with no rest between them, one shared rest only after the *last* member
finishes a round. This changes session *navigation order* only — logging, PRs, volume, and every
other exercise-level stat are completely untouched.

- **Data model.** Contiguous exercises sharing the same `supersetGroupId` (a fresh
  `generateId()` value, not a stable identity like `exerciseId`) form one group; `null` means
  "not part of a superset," identical to every exercise's behavior before this field existed —
  no migration was needed since `exercises` already lives inside the task's JSON blob. Groups
  are only ever contiguous *by construction*: the only way to create/extend one is linking two
  array-adjacent exercises (see below), never validated after the fact.
- **`utils/supersets.js`** is pure and fully unit-tested (`supersets.test.js`), mirrored exactly
  in Kotlin by `SupersetLogic.kt` (`SupersetLogicTest.kt`) — same function names, same behavior,
  verified independently on each platform rather than one being a port assumed-correct from the
  other:
  - `isLinkedToNext(exercises, i)` — whether exercise `i` shares a group with `i+1`.
  - `toggleSupersetLink(exercises, i)` — flips that one adjacency, then **rebuilds every group id
    in the array from scratch** based on the resulting chain of linked/unlinked pairs, rather
    than trying to hand-merge/split existing ids. This is what makes linking the last member of
    an existing group to a fresh exercise correctly extend the group, and unlinking one link in a
    3-member group correctly split it into a pair + a single, without a combinatorial explosion
    of merge/split cases to get right.
  - `normalizeSupersetGroups(exercises)` — same rebuild, without toggling anything; called after
    any structural change (add/remove an exercise) that isn't itself a link toggle, so a group
    left at size 1 (its only partner was deleted) collapses back to `null` instead of a
    meaningless "superset of one."
  - `groupExercises`/`supersetGroupLabels` — clusters the array into its contiguous groups and
    assigns each *multi-member* group a display letter (A, B, C, ...), used identically by the
    editor (group headers) and the session view (the "Superset A" label + exercise-nav-chip
    accent).
  - **Session navigation**: `buildSupersetSequence(exercises)` produces the full ordered
    `(exerciseIndex, setIndex)` traversal for one session — round-robin within a group (every
    member's set 1, then every member's set 2, ...) instead of finishing one exercise before
    starting the next. A solo, ungrouped exercise is just a group of one, so this function is
    always used unconditionally — it degrades to the exact plain in-order traversal every
    exercise used before this feature existed, with zero special-casing needed anywhere it's
    called. `findNextSupersetPosition`/`nextSupersetPosition`/`prevSupersetPosition` are built on
    top of it; `shouldRestAfter(exercises, exerciseIndex)` is `false` only when that exercise is
    chained mid-superset into the next member (no rest, regardless of that exercise's own
    `restSeconds`), `true` otherwise (last member of a group, or any ungrouped exercise).
  - `WorkoutSessionView.jsx` replaced its old local `findNextPosition`/`goNext`/`goPrev` and the
    rest-trigger check in `logSetValues` with these functions directly;
    `WorkoutSessionScreen.kt` mirrors the same replacement 1:1, including the identical
    `movingToNewExercise`-based progress-notification refresh logic.
- **Editor UI (`RoutineForm.jsx`'s `ExerciseListEditor`)** — builds directly on the exercise-card
  collapse work above. Each pair of adjacent cards gets a `+ Link as superset with next exercise`
  / `🔗 Superset link - tap to unlink` connector button between them; a multi-member group renders
  a `Superset {letter}` header above its first card and a `superset-grouped` left-accent border on
  every member (both collapsed rows and expanded cards, and the session's own exercise-nav
  chips). **Editing "Sets" on any member auto-syncs the same value to every other member of its
  group** — a superset's rounds have to move in lockstep, so rather than validating and blocking
  on a mismatch, `updateExercise` just propagates the new `targetSets` across the whole group
  whenever the patch touches it. The "Rest between sets" field is replaced with a plain note
  ("No rest — moves straight into the next superset exercise") for every member except the last,
  since that's the only one whose `restSeconds` is ever actually read by `shouldRestAfter` above.
- **AI import (`src/aiImport.js`)** — an AI-generated exercise can carry a temporary
  `supersetGroup` string label (any value, e.g. `"A"`); `resolveSupersetGroups` (called after
  every exercise in a task has been converted) turns a *contiguous* run sharing a label into a
  real shared `supersetGroupId`, exactly the same contiguity rule the editor enforces. A label
  reused by a non-adjacent exercise (or a second separate contiguous run) can't be merged into
  the first group — that reuse is left ungrouped with a note pushed onto the import's `notes`
  list, rather than silently producing a different grouping than the AI likely intended.

### AI-generated routine import (`src/aiImport.js`, `SettingsView.jsx`)

V1 of "generate routines with AI": a plain paste-JSON importer in Settings, not a chat interface
embedded in the app — a direct product decision to ship something useful now rather than building
an AI integration (API key storage, streaming, cost) as a first step. The actual workflow is: copy
a schema prompt out of Settings, paste it into any AI chat (ChatGPT, Claude, etc. — genuinely
chat-agnostic, since the mechanism is just "paste text, get JSON back"), ask it to generate a
routine, copy its JSON reply back into the same Settings screen. Chosen specifically because it
works from a mobile browser tab with zero setup — no API key, no new permission, no native code —
matching the explicit ask ("something I can easily copy and get out of chatgpt chat even on
mobile, maybe json format?").

- **Additive only, never destructive.** Unlike `backup.js`'s full-replace restore (which the
  Settings screen already warns is irreversible), an AI import only ever calls `upsertRoutine`/
  `upsertTask` with fresh `generateId()`-generated ids for entirely new routines — it never reads,
  diffs, or touches anything already in the app. `App.jsx`'s `handleAiImport(results)` loops
  `upsertRoutine` + `upsertTask` per `{routine, tasks}` pair exactly the same way
  `handleSaveRoutine` already does for a normal form save, then calls the same `refreshAllAndSync()`
  helper `SettingsView`'s backup-restore path already reuses (full state refresh + notification
  resync) — no new orchestration pattern was needed.
- **One module is both the schema documentation and the validator, so they can't drift apart.**
  `AI_IMPORT_PROMPT` (the copyable text shown in Settings) is a template literal built from the
  exact same constants (`ICON_OPTIONS`, the completion-type/quantity-mode/exercise-type enums)
  that `parseAiImportText`'s conversion functions (`convertRoutine`/`convertTask`/`convertExercise`)
  validate against — there's no second, independently-maintained copy of "what fields exist" to
  keep in sync by hand. **This is also the one place in the codebase explicitly flagged to update
  whenever a new task/exercise config option is added** — a new field needs one change here (both
  the prompt text and the corresponding `convert*` function), not a parallel schema file elsewhere.
- **Never fails the whole import over one bad field.** Every routine/task/exercise that couldn't be
  used at all, or a field that got silently defaulted to something reasonable (an invalid `time`,
  an out-of-range `days` array, a missing `target`), is pushed onto a shared `notes` array rather
  than raising — a partially-generated AI response still imports whatever parts of it were valid.
  `parseAiImportText` only throws (`AiImportError`, carrying the full `issues`/`notes` list) if
  literally nothing survived validation — the JSON didn't parse, or the input wasn't a
  routine/array-of-routines/`{routines:[...]}` shape at all, or every routine in it was invalid.
  Accepts a bare routine object, a bare array of routines, or `{"routines": [...]}` without the
  caller needing to specify which, since it's genuinely unpredictable which of those an AI chat
  will produce even when the prompt asks for one specific shape.
- **Simple-routine title handling matches `RoutineForm`'s own "flat when simple" convention.** A
  single-task routine's task doesn't need its own `title` in the input JSON at all — `convertTask`
  reuses the routine's own title for it (`isSimple ? routineTitle : ...`), the same rule
  `RoutineForm.jsx` already applies when rendering a one-task routine flat.
- **Workout exercises resolve into the shared exercise repository for free, no special-casing
  needed.** A `convertExercise` result carries only a fresh per-task-instance `id`, no
  `exerciseId` — exactly the shape `upsertTask`'s existing `resolveExerciseIds` call already
  expects for a brand-new exercise (see "Exercise repository" above), so an AI-imported "Bench
  Press" resolves/merges into the repository, and any later PR/volume history, through the exact
  same path a manually-typed new exercise name would.
- **Settings UI** (`SettingsView.jsx`) adds a new "Import from AI" section below the existing
  "Recent local backups" list: a "Copy AI prompt" button (`navigator.clipboard.writeText`, a
  3-second "Prompt copied" confirmation matching the existing export/import status-message
  pattern), a plain paste `<textarea>`, and an "Import" button (disabled while empty or mid-import)
  that calls `parseAiImportText` and reports either a success count, a hard error
  (`.ai-import-error`, `white-space: pre-line` since `AiImportError.message` can be multiple
  newline-joined issues), or the soft-defaulted-field `notes` list (`.ai-import-notes`) alongside a
  success message — a successful import can still have notes if some fields were defaulted, not
  just on a hard failure.
- Verified via a Playwright round-trip in the browser dev loop (this project's standard
  verification method — see "Testing changes without an emulator" above): malformed JSON shows the
  parse-error message; a JSON payload with one valid simple routine, one valid multi-task workout
  routine, and one routine missing its required `title` imports the two valid ones (confirmed
  actually present in the Routines list after closing Settings, including opening the workout
  task's edit form and confirming its exercise resolved correctly) while surfacing a note
  explaining why the third was skipped.

### Design system

Single committed light theme (a warmer revision of the original "Soft Paper" look — warm
off-white, muted forest green, serif headers) defined as CSS custom properties in
`src/index.css`, consumed throughout `src/App.css`. No dark mode / no
`prefers-color-scheme` branching — this was a deliberate choice over the previous
system-following theme. Icons come from `lucide-react`, looked up per-routine via
`src/utils/icons.js`'s keyword-based `suggestIconId` (falls back to a generic icon) with a
manual override stored on the routine.

**Color tokens carry a specific meaning each, not just a palette:**
- `--accent`/`--good` (muted forest green, `#2f6b4f`) — the app's one primary/positive
  color: routine completion, active states, primary buttons.
- `--accent-chart` (`#1f8f5e`, more saturated than `--accent`) — reserved for chart marks
  (SVG lines/bars/areas) specifically. The muted UI-chrome green reads as "too gray" once
  it's a thin data line rather than a solid fill — confirmed by running the dataviz
  skill's categorical-palette validator against it, which flagged `--accent` as below its
  chroma floor for that use. UI chrome and chart marks are allowed to use two different
  shades of the same hue; nothing else should introduce a third.
- `--warn` (`#d9a23b`, gold) — "partial/in-progress," not a caution color. Reused for qty
  partial-fill bars, dashboard mid-tier completion bars, and `history-cell.partial` — gold
  rather than orange specifically so it doesn't compete with `--bad`'s red for "something's
  wrong" attention.
- `--bad` (`#d96c5f`, warm terracotta) — missed/below-threshold only.
- `--gold`/`--gold-soft`/`--gold-ink` — kept *distinct* from `--warn`'s gold, reserved
  specifically for streaks and PRs (the `Flame`-icon streak badge on Today/History items,
  the "current/longest streak" Dashboard tiles, the bodyweight-PR Fitness Stats tile). The
  point of splitting this from `--warn` is that "you're on a 12-day streak" and "this task
  is 60% done" are different kinds of message and shouldn't compete for the same hue.
- `--seq-1` through `--seq-5` — a sequential single-hue ramp (light to dark, derived from
  `--accent-chart`) for heatmap magnitude specifically. Kept separate from the
  status/categorical colors above since a ramp encodes *intensity*, not identity or state.

One CSS gotcha already hit twice: the fixed bottom tab bar (`.app-tabbar`) must have an
opaque `background` (currently the `Canvas` system color) — `background: inherit`
resolves to transparent here since `.app-shell` sets no background, which only becomes
visible once a scrollable view is taller than one screen.

Another one hit once: a flex item can't be forced circular with a fixed `width`+`height`
pair if it also has `flex: 1` inside a column — the flex algorithm's height distribution
can resolve to something other than the hardcoded height, while width stays fixed,
producing an oval. `aspect-ratio: 1 / 1` with `width: auto` (letting width derive from
whatever height flex settles on, bounded by `min-height`/`max-height`) is the fix — see
`.workout-ring-tap` in `App.css`, and its native-Compose equivalent
(`BoxWithConstraints`-based sizing in `MomentumRing`, `WorkoutSessionScreen.kt`) for the
same bug in the other implementation of the same screen.

**`-webkit-tap-highlight-color: transparent` is set app-wide** on the universal `*`
selector in `index.css`, not per-element — Android WebView's default blue/gray flash on
every tap reads as a rendering glitch once the app already has its own tap feedback
(button/list-item active states, the workout ring's own bounce animation), and a global
reset means no tappable surface added later needs to remember to opt out of it
individually. This replaced a narrower per-element rule that had only ever been added to
`.workout-ring-tap`, leaving every other tappable element in the app still showing the
native flash.

**App header version badge, and the wrapping bug it caused.** `App.jsx`'s header shows a tiny
`v{version}` badge (native-only, `App.getInfo()`, the same call `SettingsView.jsx` already made)
next to "Daily Routines" specifically so which build is installed is visible at a glance without
opening Settings — this is what let a user notice `latest-android-dev` had stopped updating (see
the CI branch-tracking bug in "Test app / product flavors" above). Adding it as a fifth flex
child to `.app-header` (logo, title, version badge, update-check button, settings button)
overflowed a real device's narrower width and wrapped the settings gear onto a second row. Fixed
by shrinking every header icon button (34px → 30px, glyphs scaled down to match), tightening the
title's font-size, and letting the title itself ellipsis-truncate (`overflow: hidden;
text-overflow: ellipsis; white-space: nowrap`) under real width pressure instead of wrapping —
verified down to 320px, this app's own declared `body { min-width: 320px }`. Fixing this also
surfaced a real, unrelated, already-present bug: `.app-logo-badge`'s size override
(`width/height: 34px`, now 30px) had never actually applied, because the generic `.icon-badge`
rule (38px) has identical selector specificity and happened to be declared later in `App.css` —
equal specificity means whichever rule is later in source order wins, regardless of which one
"looks" more specific to a reader. The logo badge had been rendering at 38px this whole time.
Fixed with a combined selector (`.icon-badge.app-logo-badge`, genuinely higher specificity)
instead of relying on source order, which is what any future override needs too if it can't
guarantee it'll always be declared after `.icon-badge` in the file.

**A real regression the `flex-wrap: nowrap` fix above caused, found from a real device
screenshot: the "Update ready to install" banner squeezed into the icon row and pushed the
settings gear off-screen instead of dropping to its own line.** `UpdateChecker`'s banner/toast
elements had always relied on `flex-basis: 100%` to force themselves onto a new flex line below
the header's icon buttons — a trick that only works when the parent flex container actually
allows wrapping. Setting `.app-header` to `flex-wrap: nowrap` (to stop the *icon row itself* from
wrapping the gear onto a second row under width pressure) silently defeated that for the banner
too, since there was never a design decision that the banner needed to survive nowrap — the two
features were never tested together. Fixed by fully decoupling the two: `App.jsx`'s header is now
a plain block wrapping two independent pieces — `.app-header-row` (a nowrap flex row: logo,
title, version badge, the round update-check button, the settings gear — exactly what "App header
version badge" above already fixed) and, as a separate full-width block below it, `UpdateStatusBar`
(the banner/toast/error states). Since the banner is no longer a flex sibling of the icon buttons
at all, it never has to fight for room in that row again, and the icon row itself is untouched by
whatever the banner is doing. This required lifting `UpdateChecker.jsx`'s state out into its own
hook (`src/hooks/useUpdateChecker.js`) so `App.jsx` can hold one instance and feed two small,
purely presentational components from it — the default-exported `UpdateChecker` (just the round
icon button, rendered inside `.app-header-row`) and the named `UpdateStatusBar` export (the
banner/toast area, rendered below it) — rather than one component owning both pieces of markup
and being unable to place them in two different layout contexts. Verified with a static HTML
fixture (loading the real compiled `App.css`) confirming the settings gear's bounding box stays
fully within a 360px viewport with the banner showing, and that the banner renders strictly below
the icon row rather than overlapping/squeezing into it.

### Analytics 2 (`src/utils/analyticsV2.js`, `src/components/AnalyticsV2View.jsx`)

A second, additive analytics tab (bottom nav, 5th icon) sitting entirely alongside the original
Dashboard tab — nothing about that tab's behavior, data, or code changed. Modeled after a much
richer analytics mockup the user supplied; built in three explicitly-scoped phases (1-3), with
phases 4-5 documented here as the concrete plan for later rather than built now.

**Why a second tab, not a redesign of the first.** The original Dashboard (`DashboardView.jsx`)
stays the simple, fast, already-shipped screen it always was. Analytics 2 is where every new,
heavier idea (custom date ranges, on-time tracking, workout categorization, per-routine
drill-downs) lives, so the two can evolve independently and a Dashboard regression is never a
side effect of an Analytics 2 change, or vice versa.

**Scope decision (explicit product call, not a default):** Phase 1-3 shipped now. Calories and
heart-rate fields (present in the original mockup for Running/HIIT cards) were deliberately never
built — there's no wearable integration or bodyweight-profile data source behind either one, so
adding bare manual-entry fields with no computed insight behind them was judged not worth it.
Workout "category" (Strength/Bodyweight/Stretch & Mobility/Yoga/Running/HIIT) is *inferred*, not
manually declared up front — but genuinely editable/overwritable, and lives on the shared
**exercise repository** row (`storage.js`'s `resolveExerciseId`), not per-task-instance — the same
real-world exercise (e.g. "Bench Press") should classify identically everywhere it's reused across
routines, exactly like `exerciseId` itself already unifies PR/volume history cross-routine (see
"Exercise repository" above).

**Phase 1 — reshape existing data, no schema changes.** The Overview screen (completion ring,
streak tiles, weekly trend, top routines list, Habit Heatmap, Progress vs Goal, a custom date
range picker) and the Routine/Workout detail drill-downs are all built from data the app already
had — `getDashboardStats` (analytics.js, unchanged) plus a handful of new small aggregators in
`analyticsV2.js` (`getPeriodTotals` for "Routines completed X/Y", `getRoutineDayOfWeekBreakdown`
scoped to one routine instead of all of them, `getTaskAverageValue`, `getTaskHeatmapSeries`,
`getRoutineTrendSeries`). `analytics.js` itself only gained purely additive support: a
`'calendarMonth'` range id (1st-of-month through today — genuinely distinct from the pre-existing
`'month'`, which was already a rolling 30-day window the whole time, just relabeled "Last 30 Days"
for this tab) and `{ id: 'custom', start: 'YYYY-MM-DD' }` range objects, both handled by extending
`rangeStartDate`/`buildTrend`'s existing dispatch rather than new code paths — every pre-existing
call site with a plain string range id behaves byte-for-byte identically to before.
- **A custom range only ever has a start date, always running through today — not an arbitrary
  `[start, end]` window.** This is deliberate: `getOverallConsistency`/`getLongestOverallStreak`
  (called inside `getDashboardStats`) always anchor their own lookback at the real "now"
  (`utils/date.js`'s `lastNDates`), so a custom range ending in the past would silently compute
  those two stats over the wrong days. Restricting to "custom start, through today" sidesteps
  that mismatch entirely while still covering the actual ask ("show me since this date").
  `getCompletionRateDelta` (the Overview's "+9% vs previous period") deliberately does **not**
  reuse `getDashboardStats` for its "previous period" side, for the same reason in reverse — it
  needs an arbitrary window that legitimately ends in the past, so it's a self-contained
  computation using only `getRoutineFraction` directly, untouched by the consistency/streak
  lookback issue.

**Phase 2 — on-time tracking.** `completions.updated_at` had been written to SQLite on every
completion since the very first version of the completions table, but `storage.js`'s
`getCompletions()` only ever `SELECT`ed `value`, silently discarding it — nothing downstream had
ever needed a completion *timestamp*, only *that day's value*. `getCompletionTimestamps()` is a
new, parallel `{ [taskId]: { [date]: isoString } }` map (loaded once in `App.jsx`'s `refreshAll`,
same "load once, pass down" shape as `taskVersionsMap`/`reschedulesMap`) — deliberately **not**
folded into `getCompletions()`'s existing `{ [taskId]: { [date]: value } }` shape, so every
pre-existing consumer of `completions` (TodayView, HistoryView, notifications.js, the entire
`analytics.js` pipeline) stays completely untouched; only Analytics 2 reads it.
- **Every lightweight completion handler in `App.jsx` (`handleToggleComplete`,
  `handleAddQuantity`, `handleSetQuantity`, `handleLogWorkoutSet`) now also refreshes
  `completionTimestamps` after writing** — these handlers patch `completions` directly rather
  than calling the full `refreshAll()` (a deliberate performance choice from before this feature
  existed), so without this, on-time-rate would show stale data until the next full reload.
- **Quantity-task caveat, accepted for v1 rather than solved:** `getTaskOnTimeRate`
  (`analyticsV2.js`) compares a completed day's captured timestamp against that day's effective
  `time` (due-by). For a quantity task logged incrementally (e.g. several quick-adds across the
  day), `updated_at` only ever reflects the *last* write to that day's single completions row,
  not when the target was first crossed — a reasonable but imprecise proxy, not exact the way it
  is for a boolean task. A real fix would need a second, immutable `first_completed_at` column;
  not worth the schema churn unless this proxy turns out to be actively misleading in practice.
  Days with no captured timestamp at all (data logged before this feature existed) are excluded
  from both the numerator and denominator, not counted as late.

**Phase 3 — exercise categorization + focus-area tagging.** Two new, independent per-exercise
concepts:
- **`category`** (`DB_VERSION = 11`, one nullable `TEXT` column added to the `exercises`
  repository table, self-heal-guarded by `ensureExerciseCategoryColumn` the same way every prior
  migration since `DB_VERSION = 8`'s real partial-apply bug has been) — one of
  `strength`/`bodyweight`/`stretch_mobility`/`yoga`/`running`/`hiit`
  (`utils/exerciseCategory.js`'s `EXERCISE_CATEGORIES`; the last two exist purely so a user can
  start tagging runs/HIIT sessions now, ahead of Phase 4's dedicated screens ever landing).
  `inferExerciseCategory(exercise)` is a deliberately simple best-effort default from only
  `type`/`unit` (weights+reps → strength, calisthenics+reps → bodyweight, any duration exercise →
  `stretch_mobility` as the more common case) — it never tries to guess Yoga vs. Stretch &
  Mobility, Running, or HIIT, since there's no real signal for any of those yet.
  - **Resolution and override semantics live in `storage.js`'s `resolveExerciseId`/
    `resolveExerciseIds`, mirroring the existing `exerciseId` resolution flow exactly.** A
    brand-new repository row gets seeded with the inferred category (or an explicit
    `categoryOverride`, if the RoutineForm dropdown was touched). An *existing* row's category is
    **only ever updated when `categoryOverride` is explicitly present** — a plain resave with no
    override touches nothing, so one task reusing "Bench Press" without ever opening its Category
    dropdown can't silently clobber a category some other task's save (or the user directly)
    already set. `categoryOverride` is a write-only instruction on the task-instance exercise
    object (never read back — `makeExercise()`'s own comment explains why), not a persisted field
    itself.
  - **Editor UI**: a `Category` `<select>` in `RoutineForm.jsx`'s `ExerciseListEditor`, positioned
    right after the Weights/Calisthenics toggle. Its displayed value is computed fresh on every
    render (`displayCategoryFor`): `categoryOverride` (if set this session) → the repository's own
    current category (looked up in the already-loaded `exerciseNames`, now extended to include
    `category` alongside `id`/`name`) → the inferred default — never a value read back from
    `categoryOverride` itself, since that field is write-only.
- **`focusArea`** — a plain, free-text, per-task-instance field (`task.exercises[].focusArea`, no
  schema change needed, same as `supersetGroupId`) shown only for duration-unit exercises
  ("Hamstrings", "Balance", anything — not a fixed enum). Powers `getFocusAreaBreakdown(task,
  logsForTask)`'s "Top Areas"/"Top Focus Areas" list: total logged duration grouped by tag,
  descending, with untagged-but-logged time grouped under "Untagged" rather than dropped. **A
  real bug caught by testing an actual logged session, not by inspection**: the first version
  assumed `logsForTask` (i.e. `workoutLogsByTask[task.id]`) was a flat `{ [exerciseId]: [sets] }`
  map; it's actually date-first (`{ [date]: { [exerciseId]: [sets] } }`,
  `storage.js`'s `getAllWorkoutLogs`), the same shape `utils/workouts.js`'s `getWorkoutStats`
  already has to flatten across dates for the exact same reason — fixed by flattening the same
  way (`Object.values(logsByDate).flatMap(...)`), caught when "Top Areas" silently rendered empty
  for an exercise that had genuinely just been logged in a live Playwright round-trip.
- **AI import** — `aiImport.js`'s `convertExercise` accepts an optional `category` (validated
  against the same `EXERCISE_CATEGORIES` enum, becoming `categoryOverride`) and free-text
  `focusArea`, both passed straight through `resolveSupersetGroups`'s final field-list rebuild
  (which had to be told about them explicitly — it reconstructs each exercise as a fixed field
  list, not a spread, so a new field silently drops out unless added there too).

**Workout Detail's per-category treatment**, reached by tapping a workout task from a Routine
Detail's Tasks sub-tab: `getTaskDominantCategory(task, exerciseCategoryById)` picks whichever
category is most common among the task's own exercises (ties break toward whichever was seen
first — not worth a more elaborate rule for a 2-exercise tie), and that decides the Overview
sub-tab's headline stat (total volume for `strength`, total reps otherwise, total time for
`stretch_mobility`/`yoga`) and whether "Top Areas" renders at all (duration categories only). The
Exercises/Progress sub-tabs reuse `utils/workouts.js`'s existing `getWorkoutStats` output
completely unchanged — category never affects per-exercise PR/volume/trend computation, only
which aggregate/label the screen chooses to lead with.

**Not built (Phase 4 — Cardio + HIIT, the largest remaining piece).** Running/cardio has no data
model at all today — no distance field, no pace, no dedicated logging UI. It would need a new
exercise unit mode (`unit: 'distance'`, a `targetDistanceMeters`), and genuinely new session
logging screens on both `WorkoutSessionView.jsx` and `WorkoutSessionScreen.kt` (mirroring the
scope of the original `DurationTimer` work, not a small addition). HIIT's "round completion
status" (Completed/Partial/Incomplete, not just done/not-done) would need a real change to the
logged-set model — today a set's `completed` is a plain boolean; a tri-state `status` field
touches both session screens' core logging loop. Both are real, scoped-but-substantial follow-up
work, not started.

**Not built (Phase 5 — Health Score, full insights engine, Routine Journal).** A composite
0-100 "Health Score" (Consistency + On-time Rate + Momentum + Sustainability, each already
computable or nearly so once Phase 2 landed) needs explicit formula sign-off before building —
particularly "Momentum" (this-window vs. previous-window delta, `getCompletionRateDelta` already
computes the raw ingredient) and "Sustainability" (no formula decided; a volatility-based measure
like `100 - stddev(daily %)` was the working idea, unconfirmed). A rules-based insights engine
("Schedule Adjustment," "Consistency Win," "Task Impact," "Best Performance Window," "Reduce
Routine Overload," "Target Suggestion," ...) is genuinely a small extensible module — each rule a
`(routineData) => Insight | null` function — not one function, and every rule shown in the
original mockup needs its own short design pass, not just a generic "correlate X with Y." Routine
Journal (free-text, *dated* notes per routine — distinct from the existing single static
`routine.notes` field) needs one new small unversioned table (`routine_journal_entries`: id,
routine_id, date, text, created_at) and plain CRUD; no design ambiguity, just not built yet.

### A recurring ESLint false-positive

`no-unused-vars` sometimes misfires on a destructured capitalized variable used only as a
JSX tag (e.g. `const { Icon } = someObject; ... <Icon />`) inside certain callback shapes.
The fix used throughout this codebase is to access it as a member expression instead
(`<option.Icon />` or `<props.Icon />`) rather than destructuring the bare identifier —
see `RoutineForm.jsx` and `HistoryView.jsx` for the pattern.
