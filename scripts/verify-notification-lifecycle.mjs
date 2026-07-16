/**
 * Drives the real debug APK on a GitHub Actions Android emulator (see
 * .github/workflows/android-emulator-verify.yml) to prove this session's native notification
 * additions actually behave as designed on a real device - not just that they compile. Covers,
 * in one continuous run against two tasks:
 *
 *   1. Task A (boolean): windowStart fires a real notification before the due-by moment
 *      (WindowStartAlarmReceiver), the due-time alarm re-fires it at the real due moment
 *      (DueReminderAlarmReceiver), a real tap on "Mark done" flips it into the plain,
 *      swipeable "completed" state (NativeNotificationsPlugin.dismissDueReminderToday's
 *      `completed = true` branch), and a real swipe afterward confirms it does NOT reappear
 *      (unlike the still-pending case verify-due-reminder.mjs already covers).
 *   2. Task B (boolean, due a few minutes in the past): the existing overdue catch-up posts
 *      it immediately (see verify-due-reminder.mjs), then the clock is advanced past
 *      DueReminderScheduler.EXPIRY_BUFFER_MS and it's confirmed gone - never marked done -
 *      proving the per-task due-time auto-dismiss (DueReminderExpiryAlarmReceiver).
 *
 * Uses the same real-AlarmManager clock-jump technique verify-extra-reminder.mjs established
 * (`adb shell date` + ACTION_TIME_CHANGED, root available on non-Play-Store google_apis images)
 * rather than `adb shell am broadcast -n <receiver>`, which was found to never reach this app's
 * manifest-declared receivers on this emulator image (see that script's file header for the full
 * root-cause writeup).
 *
 * Also captures a real PNG screenshot (`adb exec-out screencap`) at each meaningful checkpoint,
 * saved under `screenshots/`, uploaded as a build artifact by the workflow - not just parsed
 * `dumpsys`/`uiautomator` text, but the actual rendered notification shade pixels.
 */
import { execSync } from 'node:child_process';

const PACKAGE = 'com.tharuka.routines';
const CHANNEL_ID = 'routine-reminders';
const TASK_A_TITLE = 'Emulator Lifecycle Task A';
const TASK_B_TITLE = 'Emulator Lifecycle Task B';
const SCREENSHOT_DIR = 'screenshots';

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
        autoCancel: Boolean(flags & 0x10),
        channel: channelMatch?.[1],
        title: titleMatch?.[1],
        text: textMatch?.[1],
      };
    });
}

function findByTitle(dump, title) {
  return findAppRecords(dump).find((r) => r.channel === CHANNEL_ID && r.title === title);
}

function getScreenSize() {
  const out = adb(`shell wm size`);
  const match = out.match(/(?:Override|Physical) size: (\d+)x(\d+)/);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** See verify-due-reminder.mjs's identical helper - safe here (no chronometer-driven ticking text). */
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

/** Real PNG off the actual device screen - not a description of the UI, the UI itself. */
function screenshot(label) {
  execSync(`mkdir -p ${SCREENSHOT_DIR}`);
  const safe = label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const path = `${SCREENSHOT_DIR}/${safe}.png`;
  execSync(`adb exec-out screencap -p > ${path}`);
  console.log(`Saved screenshot: ${path}`);
}

/** Expands the shade, screenshots it, then collapses - so the notification itself is visible. */
function screenshotShade(label) {
  adb(`shell cmd statusbar expand-notifications`);
  execSync('sleep 800');
  screenshot(label);
  adbAllowFailure(`shell cmd statusbar collapse`);
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
  execSync('sleep 1');
  adbAllowFailure(`shell cmd statusbar collapse`);
}

function swipeAway(title, screen) {
  adb(`shell cmd statusbar expand-notifications`);
  execSync('sleep 1');
  const xml = uiDump();
  if (!xml) {
    adbAllowFailure(`shell cmd statusbar collapse`);
    fail(`uiautomator dump did not produce a UI tree while looking for "${title}".`);
  }
  const bounds = findNodeByLooseText(xml, title);
  if (!bounds) {
    adbAllowFailure(`shell cmd statusbar collapse`);
    fail(`Could not find the "${title}" notification row in the shade.`);
  }
  const y = Math.floor((bounds.y1 + bounds.y2) / 2);
  adb(`shell input swipe ${Math.floor(screen.width * 0.9)} ${y} ${Math.floor(screen.width * 0.05)} ${y} 150`);
  execSync('sleep 1000');
  adbAllowFailure(`shell cmd statusbar collapse`);
}

const pad = (n) => String(n).padStart(2, '0');

function deviceDateTimeFields() {
  const out = adb(`shell date +"%m %d %Y %H %M %S %w"`).trim();
  const [month, day, year, hour, minute, second, weekday] = out.split(/\s+/).map(Number);
  return { month, day, year, hour, minute, second, weekday };
}

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

/** Requires root, granted by default on non-Play-Store google_apis emulator images. Setting the
 * clock fires ACTION_TIME_CHANGED, which AlarmManager listens for to re-evaluate and fire any
 * now-overdue alarms - the real (not synthetic) path every alarm in this app depends on. */
function setDeviceTime(fields) {
  const value = `${pad(fields.month)}${pad(fields.day)}${pad(fields.hour)}${pad(fields.minute)}${fields.year}.${pad(fields.second)}`;
  adb(`shell date ${value}`);
  console.log('Device time is now:', adb(`shell date`).trim());
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
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('Page evaluation error: ' + JSON.stringify(result.exceptionDetails));
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

async function createTask(page, mustEval, { title, windowStart, dueTime, weekday }) {
  await mustEval(`window.__test.clickByText('.app-tabbar button', 'Routines')`, 'click Routines tab');
  await sleep(300);
  await mustEval(`window.__test.clickByText('button', '+ Add routine')`, 'click + Add routine');
  await sleep(300);
  await mustEval(
    `window.__test.setValue('.routine-form input[placeholder="e.g. Morning stretch"]', ${JSON.stringify(title)})`,
    'set routine title'
  );
  // "Starts at" (task.windowStart) is time input index 0, "Due by" (task.time) is index 1.
  await mustEval(`window.__test.setValue('.routine-form input[type="time"]', ${JSON.stringify(windowStart)}, 0)`, 'set windowStart');
  await mustEval(`window.__test.setValue('.routine-form input[type="time"]', ${JSON.stringify(dueTime)}, 1)`, 'set due time');

  const labelOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const targetLabel = labelOrder[weekday];
  const selected = await page.evaluate(`window.__test.dayChipSelected(${JSON.stringify(targetLabel)})`);
  if (selected === null) fail(`Could not find day chip for ${targetLabel}`);
  if (!selected) await mustEval(`window.__test.clickDayChip(${JSON.stringify(targetLabel)})`, `select ${targetLabel} day chip`);

  await mustEval(`window.__test.clickByText('button[type="submit"]', 'Add routine')`, 'submit Add routine');
  const saved = await waitFor(page, `document.body.innerText.includes(${JSON.stringify(title)})`, 10000);
  if (!saved) fail(`Routine "${title}" was not created within 10s of submitting.`);
  await sleep(1500); // let syncAllNotifications' native scheduling calls land
}

async function main() {
  console.log('Waiting for app to boot...');
  for (let i = 0; i < 30; i++) {
    const pid = adbAllowFailure(`shell pidof ${PACKAGE}`).trim();
    if (pid) break;
    await sleep(1000);
  }
  await sleep(4000);

  const out = adb(`shell cat /proc/net/unix`);
  const line = out.split('\n').find((l) => l.includes('devtools_remote'));
  if (!line) fail("Could not find a WebView devtools socket - is the debug build's WebView debugging enabled?");
  const socket = line.match(/@?(\S*devtools_remote\S*)/)[1].replace(/^@/, '');
  adb(`forward tcp:9222 localabstract:${socket}`);

  const listRes = await fetch('http://localhost:9222/json');
  const targets = await listRes.json();
  const target = targets.find((t) => t.type === 'page') || targets[0];
  if (!target) fail('No page target found via CDP /json listing.');

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

  const screen = getScreenSize();
  if (!screen) fail('Could not determine screen size via `adb shell wm size`.');

  const baseline = deviceDateTimeFields();
  const windowStartTarget = addMinutes(baseline, 2);
  const dueTarget = addMinutes(baseline, 5);
  console.log(
    `Device time ${pad(baseline.hour)}:${pad(baseline.minute)}. Task A: windowStart ${pad(windowStartTarget.hour)}:${pad(windowStartTarget.minute)}, due ${pad(dueTarget.hour)}:${pad(dueTarget.minute)}.`
  );

  // ================= Task A: windowStart -> due -> Mark done -> completed/dismissable =================
  console.log(`\n=== Creating Task A ("${TASK_A_TITLE}") ===`);
  await createTask(page, mustEval, {
    title: TASK_A_TITLE,
    windowStart: `${pad(windowStartTarget.hour)}:${pad(windowStartTarget.minute)}`,
    dueTime: `${pad(dueTarget.hour)}:${pad(dueTarget.minute)}`,
    weekday: baseline.weekday,
  });

  console.log('\n--- Jumping clock to windowStart ---');
  adbAllowFailure(`shell logcat -c`);
  setDeviceTime({ ...windowStartTarget, second: 10 });
  const windowPost = await pollFor(() => findByTitle(dumpNotifications(), TASK_A_TITLE), (r) => Boolean(r));
  if (!windowPost) fail('No notification appeared once the device clock reached windowStart - WindowStartAlarmReceiver did not fire.');
  console.log('PASS: windowStart posted a real notification.', { ongoing: windowPost.ongoing, flags: windowPost.flags.toString(16) });
  screenshotShade('01-task-a-windowstart-post');

  console.log('\n--- Jumping clock to the due-by moment ---');
  setDeviceTime({ ...dueTarget, second: 10 });
  const duePost = await pollFor(() => findByTitle(dumpNotifications(), TASK_A_TITLE), (r) => Boolean(r) && r.ongoing);
  if (!duePost) fail('Notification was not showing (ongoing) once the device clock reached the due-by moment.');
  console.log('PASS: due-time alarm fired/re-alerted the same notification.');
  screenshotShade('02-task-a-due-post');

  console.log('\n--- Tapping the real "Mark done" action ---');
  tapNotificationAction('Mark done');
  const completedPost = await pollFor(
    () => findByTitle(dumpNotifications(), TASK_A_TITLE),
    (r) => Boolean(r) && !r.ongoing
  );
  if (!completedPost) {
    fail('Notification did not switch to the plain/non-ongoing "completed" state after Mark done was tapped.');
  }
  console.log('PASS: marking done reposted the notification as plain (not ongoing) - the "completed" state.', {
    ongoing: completedPost.ongoing,
    flags: completedPost.flags.toString(16),
  });
  screenshotShade('03-task-a-completed-dismissable');

  console.log('\n--- Swiping the completed notification away - it must NOT reappear ---');
  swipeAway(TASK_A_TITLE, screen);
  await sleep(3000); // give any (incorrect) reappear-on-dismiss logic a real chance to fire
  const afterSwipe = findByTitle(dumpNotifications(), TASK_A_TITLE);
  if (afterSwipe) {
    fail(`Completed notification reappeared after being swiped away - it should stay dismissed. Record: ${JSON.stringify(afterSwipe)}`);
  }
  console.log('PASS: completed notification stayed dismissed after a real swipe (no reappear-on-dismiss for the completed state).');
  screenshotShade('04-task-a-after-swipe-gone');

  // ================= Task B: overdue catch-up -> per-task due-time auto-dismiss =================
  const bBaseline = deviceDateTimeFields();
  const bDueTarget = addMinutes(bBaseline, -1); // already 1 minute overdue when created
  console.log(`\n=== Creating Task B ("${TASK_B_TITLE}"), due ${pad(bDueTarget.hour)}:${pad(bDueTarget.minute)} (1 min ago) ===`);
  await createTask(page, mustEval, {
    title: TASK_B_TITLE,
    windowStart: '00:00',
    dueTime: `${pad(bDueTarget.hour)}:${pad(bDueTarget.minute)}`,
    weekday: bBaseline.weekday,
  });

  const catchUpPost = await pollFor(() => findByTitle(dumpNotifications(), TASK_B_TITLE), (r) => Boolean(r) && r.ongoing);
  if (!catchUpPost) fail('No ongoing notification appeared after creating an already-overdue Task B - overdue catch-up did not fire.');
  console.log('PASS: Task B caught up immediately on creation (already overdue).');
  screenshotShade('05-task-b-overdue-catchup');

  // DueReminderScheduler.EXPIRY_BUFFER_MS is 2 minutes past the task's own due moment - jump the
  // clock 3 minutes past Task B's due time (comfortably past the buffer) and confirm it's gone,
  // never having been marked done.
  const expiryCheckTarget = addMinutes(bDueTarget, 3);
  console.log(`\n--- Jumping clock to ${pad(expiryCheckTarget.hour)}:${pad(expiryCheckTarget.minute)} (past Task B's expiry buffer) ---`);
  setDeviceTime({ ...expiryCheckTarget, second: 10 });
  await sleep(2000);
  const afterExpiry = await pollFor(
    () => findByTitle(dumpNotifications(), TASK_B_TITLE),
    (r) => !r,
    15000
  );
  if (afterExpiry) {
    fail(`Task B's reminder was still showing well past its own due-time expiry buffer. Record: ${JSON.stringify(afterExpiry)}`);
  }
  console.log('PASS: Task B auto-dismissed itself shortly after its own due-by moment, never having been completed.');
  screenshotShade('06-task-b-after-expiry-gone');

  console.log('\nAll notification lifecycle checks passed.');
  page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
