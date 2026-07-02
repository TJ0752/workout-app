/**
 * Drives the real debug APK on a GitHub Actions Android emulator (see
 * .github/workflows/android-emulator-verify.yml) to prove the
 * catchUpDueReminderIfNeeded fix in src/notifications.js: a task's pinned
 * due-by reminder must survive a second app-wide notification resync (e.g.
 * reopening the app) instead of silently vanishing until the same weekday
 * next week - see the comment on catchUpDueReminderIfNeeded for the root
 * cause this guards against.
 *
 * Connects to the installed app's WebView over raw Chrome DevTools Protocol
 * (debug builds have WebView debugging enabled). This does NOT use
 * Playwright's connectOverCDP - Android WebView only implements page-level
 * CDP domains (Runtime/Page/DOM), not the Browser-level domain Playwright's
 * browser-context handshake requires (confirmed by a real failure: "Protocol
 * error (Browser.setDownloadBehavior): Browser context management is not
 * supported"). Instead this drives the page purely through
 * Runtime.evaluate, dispatching synthetic DOM events the same way a real
 * tap/keystroke would, then inspects real `adb shell dumpsys notification`
 * output for the actual native notification - checking real Android
 * notification manager state, not just app-level JS logic.
 */
import { execSync } from 'node:child_process';

const PACKAGE = 'com.tharuka.routines';
const CHANNEL_ID = 'routine-reminders';

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
      const flags = flagsMatch ? parseInt(flagsMatch[1], 16) : 0;
      return { raw: b.slice(0, 200), flags, ongoing: Boolean(flags & 0x2), channel: channelMatch?.[1] };
    });
}

/** Minimal raw-CDP client using only page-level domains (Runtime), since WebView doesn't support Browser-level CDP. */
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

  /** Evaluates a JS expression in the page and returns its value (must be JSON-serializable). */
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
    `window.__test.setValue('.routine-form input[placeholder="e.g. Morning stretch"]', 'Emulator Catchup Test')`,
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
  await sleep(2500); // let handleSaveRoutine's syncAllNotifications finish

  const routineSaved = await page.evaluate(`document.body.innerText.includes('Emulator Catchup Test')`);
  console.log('Routine visible in list after save:', routineSaved);

  console.log('--- dumpsys notification after initial save ---');
  const dump1 = dumpNotifications();
  console.log(`dumpsys notification: ${dump1.length} chars, mentions our package: ${dump1.includes(PACKAGE)}`);
  const pkgLines1 = dump1.split('\n').filter((l) => l.includes(PACKAGE));
  console.log(`Lines mentioning ${PACKAGE} (${pkgLines1.length}):`);
  console.log(pkgLines1.join('\n'));
  const records1 = findAppRecords(dump1);
  console.log(records1.map((r) => ({ flags: r.flags.toString(16), ongoing: r.ongoing, channel: r.channel })));
  const reminder1 = records1.find((r) => r.channel === CHANNEL_ID && r.ongoing);
  if (!reminder1) {
    fail('No ongoing routine-reminders notification found after initial save.');
  }
  console.log('PASS: ongoing due reminder present after initial save.');

  // Re-trigger a full syncAllNotifications the same way the real bug actually
  // happens: saving ANY routine re-syncs every routine's notifications (see
  // handleSaveRoutine in App.jsx) - not by reloading the WebView. A raw
  // window.location.reload() doesn't cleanly simulate "reopen the app" for
  // this Capacitor SQLite plugin anyway (its native-side connection isn't
  // tied to the WebView's JS lifecycle, so a JS reload while the native
  // Activity stays alive throws "CreateConnection: Connection routines
  // already exists" - a real app reopen goes through the native Activity
  // lifecycle instead). Editing and re-saving the same routine without
  // changing anything re-runs the exact resync path without touching SQLite
  // connection state at all.
  console.log('Re-saving the routine (no changes) to re-trigger syncAllNotifications, as a real routine edit would...');
  await mustEval(`window.__test.clickByText('button', 'Edit')`, 'click Edit on the saved routine');
  await sleep(300);
  await mustEval(`window.__test.clickByText('button[type="submit"]', 'Save changes')`, 'submit Save changes');
  await sleep(2500); // let handleSaveRoutine's syncAllNotifications finish

  console.log('--- dumpsys notification after re-save/resync ---');
  const dump2 = dumpNotifications();
  const records2 = findAppRecords(dump2);
  console.log(records2.map((r) => ({ flags: r.flags.toString(16), ongoing: r.ongoing, channel: r.channel })));
  const reminder2 = records2.find((r) => r.channel === CHANNEL_ID && r.ongoing);
  if (!reminder2) {
    console.log(dump2);
    fail(
      'The ongoing due reminder disappeared after a resync - this is exactly the bug catchUpDueReminderIfNeeded ' +
        'is supposed to fix. It regressed.'
    );
  }
  console.log('PASS: ongoing due reminder survived a resync. Catch-up fix confirmed on a real device.');

  // --- Group-summary check: create a multi-task routine and confirm a real
  // groupSummary:true notification is posted alongside its due reminders,
  // not just cosmetic `group` tagging on each one (see
  // updateRoutineGroupSummary). This is genuinely new native behavior the
  // plugin source supports but the app never exercised before, so it needs
  // its own real-device check rather than assuming the JS-level logic tests
  // are sufficient.
  console.log('Creating a multi-task routine to verify a real group-summary notification is posted...');
  await mustEval(`window.__test.clickByText('button', '+ Add routine')`, 'click + Add routine (multi-task)');
  await sleep(300);
  await mustEval(
    `window.__test.setValue('.routine-form input[placeholder="e.g. Morning stretch"]', 'Group Test Routine')`,
    'set multi-task routine title'
  );
  await mustEval(`window.__test.clickByText('button', '+ Add another task')`, 'add a second task');
  await sleep(300);
  // Adding a 2nd task switches the form to multi-task mode, where each task
  // needs its own name (the routine's own title only auto-fills the FIRST
  // task's name if that task was still blank at the time) - the newly added
  // 2nd task starts blank and would otherwise silently block submission.
  await mustEval(
    `window.__test.setValue('input[placeholder="e.g. Breakfast"]', 'Second Task')`,
    'set 2nd task name'
  );
  await mustEval(`window.__test.clickByText('button[type="submit"]', 'Add routine')`, 'submit multi-task routine');
  await sleep(2500);

  const multiRoutineSaved = await page.evaluate(`document.body.innerText.includes('Group Test Routine')`);
  console.log('Multi-task routine visible in list after save:', multiRoutineSaved);
  if (!multiRoutineSaved) fail('Multi-task routine was not created - form submission was likely blocked by validation.');

  console.log('--- dumpsys notification after creating multi-task routine ---');
  const dump3 = dumpNotifications();
  const pkgLines3 = dump3.split('\n').filter((l) => l.includes(PACKAGE));
  console.log(`Lines mentioning ${PACKAGE} (${pkgLines3.length}):`);
  console.log(pkgLines3.join('\n'));
  const mentionsGroupBody = dump3.includes('2 tasks');
  const mentionsGroupTitle = dump3.includes('Group Test Routine');
  console.log('Mentions "2 tasks" body:', mentionsGroupBody, '| mentions routine title:', mentionsGroupTitle);
  if (!mentionsGroupBody || !mentionsGroupTitle) {
    fail('Could not find the expected group-summary notification content ("Group Test Routine" / "2 tasks").');
  }
  console.log('PASS: group-summary notification content found for the multi-task routine on a real device.');

  page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
