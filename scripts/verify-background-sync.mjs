/**
 * Drives the real debug APK on a GitHub Actions Android emulator (see
 * .github/workflows/android-emulator-verify.yml) to prove the persistent background-sync
 * foreground service (android/app/.../notify/BackgroundSyncService.kt +
 * BackgroundSyncBridge.kt, started from NativeNotificationsPlugin.load()) actually keeps
 * notification content fresh without the app being reopened, and that its "Stop" action works -
 * see CLAUDE.md's "Native notifications" section for the full design.
 *
 * The real tick interval is 15 minutes, far too long to wait for in CI - this uses
 * `NativeNotifications.triggerBackgroundSyncTick()`, a plugin method that exists purely for this
 * script, calling `BackgroundSyncBridge.onTick` directly instead of waiting on the service's own
 * `Handler.postDelayed` loop.
 *
 * To prove the tick genuinely re-syncs content rather than just observing a change that would
 * have happened anyway (every completion-changing UI action already re-syncs notifications on
 * its own, via the same syncAllNotifications/syncDynamicNotifications calls - see
 * src/App.jsx), this script writes a completion directly through
 * `window.Capacitor.Plugins.CapacitorSQLite.query(...)` - bypassing storage.js and every JS
 * code path that would normally trigger a resync - and then confirms the summary notification
 * only picks up that change once `triggerBackgroundSyncTick()` is called. This isolates the
 * background-sync tick's own effect from the already-existing on-completion-change resync path.
 */
import { execSync } from 'node:child_process';

const PACKAGE = 'com.tharuka.routines';
const BG_SYNC_CHANNEL_ID = 'background-sync';
const SUMMARY_CHANNEL_ID = 'daily-summary';
const TASK_TITLE = 'Emulator Background Sync Test';
const STOP_RECEIVER = `${PACKAGE}/com.tharuka.routines.notify.BackgroundSyncActionReceiver`;

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

/** See verify-extra-reminder.mjs's version of this helper for why the full system dump isn't printed directly. */
function dumpOwnPackageForDebugging() {
  const dump = dumpNotifications();
  const blocks = dump.split('NotificationRecord(').slice(1).filter((b) => b.includes(`pkg=${PACKAGE}`));
  const notificationSection =
    blocks.length === 0
      ? `(no NotificationRecord blocks found for ${PACKAGE})`
      : blocks.map((b) => 'NotificationRecord(' + b.split('\n\n')[0]).join('\n---\n');
  const logcat = adbAllowFailure(`shell logcat -d -t 500`)
    .split('\n')
    .filter((l) => l.includes(PACKAGE) || l.includes('FATAL EXCEPTION') || l.includes('AndroidRuntime'))
    .join('\n');
  return `--- ${PACKAGE}'s own notification records ---\n${notificationSection}\n--- recent logcat mentioning ${PACKAGE} ---\n${logcat || '(nothing matched)'}`;
}

function findAppRecords(dump) {
  const blocks = dump.split('NotificationRecord(').slice(1);
  return blocks
    .filter((b) => b.includes(`pkg=${PACKAGE}`))
    .map((b) => {
      const channelMatch =
        b.match(/\bchannel=([^\s,)]+)/) || b.match(/channelId=([^\s,)]+)/) || b.match(/mChannelId=([^\s,)]+)/);
      const titleMatch = b.match(/android\.title=String \(([^)]*)\)/);
      const textMatch = b.match(/android\.text=String \(([^)]*)\)/);
      return {
        raw: b.slice(0, 800),
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
    writeCompletionDirectly: async (taskId, dateKey) => {
      await window.Capacitor.Plugins.CapacitorSQLite.run({
        database: 'routines',
        statement: 'INSERT OR REPLACE INTO completions (task_id, date, value, updated_at) VALUES (?, ?, 1, NULL)',
        values: [taskId, dateKey],
      });
      return true;
    },
    triggerBackgroundSyncTick: async () => {
      await window.Capacitor.Plugins.NativeNotifications.triggerBackgroundSyncTick();
      return true;
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

  // --- The background-sync notification should already be showing - NativeNotificationsPlugin
  // .load() starts the service unconditionally on every app process start.
  console.log('Checking for the persistent background-sync notification...');
  const bgNotification = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === BG_SYNC_CHANNEL_ID),
    (r) => Boolean(r),
    20000
  );
  if (!bgNotification) {
    console.log(dumpOwnPackageForDebugging());
    fail('No notification found on the background-sync channel - BackgroundSyncService did not start from load().');
  }
  if (bgNotification.title !== 'Daily Routines') {
    fail(`Unexpected background-sync notification title: ${JSON.stringify(bgNotification)}`);
  }
  console.log('PASS: background-sync notification is showing.', { title: bgNotification.title, text: bgNotification.text });

  // --- Create a due-today task so the summary notification has a concrete line to track.
  const weekday = Number(adb(`shell date +%w`).trim());
  const todayKey = adb(`shell date +%Y-%m-%d`).trim();
  const labelOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const targetLabel = labelOrder[weekday];

  console.log('Creating a task to track in the summary notification...');
  await mustEval(`window.__test.clickByText('.app-tabbar button', 'Routines')`, 'click Routines tab');
  await sleep(300);
  await mustEval(`window.__test.clickByText('button', '+ Add routine')`, 'click + Add routine');
  await sleep(300);
  await mustEval(
    `window.__test.setValue('.routine-form input[placeholder="e.g. Morning stretch"]', ${JSON.stringify(TASK_TITLE)})`,
    'set routine title'
  );
  await mustEval(`window.__test.setValue('.routine-form input[type="time"]', '23:55', 1)`, 'set due time to 23:55');
  const selected = await page.evaluate(`window.__test.dayChipSelected(${JSON.stringify(targetLabel)})`);
  if (selected === null) fail(`Could not find day chip for ${targetLabel}`);
  if (!selected) {
    await mustEval(`window.__test.clickDayChip(${JSON.stringify(targetLabel)})`, `select ${targetLabel} day chip`);
  }
  await mustEval(`window.__test.clickByText('button[type="submit"]', 'Add routine')`, 'submit Add routine');
  const routineSaved = await waitFor(page, `document.body.innerText.includes(${JSON.stringify(TASK_TITLE)})`, 10000);
  if (!routineSaved) fail('Routine was not created within 10s of submitting - form submission likely failed.');
  await sleep(1500); // let the resulting syncDynamicNotifications call land

  const taskId = await pollFor(
    () => page.evaluate(`window.__test.queryTaskId(${JSON.stringify(TASK_TITLE)})`),
    (id) => Boolean(id),
    20000
  );
  if (!taskId) fail('Could not find the created task\'s id via a direct SQLite query.');
  console.log('Resolved task id via SQLite query:', taskId);

  const staleLine = `${TASK_TITLE} 0%`;
  const before = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === SUMMARY_CHANNEL_ID && r.text?.includes(staleLine)),
    (r) => Boolean(r),
    20000
  );
  if (!before) {
    console.log(dumpOwnPackageForDebugging());
    fail(`Summary notification never showed "${staleLine}" after creating the task.`);
  }
  console.log('PASS: summary notification shows the new task at 0%, as expected.');

  // --- Write a completion directly through the SQLite plugin, bypassing every JS code path
  // that would normally trigger a resync (see file header) - the summary notification must NOT
  // pick this up until triggerBackgroundSyncTick() is called.
  console.log('Writing a completion directly via SQLite, bypassing storage.js entirely...');
  await page.evaluate(`window.__test.writeCompletionDirectly(${JSON.stringify(taskId)}, ${JSON.stringify(todayKey)})`);
  await sleep(2000);
  const stillStale = findAppRecords(dumpNotifications()).find(
    (r) => r.channel === SUMMARY_CHANNEL_ID && r.text?.includes(staleLine)
  );
  if (!stillStale) {
    console.warn(
      'WARN: the summary notification already stopped showing the stale line before triggerBackgroundSyncTick() was ' +
        'called - something other than the background-sync tick refreshed it, so this run cannot cleanly isolate the ' +
        'tick\'s own effect. Continuing anyway.'
    );
  } else {
    console.log('Confirmed the summary notification is still stale immediately after the direct SQL write (as expected).');
  }

  console.log('Calling triggerBackgroundSyncTick()...');
  await page.evaluate(`window.__test.triggerBackgroundSyncTick()`);

  const after = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === SUMMARY_CHANNEL_ID && r.text?.includes(staleLine)),
    (r) => !r,
    20000
  );
  if (after) {
    console.log(dumpOwnPackageForDebugging());
    fail(
      `The summary notification still shows "${staleLine}" after triggerBackgroundSyncTick() - the background-sync ` +
        'tick did not actually re-run syncAllNotifications/syncDynamicNotifications.'
    );
  }
  console.log('PASS: triggerBackgroundSyncTick() refreshed the summary notification to reflect a completion written outside the normal UI flow.');

  // --- Stop action: confirm it removes the persistent notification.
  console.log('Broadcasting the Stop action...');
  console.log('Broadcast result:', adb(`shell am broadcast --include-stopped-packages -n ${STOP_RECEIVER}`).trim());

  const stopped = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === BG_SYNC_CHANNEL_ID),
    (r) => !r,
    20000
  );
  if (stopped) {
    console.log(dumpOwnPackageForDebugging());
    fail('The background-sync notification is still showing after broadcasting the Stop action.');
  }
  console.log('PASS: the Stop action removed the background-sync notification.');

  page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
