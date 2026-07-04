/**
 * Drives the real debug APK on a GitHub Actions Android emulator (see
 * .github/workflows/android-emulator-verify.yml) to prove the native extra-reminder path
 * (android/app/.../notify/ExtraReminderScheduler.kt + ExtraReminderAlarmReceiver.kt +
 * ExtraReminderActionReceiver.kt, fronted by NativeNotificationsPlugin.scheduleExtraReminder)
 * actually behaves as designed on a real device, mirroring verify-due-reminder.mjs for the
 * sibling native notification introduced in the same migration (see CLAUDE.md's "Native
 * notifications" section).
 *
 * Unlike the due-by reminder, extra reminders have no catch-up/overdue-today logic (they're
 * plain nudges leading up to the real due time, not the due moment itself - see
 * ExtraReminderScheduler's doc comment) - so this script can't rely on "schedule something a
 * few minutes in the past and expect an immediate post" the way verify-due-reminder.mjs does.
 * Instead it broadcasts directly to ExtraReminderAlarmReceiver/ExtraReminderActionReceiver -
 * exactly the technique verify-group-summary.mjs already uses for SummaryDismissReceiver - which
 * is deterministic and still exercises the real registered receivers, the real persisted
 * ExtraReminderStore entry, and the real notification-building/action-dispatch code, without
 * waiting on AlarmManager's own clock.
 *
 * The one piece this script needs that isn't visible anywhere in the DOM or dumpsys - the
 * app-generated task id (crypto.randomUUID(), see CLAUDE.md) - is read directly off the app's
 * real SQLite connection via `window.Capacitor.Plugins.CapacitorSQLite.query(...)`, the exact
 * same native plugin call storage.js's own db.js wraps (see DB_NAME='routines' in db.js). This
 * is a page-JS-side read through the app's already-open connection, not a second SQLite driver
 * opening the file - the same constraint that rules out this script (or any native code) opening
 * the DB file itself still applies; the point here is that it doesn't need to, because the CDP
 * bridge already gives this script full access to run JS inside the real app.
 */
import { execSync } from 'node:child_process';

const PACKAGE = 'com.tharuka.routines';
const CHANNEL_ID = 'routine-reminders';
const TASK_TITLE = 'Emulator Extra Reminder Test';
const ALARM_RECEIVER = `${PACKAGE}/com.tharuka.routines.notify.ExtraReminderAlarmReceiver`;
const ACTION_RECEIVER = `${PACKAGE}/com.tharuka.routines.notify.ExtraReminderActionReceiver`;
const ACTION_MARK_DONE = 'com.tharuka.routines.notify.action.MARK_DONE';
const ACTION_SNOOZE = 'com.tharuka.routines.notify.action.SNOOZE';

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

async function pollFor(fn, predicate, timeoutMs = 10000, intervalMs = 500) {
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

  const weekday = Number(adb(`shell date +%w`).trim());
  const todayKey = adb(`shell date +%Y-%m-%d`).trim();
  const labelOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const targetLabel = labelOrder[weekday];

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
  await mustEval(
    `window.__test.setValue('.routine-form input[type="time"]', '23:55', 1)`,
    'set due time to 23:55'
  );
  // The reminder-row's own time input is the 3rd type="time" input on the page (index 2, after
  // "Starts at"/"Due by") - value itself doesn't matter since this script fires the alarm
  // receiver directly rather than waiting on AlarmManager (see file header).
  await mustEval(`window.__test.setValue('.routine-form input[type="time"]', '09:00', 2)`, 'set extra reminder draft time');
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

  console.log('Broadcasting directly to ExtraReminderAlarmReceiver (slot 0) to fire the alarm...');
  adb(`shell am broadcast -n ${ALARM_RECEIVER} --es taskId "${taskId}" --ei slot 0`);

  const posted = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === CHANNEL_ID && r.title === TASK_TITLE && !r.ongoing),
    (r) => Boolean(r),
    10000
  );
  if (!posted) {
    console.log(dumpNotifications());
    fail('No plain (non-ongoing) routine-reminders notification appeared after broadcasting to ExtraReminderAlarmReceiver.');
  }
  console.log('Extra reminder notification posted:', { title: posted.title, text: posted.text, ongoing: posted.ongoing });
  if (!posted.raw.includes('Mark done') || !posted.raw.includes('Snooze 15m')) {
    fail(`Extra reminder notification is missing expected action titles. Raw record: ${posted.raw}`);
  }
  console.log('PASS: extra reminder fired via the native alarm receiver with Mark-done/Snooze actions intact.');

  console.log('Broadcasting a Snooze action for slot 0...');
  adb(`shell am broadcast -n ${ACTION_RECEIVER} -a ${ACTION_SNOOZE} --es taskId "${taskId}" --ei slot 0`);
  await sleep(1000);
  const completionAfterSnooze = await page.evaluate(`window.__test.queryCompletion(${JSON.stringify(taskId)}, ${JSON.stringify(todayKey)})`);
  if (completionAfterSnooze !== null) {
    fail(`Snooze unexpectedly wrote a completion (value=${completionAfterSnooze}) - it should only re-arm the alarm, never touch completions.`);
  }
  console.log('PASS: Snooze re-armed without touching completions.');

  console.log('Broadcasting a Mark-done action for slot 0...');
  adb(`shell am broadcast -n ${ACTION_RECEIVER} -a ${ACTION_MARK_DONE} --es taskId "${taskId}" --ei slot 0`);

  const completion = await pollFor(
    () => page.evaluate(`window.__test.queryCompletion(${JSON.stringify(taskId)}, ${JSON.stringify(todayKey)})`),
    (v) => v !== null,
    10000
  );
  if (completion === null) {
    fail(
      'No completion row appeared for this task after broadcasting Mark-done - the ' +
        'ExtraReminderActionReceiver -> dispatchDueReminderAction -> DueReminderBridge -> JS ' +
        '"dueReminderAction" pipeline did not actually mark the task done.'
    );
  }
  console.log('PASS: Mark-done action dispatched through the native bridge and wrote a real completion.', { completion });

  const remaining = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.title === TASK_TITLE),
    (r) => !r,
    10000
  );
  if (remaining) {
    fail(`A notification for ${TASK_TITLE} is still showing after Mark-done - dismissExtraRemindersToday did not clear it.`);
  }
  console.log('PASS: the extra reminder notification was cleared after marking the task done.');

  page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
