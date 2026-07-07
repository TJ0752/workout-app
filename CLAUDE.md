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
already used for the Reps/Duration toggle right below it). It exists purely to control **whether
the weight input is offered at all** during live logging, in both the web dev-loop companion
(`WorkoutSessionView.jsx`) and the native Compose companion (`WorkoutSessionScreen.kt`) — not to
reclassify anything after the fact; the analytics layer's own weighted-vs-bodyweight decision
(`utils/workouts.js`'s `isWeighted`, described above) stays exactly as it was, based on whether a
completed *set* ever had a weight, not this config field. Switching an exercise to
`'calisthenics'` forces `weight: null` on every set logged for it going forward (both
`markDone()`s), so a stray/stale value typed before the toggle existed can't silently leak into
newly-logged sets once the field is hidden.

**The exercise config itself has no `targetWeight` field at all** — it existed only as the final
fallback in the weight-prefill chain (`loggedSet?.weight ?? lastUsedWeight ?? targetWeight`)
before `getLastUsedWeight` (see below) existed, and was removed once that fallback became
redundant for every exercise with any logged history. The one real behavior change from removing
it: a brand-new exercise's very first-ever set now starts with an empty weight field instead of a
pre-set suggestion — a deliberate tradeoff the user chose over keeping a setup-time field whose
only other use was that single first session.

**No backfill/migration needed for exercises saved before this field existed.** `isCalisthenics`
(JS) / the `isWeighted` local (Kotlin) both treat anything other than an explicit `'calisthenics'`
— including a totally absent `type` — as weighted, which is exactly the old behavior (the weight
input always showed, unconditionally). `type` defaults to `'weights'` for brand-new exercises
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
  `EXTRA_REMINDER_ID_BASE + hashToInt("$taskId:$slot")`), `GROUP_SUMMARY_ID_BASE =
  700,000,000` (one id per routine via `GROUP_SUMMARY_ID_BASE + hashToInt(routineId)`),
  `MORNING_DIGEST_ID = 900,000,002`, `EVENING_DIGEST_ID = 900,000,003`, `STREAK_RISK_ID =
  900,000,004` (fixed, not hashed — only ever these 3 digest kinds), and
  `BACKGROUND_SYNC_NOTIFICATION_ID = 950,000,001` (also fixed — exactly one background-sync
  notification ever exists), and `APP_GROUP_SUMMARY_ID = 960,000,001` (`AppGroupSummary.kt`,
  also fixed — the one notification flagged `setGroupSummary(true)` for the whole app, see
  Part D).
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
- **Boot survival.** `DueReminderBootReceiver` (manifest, `directBootAware="true"`, listens
  for `BOOT_COMPLETED`/`LOCKED_BOOT_COMPLETED`/`QUICKBOOT_POWERON`, needs
  `RECEIVE_BOOT_COMPLETED` added explicitly since the stock plugin's own manifest contract
  shouldn't be load-bearing for a completely different notification type) re-arms every
  `DueReminderStore` entry on boot — `AlarmManager` alarms do **not** survive reboot on
  their own, confirmed by the stock plugin needing its own equivalent
  (`LocalNotificationRestoreReceiver`) for the exact same reason. `ExtraReminderBootReceiver`
  and `DailyDigestBootReceiver` (Parts C and E) mirror this exactly, one per store.

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
  passing `taskId`/`taskTitle`/`dateKey`/`exercises`/`logsForDate` as one JSON Intent extra
  (shape matches `task.exercises`/`workoutLogsByTask[taskId][dateKey]` exactly — no JS-side
  translation needed). Since `@ActivityCallback` only fires once (on Activity finish),
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
    - **A real race condition, found via a Playwright round-trip, not by inspection.** The web
      companion's `onLogSet` persists through `App.jsx`'s async SQLite write before
      `workoutLogsByTask` (and this component's `taskLogs` prop) updates — so advancing to the
      very next set immediately after logging one would compute `getLastUsedWeight` against
      *stale* props, prefilling the new set's weight field empty instead of with what was just
      lifted, until some *later* unrelated re-render happened to catch up (the initializing
      effect only reruns on `[exerciseIndex, setIndex]`, not when `taskLogs` eventually arrives).
      Fixed with a local `sessionLogs` mirror, seeded from the `logsForDate` prop once and
      updated synchronously inside `markDone()` itself — the exact same pattern
      `WorkoutSessionScreen.kt`'s own `logsByExercise` local state already used for this reason,
      which is why the native side never had this bug in the first place. `getLastUsedWeight` is
      called against `{...taskLogs, [dateKey]: sessionLogs}` (web) /
      `logsByDate + (dateKey to logsByExercise)` (native) — the static cross-session history
      merged with this session's own live edits — rather than either alone.
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
  exercise's own `type` field** (see "Exercise type" below) — `type` only controls whether
  the weight input is offered at all during setup/logging, not how already-logged sessions
  get classified after the fact.
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
in-app "Check for updates" button points at) only moves on pushes to `main`, while
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
