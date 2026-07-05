/**
 * Drives the real debug APK on a GitHub Actions Android emulator (see
 * .github/workflows/android-emulator-verify.yml) to prove the native extra-reminder path
 * (android/app/.../notify/ExtraReminderScheduler.kt + ExtraReminderAlarmReceiver.kt +
 * ExtraReminderActionReceiver.kt, fronted by NativeNotificationsPlugin.scheduleExtraReminder)
 * actually behaves as designed on a real device, mirroring verify-due-reminder.mjs for the
 * sibling native notification introduced in the same migration (see CLAUDE.md's "Native
 * notifications" section).
 *
 * This does NOT use `adb shell am broadcast -n <receiver>` to fake the alarm/action firing -
 * an earlier version did, and it failed identically across many real-device runs even with
 * `--include-stopped-packages` and with `am force-stop` removed entirely from the workflow
 * between scripts. A temporary Log.i() placed directly inside
 * ExtraReminderAlarmReceiver.onReceive() proved the receiver's code never ran at all - `adb
 * shell am broadcast -n` simply does not reach this app's manifest-declared receivers on this
 * emulator image, for reasons that were never fully root-caused (dumpsys activity broadcasts
 * reported the intent as "Skipped (manifest)" every time, with an unexplained
 * flg=0x400030 - both FLAG_INCLUDE_STOPPED_PACKAGES and FLAG_EXCLUDE_STOPPED_PACKAGES bits set
 * simultaneously). A control broadcast to the unrelated, much simpler
 * BackgroundSyncActionReceiver failed identically, confirming this wasn't specific to extra
 * reminders.
 *
 * Instead, this script exercises the real underlying Android mechanisms directly, the same
 * ones the shipped feature actually depends on in production, with no synthetic broadcast
 * anywhere:
 *   - The alarm fire itself: schedule an extra reminder a few minutes in the future, then
 *     advance the emulator's system clock past that time with `adb shell date` (root is
 *     available on non-Play-Store `google_apis` system images). Android's real AlarmManager
 *     re-evaluates pending alarms on `ACTION_TIME_CHANGED` and fires the genuine
 *     `PendingIntent` - this is a real end-to-end test of arm()/armAt(), not a shortcut around
 *     it, and sidesteps the broadcast-delivery mystery entirely since nothing here sends an
 *     ad-hoc `am broadcast`.
 *   - The Snooze/Mark-done actions: real `uiautomator` taps on the actual notification action
 *     buttons (the same technique verify-due-reminder.mjs already uses for its swipe-dismiss
 *     check, safe here since this notification has no chronometer-driven ticking text - see
 *     CLAUDE.md). Tapping a real notification action button routes through the OS's own
 *     PendingIntent-delivery path, which the app that posted the notification always receives
 *     regardless of any adb-broadcast quirk, since it's a completely different code path from
 *     `ActivityManagerService.broadcastIntent()`.
 *
 * The app-generated task id (crypto.randomUUID(), see CLAUDE.md) - needed to query completions
 * afterward - is read directly off the app's real SQLite connection via
 * `window.Capacitor.Plugins.CapacitorSQLite.query(...)`, the exact same native plugin call
 * storage.js's own db.js wraps. This is a page-JS-side read through the app's already-open
 * connection, not a second SQLite driver opening the file.
 */
import { execSync } from 'node:child_process';

const PACKAGE = 'com.tharuka.routines';
const CHANNEL_ID = 'routine-reminders';
const TASK_TITLE = 'Emulator Extra Reminder Test';

function adb(cmd) {
  return execSync(`adb ${cmd}`, { encoding: 'utf8' });
}

function adbAllowFailure(cmd) {
  try {
    return execSync(`adb ${cmd}`, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function findDevtoolsSocket() {
  const out = adb(`shell cat /proc/net/unix`);
  const line = out.split('\n').find((l) => l.includes('devtools_remote'));
  if (!line) return null;
  const match = line.match(/@?(\S*devtools_remote\S*)/);
  return match ? match[1].replace(/^@/, '') : null;
}

function dumpNotifications() {
  return adb(`shell dumpsys notification --noredact`);
}

/**
 * A full `dumpsys notification` includes every app on the device's channels/records (hundreds of
 * KB) - printing that wholesale on a failure both drowns out the one signal that actually matters
 * and risks blowing past CI log/tool size limits. This prints only this package's own record
 * blocks plus a full logcat capture (cleared right before the alarm-triggering clock jump, see
 * main()) filtered to this package, so a future failure is actually diagnosable from the CI log
 * alone without hunting through unrelated system noise.
 */
function dumpOwnPackageForDebugging() {
  const dump = dumpNotifications();
  const blocks = dump.split('NotificationRecord(').slice(1).filter((b) => b.includes(`pkg=${PACKAGE}`));
  const notificationSection =
    blocks.length === 0
      ? `(no NotificationRecord blocks found for ${PACKAGE})`
      : blocks.map((b) => 'NotificationRecord(' + b.split('\n\n')[0]).join('\n---\n');
  const logcat = adbAllowFailure(`shell logcat -d`)
    .split('\n')
    .filter((l) => l.includes(PACKAGE) || l.includes('FATAL EXCEPTION') || l.includes('AndroidRuntime'))
    .join('\n');
  return `--- ${PACKAGE}'s own notification records ---\n${notificationSection}\n--- logcat since last clear mentioning ${PACKAGE} ---\n${logcat || '(nothing matched)'}`;
}

function findAppRecords(dump) {
  const blocks = dump.split('NotificationRecord(').slice(1);
  return blocks
    .filter((b) => b.includes(`pkg=${PACKAGE}`))
    .map((b) => {
      const flagsMatch = b.match(/flags=0x([0-9a-fA-F]+)/);
      const channelMatch =
        b.match(/\bchannel=([^\s,)]+)/) || b.match(/channelId=([^\s,)]+)/) || b.match(/mChannelId=([^\s,)]+)/);
      const titleMatch = b.match(/android\.title=String \(([^)]*)\)/);
      const textMatch = b.match(/android\.text=String \(([^)]*)\)/);
      const flags = flagsMatch ? parseInt(flagsMatch[1], 16) : 0;
      return {
        raw: b.slice(0, 800),
        flags,
        ongoing: Boolean(flags & 0x2),
        channel: channelMatch?.[1],
        title: titleMatch?.[1],
        text: textMatch?.[1],
      };
    });
}

function getScreenSize() {
  const out = adb(`shell wm size`);
  const match = out.match(/(?:Override|Physical) size: (\d+)x(\d+)/);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** See verify-due-reminder.mjs's identical helper - safe here for the same reason (no chronometer-driven ticking text on this notification). */
function uiDump() {
  for (let attempt = 0; attempt < 5; attempt++) {
    adbAllowFailure(`shell rm -f /sdcard/window_dump.xml`);
    adbAllowFailure(`shell uiautomator dump /sdcard/window_dump.xml`);
    const out = adbAllowFailure(`shell cat /sdcard/window_dump.xml`);
    if (out && out.includes('<hierarchy')) return out;
    execSync('sleep 1');
  }
  return '';
}

/** Compose/View text can surface via content-desc instead of text - search both, loosely. */
function findNodeByLooseText(xml, text) {
  const nodes = xml.match(/<node\b[^>]*\/>/g) || [];
  for (const node of nodes) {
    const textMatch = node.match(/\btext="([^"]*)"/);
    const descMatch = node.match(/\bcontent-desc="([^"]*)"/);
    if ((textMatch && textMatch[1].includes(text)) || (descMatch && descMatch[1].includes(text))) {
      const boundsMatch = node.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (boundsMatch) {
        const [x1, y1, x2, y2] = boundsMatch.slice(1).map(Number);
        return { x1, y1, x2, y2 };
      }
    }
  }
  return null;
}

function tapNodeCenter(bounds) {
  const x = Math.floor((bounds.x1 + bounds.x2) / 2);
  const y = Math.floor((bounds.y1 + bounds.y2) / 2);
  adb(`shell input tap ${x} ${y}`);
}

/** Taps a notification action button by its visible label, expanding/collapsing the shade around it. */
function tapNotificationAction(label) {
  adb(`shell cmd statusbar expand-notifications`);
  execSync('sleep 1');
  const xml = uiDump();
  if (!xml) {
    adbAllowFailure(`shell cmd statusbar collapse`);
    fail(`uiautomator dump did not produce a UI tree while looking for the "${label}" action.`);
  }
  const bounds = findNodeByLooseText(xml, label);
  if (!bounds) {
    adbAllowFailure(`shell cmd statusbar collapse`);
    fail(`Could not find a "${label}" action button in the notification shade.`);
  }
  tapNodeCenter(bounds);
  execSync('sleep 1'); // let the tap's PendingIntent dispatch before we collapse the shade
  adbAllowFailure(`shell cmd statusbar collapse`);
}

const pad = (n) => String(n).padStart(2, '0');

/** Reads the emulator's own wall-clock fields directly, rather than the CI runner's - the two are not guaranteed to agree, and every alarm-scheduling decision (arm()'s day-of-week math, computeNextOccurrenceDaysFromNow) is keyed off the device's own clock. */
function deviceDateTimeFields() {
  const out = adb(`shell date +"%m %d %Y %H %M %S %w"`).trim();
  const [month, day, year, hour, minute, second, weekday] = out.split(/\s+/).map(Number);
  return { month, day, year, hour, minute, second, weekday };
}

/** Adds minutes to a device-time fields object, handling hour/day rollover (not month/year - acceptable here since this only ever advances a few minutes at a time, matching the level of care already accepted elsewhere in these scripts for similar day-boundary edge cases). */
function addMinutes(fields, deltaMinutes) {
  let totalMinutes = fields.hour * 60 + fields.minute + deltaMinutes;
  const dayOverflow = Math.floor(totalMinutes / (24 * 60));
  totalMinutes = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  return {
    ...fields,
    hour: Math.floor(totalMinutes / 60),
    minute: totalMinutes % 60,
    day: fields.day + dayOverflow,
    weekday: (fields.weekday + dayOverflow + 7) % 7,
  };
}

/** Sets the emulator's system clock via toybox date's classic positional SET format (MMDDhhmm[[CC]YY][.ss]) - requires root, which non-Play-Store `google_apis` emulator images grant to the adb shell by default. Setting the clock fires ACTION_TIME_CHANGED, which AlarmManager listens for to re-evaluate and fire any now-overdue alarms - this is what lets the real (not synthetic) extra-reminder alarm fire on demand in CI. */
function setDeviceTime(fields) {
  const value = `${pad(fields.month)}${pad(fields.day)}${pad(fields.hour)}${pad(fields.minute)}${fields.year}.${pad(fields.second)}`;
  adb(`shell date ${value}`);
}

class CdpPage {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        console.log(`[app console.${msg.params.type}]`, args);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        console.log('[app exception]', JSON.stringify(msg.params.exceptionDetails));
      }
    });
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('WebSocket error: ' + JSON.stringify(e))));
    });
    await this.send('Runtime.enable');
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error('Page evaluation error: ' + JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

const JS_HELPERS = `
  window.__test = {
    ready: (sel) => !!document.querySelector(sel),
    clickByText: (sel, text) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text));
      if (!el) return false;
      el.click();
      return true;
    },
    setValue: (sel, value, nth) => {
      const el = [...document.querySelectorAll(sel)][nth || 0];
      if (!el) return false;
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    dayChipSelected: (label) => {
      const el = [...document.querySelectorAll('.routine-form .day-buttons .day-chip')]
        .find((e) => e.textContent.trim() === label);
      return el ? el.className.includes('selected') : null;
    },
    clickDayChip: (label) => {
      const el = [...document.querySelectorAll('.routine-form .day-buttons .day-chip')]
        .find((e) => e.textContent.trim() === label);
      if (!el) return false;
      el.click();
      return true;
    },
    queryTaskId: async (title) => {
      const res = await window.Capacitor.Plugins.CapacitorSQLite.query({
        database: 'routines',
        statement: 'SELECT id FROM tasks WHERE title = ? AND deleted = 0',
        values: [title],
      });
      return res.values && res.values[0] ? res.values[0].id : null;
    },
    queryCompletion: async (taskId, dateKey) => {
      const res = await window.Capacitor.Plugins.CapacitorSQLite.query({
        database: 'routines',
        statement: 'SELECT value FROM completions WHERE task_id = ? AND date = ?',
        values: [taskId, dateKey],
      });
      return res.values && res.values[0] ? res.values[0].value : null;
    },
  };
  true;
`;

async function waitFor(page, jsCondition, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(jsCondition)) return true;
    await sleep(300);
  }
  return false;
}

async function pollFor(fn, predicate, timeoutMs = 20000, intervalMs = 500) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function main() {
  console.log('Waiting for app to boot...');
  for (let i = 0; i < 30; i++) {
    const pid = adbAllowFailure(`shell pidof ${PACKAGE}`).trim();
    if (pid) break;
    await sleep(1000);
  }
  await sleep(4000); // let the WebView + JS bundle finish loading

  const socket = findDevtoolsSocket();
  if (!socket) fail("Could not find a WebView devtools socket - is the debug build's WebView debugging enabled?");
  console.log('Found devtools socket:', socket);
  adb(`forward tcp:9222 localabstract:${socket}`);

  const listRes = await fetch('http://localhost:9222/json');
  const targets = await listRes.json();
  const target = targets.find((t) => t.type === 'page') || targets[0];
  if (!target) fail('No page target found via CDP /json listing.');
  console.log('Connecting to page target:', target.url);

  const page = new CdpPage(target.webSocketDebuggerUrl);
  await page.connect();
  await page.evaluate(JS_HELPERS);

  const appReady = await waitFor(page, `window.__test.ready('.app-tabbar')`);
  if (!appReady) fail('App did not render .app-tabbar in time.');
  console.log('Connected to app WebView.');

  async function mustEval(expression, description) {
    const ok = await page.evaluate(expression);
    if (!ok) fail(`UI step failed: ${description} (expression returned ${JSON.stringify(ok)})`);
    return ok;
  }

  const todayKey = adb(`shell date +%Y-%m-%d`).trim();
  const baseline = deviceDateTimeFields();
  // A few minutes out is enough buffer for the UI flow below (routine creation, native
  // scheduling) to finish in real time before we jump the clock forward to meet it.
  const reminderTarget = addMinutes(baseline, 3);
  const reminderTimeStr = `${pad(reminderTarget.hour)}:${pad(reminderTarget.minute)}`;
  const labelOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const targetLabel = labelOrder[baseline.weekday];
  console.log(`Device time is ${pad(baseline.hour)}:${pad(baseline.minute)} (weekday ${targetLabel}). Extra reminder will be set for ${reminderTimeStr} today.`);

  console.log('Creating a task with an extra reminder time...');
  await mustEval(`window.__test.clickByText('.app-tabbar button', 'Routines')`, 'click Routines tab');
  await sleep(300);
  await mustEval(`window.__test.clickByText('button', '+ Add routine')`, 'click + Add routine');
  await sleep(300);
  await mustEval(
    `window.__test.setValue('.routine-form input[placeholder="e.g. Morning stretch"]', ${JSON.stringify(TASK_TITLE)})`,
    'set routine title'
  );
  // Due by (index 1, after "Starts at" at index 0) is set late in the day so the due-by
  // reminder's own overdue-today catch-up (see verify-due-reminder.mjs) doesn't also fire and
  // complicate this script's assertions - this script only cares about the extra reminder.
  await mustEval(`window.__test.setValue('.routine-form input[type="time"]', '23:55', 1)`, 'set due time to 23:55');
  // The reminder-row's own time input is the 3rd type="time" input on the page (index 2, after
  // "Starts at"/"Due by").
  await mustEval(
    `window.__test.setValue('.routine-form input[type="time"]', ${JSON.stringify(reminderTimeStr)}, 2)`,
    'set extra reminder time'
  );
  await mustEval(`window.__test.clickByText('button', '+ Add reminder')`, 'click + Add reminder');
  await sleep(200);

  const selected = await page.evaluate(`window.__test.dayChipSelected(${JSON.stringify(targetLabel)})`);
  if (selected === null) fail(`Could not find day chip for ${targetLabel}`);
  if (!selected) {
    await mustEval(`window.__test.clickDayChip(${JSON.stringify(targetLabel)})`, `select ${targetLabel} day chip`);
  }

  await mustEval(`window.__test.clickByText('button[type="submit"]', 'Add routine')`, 'submit Add routine');
  const routineSaved = await waitFor(page, `document.body.innerText.includes(${JSON.stringify(TASK_TITLE)})`, 10000);
  console.log('Routine visible in list after save:', routineSaved);
  if (!routineSaved) fail('Routine was not created within 10s of submitting - form submission likely failed.');
  await sleep(1500); // let syncAllNotifications' native scheduleExtraReminder call land

  const taskId = await pollFor(
    () => page.evaluate(`window.__test.queryTaskId(${JSON.stringify(TASK_TITLE)})`),
    (id) => Boolean(id),
    10000
  );
  if (!taskId) fail('Could not find the created task\'s id via a direct SQLite query.');
  console.log('Resolved task id via SQLite query:', taskId);

  // --- Fire the alarm for real: jump the emulator's clock past the scheduled time and let
  // AlarmManager do its own thing, rather than faking a broadcast (see file header for why).
  console.log('Clearing logcat, then advancing the device clock to fire the real alarm...');
  adbAllowFailure(`shell logcat -c`);
  setDeviceTime({ ...reminderTarget, second: 10 });
  console.log('Device time is now:', adb(`shell date`).trim());

  const posted = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === CHANNEL_ID && r.title === TASK_TITLE && !r.ongoing),
    (r) => Boolean(r)
  );
  if (!posted) {
    console.log(dumpOwnPackageForDebugging());
    fail('No plain (non-ongoing) routine-reminders notification appeared after the clock reached the scheduled reminder time.');
  }
  console.log('Extra reminder notification posted:', { title: posted.title, text: posted.text, ongoing: posted.ongoing });
  if (!posted.raw.includes('Mark done') || !posted.raw.includes('Snooze 15m')) {
    fail(`Extra reminder notification is missing expected action titles. Raw record: ${posted.raw}`);
  }
  console.log('PASS: extra reminder fired via a real AlarmManager alarm with Mark-done/Snooze actions intact.');

  // --- Snooze: a real tap on the actual notification button.
  console.log('Tapping the real "Snooze 15m" notification action...');
  tapNotificationAction('Snooze 15m');
  const completionAfterSnooze = await page.evaluate(`window.__test.queryCompletion(${JSON.stringify(taskId)}, ${JSON.stringify(todayKey)})`);
  if (completionAfterSnooze !== null) {
    fail(`Snooze unexpectedly wrote a completion (value=${completionAfterSnooze}) - it should only re-arm the alarm, never touch completions.`);
  }
  console.log('PASS: Snooze re-armed without touching completions.');

  // --- Confirm the snooze's re-arm is real: jump the clock another 15 minutes and see it
  // actually reappear via a genuine AlarmManager fire, not just trust that armAt() was called.
  console.log('Advancing the device clock 15 more minutes to confirm the snoozed alarm actually re-fires...');
  const snoozeTarget = addMinutes(reminderTarget, 15);
  setDeviceTime({ ...snoozeTarget, second: 10 });
  console.log('Device time is now:', adb(`shell date`).trim());

  const repostedAfterSnooze = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === CHANNEL_ID && r.title === TASK_TITLE && !r.ongoing),
    (r) => Boolean(r)
  );
  if (!repostedAfterSnooze) {
    console.log(dumpOwnPackageForDebugging());
    fail('The snoozed extra reminder did not reappear 15 minutes later - the Snooze action\'s armAt() re-arm is broken.');
  }
  console.log('PASS: the snoozed extra reminder reappeared via a real alarm fire 15 minutes later.');

  // --- Mark done: another real tap, this time on "Mark done".
  console.log('Tapping the real "Mark done" notification action...');
  tapNotificationAction('Mark done');

  const completion = await pollFor(
    () => page.evaluate(`window.__test.queryCompletion(${JSON.stringify(taskId)}, ${JSON.stringify(todayKey)})`),
    (v) => v !== null,
    15000
  );
  if (completion === null) {
    console.log(dumpOwnPackageForDebugging());
    fail(
      'No completion row appeared for this task after tapping Mark-done - the ' +
        'ExtraReminderActionReceiver -> dispatchDueReminderAction -> DueReminderBridge -> JS ' +
        '"dueReminderAction" pipeline did not actually mark the task done.'
    );
  }
  console.log('PASS: Mark-done action dispatched through the native bridge and wrote a real completion.', { completion });

  const remaining = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.title === TASK_TITLE),
    (r) => !r,
    15000
  );
  if (remaining) {
    console.log(dumpOwnPackageForDebugging());
    fail(`A notification for ${TASK_TITLE} is still showing after Mark-done - dismissExtraRemindersToday did not clear it.`);
  }
  console.log('PASS: the extra reminder notification was cleared after marking the task done.');

  page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
