/**
 * Drives the real debug APK on a GitHub Actions Android emulator (see
 * .github/workflows/android-emulator-verify.yml) to prove the native due-by reminder path
 * (android/app/.../notify/DueReminderScheduler.kt + DueReminderAlarmReceiver.kt +
 * DueReminderDismissReceiver.kt, fronted by NativeNotificationsPlugin) actually behaves as
 * designed on a real device - not just that it compiles (see CLAUDE.md's "Native notifications"
 * section for the full design).
 *
 * Formerly named verify-notification-catchup.mjs and written to prove the now-deleted JS
 * catchUpDueReminderIfNeeded fix; the due-by reminder has since moved entirely off
 * @capacitor/local-notifications onto this native plugin (see src/notifications.js's
 * scheduleTaskNotifications), so this script now exercises DueReminderScheduler.schedule()'s
 * own catch-up logic (its isDoneToday/isOverdueToday-driven immediate-fire path) and
 * DueReminderDismissReceiver's reappear-on-dismiss instead. Group-summary and the daily-summary
 * notification's own reappear-on-dismiss check live in verify-group-summary.mjs - they're
 * unrelated to this migration and didn't need to move, but splitting keeps each script focused
 * on one notification type.
 *
 * Connects to the installed app's WebView over raw Chrome DevTools Protocol (debug builds have
 * WebView debugging enabled). This does NOT use Playwright's connectOverCDP - Android WebView
 * only implements page-level CDP domains (Runtime/Page/DOM), not the Browser-level domain
 * Playwright's browser-context handshake requires (confirmed by a real failure: "Protocol error
 * (Browser.setDownloadBehavior): Browser context management is not supported"). Instead this
 * drives the page purely through Runtime.evaluate, dispatching synthetic DOM events the same way
 * a real tap/keystroke would.
 *
 * The reappear-on-dismiss check needs a *real* swipe gesture, not a broadcast straight to
 * DueReminderDismissReceiver like verify-group-summary.mjs does for the summary notification -
 * unlike the summary's single global delete-intent, the due reminder's delete-intent carries a
 * per-task `taskId` extra (see DueReminderNotificationBuilder.kt), and nothing in this script has
 * a way to know the task id the app generated internally (crypto.randomUUID(), never exposed to
 * the DOM or dumpsys) without either a broadcast with the wrong extras or poking at the app's
 * SQLite DB from outside its own connection - both worse than just swiping the real notification
 * row, which needs no task id at all. This is safe here (unlike the workout timer's own swipe
 * check) because the due reminder is a plain `ongoing` notification with no
 * setUsesChronometer-driven ticking text, so `uiautomator dump` doesn't hit the "cannot succeed
 * while the chronometer is visible" issue documented in CLAUDE.md/verify-workout-session-
 * notification.mjs - a real UI Automator dump reliably finds it by title text.
 */
import { execSync } from 'node:child_process';

const PACKAGE = 'com.tharuka.routines';
const CHANNEL_ID = 'routine-reminders';
const TASK_TITLE = 'Emulator Due Reminder Test';

function adb(cmd) {
  return execSync(`adb ${cmd}`, { encoding: 'utf8' });
}

/** `adb shell pidof`/similar exit non-zero (and execSync throws) when nothing matches yet - treat that as "". */
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

function deviceNow() {
  const hhmm = adb(`shell date +%H:%M`).trim();
  const weekday = Number(adb(`shell date +%w`).trim()); // 0=Sunday..6=Saturday, matches JS Date.getDay()
  return { hhmm, weekday };
}

function minutesAgo(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h * 60 + m - minutes + 24 * 60) % (24 * 60);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
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
        raw: b.slice(0, 300),
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

/** See the file header for why this is safe here despite CLAUDE.md's chronometer-related warning
 * against relying on uiautomator dump for the workout timer's own swipe check - this notification
 * has no ticking text. */
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

  const { hhmm: nowHHMM, weekday } = deviceNow();
  const dueTime = minutesAgo(nowHHMM, 2);
  console.log(`Device time is ${nowHHMM}, weekday ${weekday}. Creating a task due at ${dueTime} (2 min ago).`);

  async function mustEval(expression, description) {
    const ok = await page.evaluate(expression);
    if (!ok) fail(`UI step failed: ${description} (expression returned ${JSON.stringify(ok)})`);
    return ok;
  }

  await mustEval(`window.__test.clickByText('.app-tabbar button', 'Routines')`, 'click Routines tab');
  await sleep(300);
  await mustEval(`window.__test.clickByText('button', '+ Add routine')`, 'click + Add routine');
  await sleep(300);
  await mustEval(
    `window.__test.setValue('.routine-form input[placeholder="e.g. Morning stretch"]', ${JSON.stringify(TASK_TITLE)})`,
    'set routine title'
  );
  // "Starts at" is the 1st time input, "Due by" is the 2nd
  await mustEval(
    `window.__test.setValue('.routine-form input[type="time"]', ${JSON.stringify(dueTime)}, 1)`,
    'set due time'
  );

  const labelOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const targetLabel = labelOrder[weekday];
  const selected = await page.evaluate(`window.__test.dayChipSelected(${JSON.stringify(targetLabel)})`);
  if (selected === null) fail(`Could not find day chip for ${targetLabel}`);
  if (!selected) {
    await mustEval(`window.__test.clickDayChip(${JSON.stringify(targetLabel)})`, `select ${targetLabel} day chip`);
  }
  console.log(`Day chip ${targetLabel} selected:`, true);

  await mustEval(`window.__test.clickByText('button[type="submit"]', 'Add routine')`, 'submit Add routine');
  // Poll rather than a fixed sleep - handleSaveRoutine's native SQLite round-trip through
  // syncAllNotifications has been observed to occasionally take several seconds on a
  // freshly-booted emulator, well past what a short fixed sleep assumes.
  const routineSaved = await waitFor(page, `document.body.innerText.includes(${JSON.stringify(TASK_TITLE)})`, 10000);
  console.log('Routine visible in list after save:', routineSaved);
  if (!routineSaved) fail('Routine was not created within 10s of submitting - form submission likely failed.');
  await sleep(500); // let the notification-sync side-effects that follow the DOM update settle

  console.log('--- dumpsys notification after initial save ---');
  const dump1 = dumpNotifications();
  const records1 = findAppRecords(dump1);
  console.log(records1.map((r) => ({ flags: r.flags.toString(16), ongoing: r.ongoing, channel: r.channel, title: r.title })));
  const reminder1 = records1.find((r) => r.channel === CHANNEL_ID && r.ongoing && r.title?.includes(TASK_TITLE));
  if (!reminder1) {
    fail(
      'No ongoing routine-reminders notification found after initial save - DueReminderScheduler.schedule()\'s ' +
        'immediate catch-up fire for an already-overdue task did not happen.'
    );
  }
  console.log('PASS: native due reminder caught up immediately for an already-overdue new task.');

  // Re-trigger a full syncAllNotifications the same way the real underlying scenario happens:
  // saving ANY routine re-syncs every routine's notifications (see handleSaveRoutine in
  // App.jsx) - not by reloading the WebView. A raw window.location.reload() doesn't cleanly
  // simulate "reopen the app" for this Capacitor SQLite plugin anyway (its native-side
  // connection isn't tied to the WebView's JS lifecycle, so a JS reload while the native
  // Activity stays alive throws "CreateConnection: Connection routines already exists" - a real
  // app reopen goes through the native Activity lifecycle instead). Editing and re-saving the
  // same routine without changing anything re-runs the exact resync path without touching
  // SQLite connection state at all.
  console.log('Re-saving the routine (no changes) to re-trigger syncAllNotifications, as a real routine edit would...');
  await mustEval(`window.__test.clickByText('button', 'Edit')`, 'click Edit on the saved routine');
  await sleep(300);
  await mustEval(`window.__test.clickByText('button[type="submit"]', 'Save changes')`, 'submit Save changes');
  await sleep(4500); // let handleSaveRoutine's syncAllNotifications finish - native SQLite round-trips
                      // have been observed to occasionally take several seconds on a cold emulator

  console.log('--- dumpsys notification after re-save/resync ---');
  const dump2 = dumpNotifications();
  const records2 = findAppRecords(dump2);
  console.log(records2.map((r) => ({ flags: r.flags.toString(16), ongoing: r.ongoing, channel: r.channel, title: r.title })));
  const reminder2 = records2.find((r) => r.channel === CHANNEL_ID && r.ongoing && r.title?.includes(TASK_TITLE));
  if (!reminder2) {
    console.log(dump2);
    fail(
      'The ongoing due reminder disappeared after a resync - DueReminderScheduler.schedule()\'s no-op-if-unchanged ' +
        'comparison regressed (or scheduleTaskNotifications is wiping the native store again before rescheduling).'
    );
  }
  console.log('PASS: ongoing due reminder survived a resync (no-op-if-unchanged confirmed on a real device).');

  // --- Reappear-on-dismiss check: swipe the real notification away and confirm
  // DueReminderDismissReceiver reposts it, since awaitingCompletion is still true (the task was
  // never marked done). Needs a real swipe, not a broadcast straight to the receiver, since its
  // delete-intent carries a per-task `taskId` extra this script has no way to know independently
  // (see file header) - unlike the summary notification's single global delete-intent.
  const screen = getScreenSize();
  if (!screen) fail('Could not determine screen size via `adb shell wm size`.');

  console.log('Expanding the notification shade...');
  adb(`shell cmd statusbar expand-notifications`);
  await sleep(1000);

  const xml = uiDump();
  if (!xml) fail('uiautomator dump did not produce a UI tree.');
  const bounds = findNodeByLooseText(xml, TASK_TITLE);
  if (!bounds) {
    adb(`shell cmd statusbar collapse`);
    fail(`Could not find the due reminder notification row in the shade (looked for text/content-desc containing "${TASK_TITLE}").`);
  }
  const y = Math.floor((bounds.y1 + bounds.y2) / 2);
  console.log(`Found notification row at bounds [${bounds.x1},${bounds.y1}][${bounds.x2},${bounds.y2}] - swiping...`);
  adb(`shell input swipe ${Math.floor(screen.width * 0.9)} ${y} ${Math.floor(screen.width * 0.05)} ${y} 150`);
  await sleep(1000);
  adb(`shell cmd statusbar collapse`);

  console.log('Waiting for the due reminder to reappear after the swipe...');
  let reminder3 = null;
  const repostStart = Date.now();
  while (Date.now() - repostStart < 10000) {
    reminder3 = findAppRecords(dumpNotifications()).find(
      (r) => r.channel === CHANNEL_ID && r.ongoing && r.title?.includes(TASK_TITLE)
    );
    if (reminder3) break;
    await sleep(500);
  }
  if (!reminder3) {
    fail(
      'The due reminder did not reappear after being swiped away - DueReminderDismissReceiver\'s reappear-on-dismiss ' +
        'is broken (or the swipe gesture missed the notification row entirely - check the logged bounds above).'
    );
  }
  if (reminder3.title !== reminder1.title || reminder3.text !== reminder1.text) {
    fail(
      `The reposted due reminder's content changed unexpectedly (before: ${JSON.stringify({ title: reminder1.title, text: reminder1.text })}, ` +
        `after: ${JSON.stringify({ title: reminder3.title, text: reminder3.text })}).`
    );
  }
  console.log('PASS: due reminder reappeared with matching content after a real swipe-dismiss.');

  page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
