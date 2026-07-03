/**
 * Drives the real debug APK on a GitHub Actions Android emulator to verify the actual payoff of
 * the native-Android migration: WorkoutTimerService (src/../android/app/.../WorkoutTimerService.kt)
 * must post a genuinely foreground-service-backed notification - not just the plain `ongoing`
 * flag @capacitor/local-notifications uses, which does NOT reliably block swipe-dismiss on
 * Android 8+. This is the only stage of that migration that behaviorally proves the fix; every
 * earlier stage only proved the code compiles.
 *
 * Creating the workout task and starting the session happens through the WebView (same raw-CDP
 * approach as verify-notification-catchup.mjs - see that file's header for why Playwright's
 * connectOverCDP doesn't work here). But the actual workout session screen
 * (WorkoutSessionActivity) is a *native* Compose Activity layered on top of MainActivity, not
 * part of the WebView's DOM - CDP cannot see or interact with it at all. Interacting with it
 * requires real UI Automator dumps (`adb shell uiautomator dump`) parsed for element bounds, then
 * `adb shell input tap`/`swipe` at those coordinates - the same "drive it like a real user would"
 * philosophy as the WebView script, just via a different tool for native views.
 */
import { execSync } from 'node:child_process';

const PACKAGE = 'com.tharuka.routines';
const TIMER_CHANNEL_ID = 'workout-session-timer';
const FLAG_FOREGROUND_SERVICE = 0x40;

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

function getScreenSize() {
  const out = adb(`shell wm size`);
  const match = out.match(/(?:Override|Physical) size: (\d+)x(\d+)/);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
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
      return { raw: b.slice(0, 300), flags, channel: channelMatch?.[1] };
    });
}

/** Dumps the current UI tree (native or WebView, whichever has focus) via UI Automator, since CDP
 * cannot see the native Compose Activity at all once it's launched on top of the WebView. */
/** `uiautomator dump` internally waits for the UI to go idle before it can capture a tree, and
 * fails outright ("ERROR: could not get idle state.", no output file at all) if that never
 * happens within its own hardcoded internal timeout. It is unusable for anything that renders
 * the workout timer notification's chronometer text (setUsesChronometer(true) updates it once a
 * second for as long as it's visible) - confirmed on a real device across 70+ retries over
 * several minutes with a 0% success rate while the expanded shade was showing it, so this is a
 * hard incompatibility, not a race worth retrying through. The swipe-test step below locates its
 * target by screen geometry instead of a UI dump for exactly this reason. Elsewhere in this
 * script (the native Activity's own UI, which has no permanently-updating view while not
 * resting) a short retry loop is enough, matching the flakiness this project has seen from
 * `uiautomator dump` around ordinary animations/overlays. */
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

/** Robust to attribute order within a <node .../> - matches text and bounds independently rather
 * than assuming one regex spanning both attributes in a fixed order. */
function findNodeBoundsByText(xml, text) {
  const nodes = xml.match(/<node\b[^>]*\/>/g) || [];
  for (const node of nodes) {
    const textMatch = node.match(/\btext="([^"]*)"/);
    if (textMatch && textMatch[1] === text) {
      const boundsMatch = node.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (boundsMatch) {
        const [, x1, y1, x2, y2] = boundsMatch.slice(1).map(Number);
        return { x1, y1, x2, y2, centerX: Math.floor((x1 + x2) / 2), centerY: Math.floor((y1 + y2) / 2) };
      }
    }
  }
  return null;
}

async function waitForNode(text, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const bounds = findNodeBoundsByText(uiDump(), text);
    if (bounds) return bounds;
    await sleep(500);
  }
  return null;
}

function tap(bounds) {
  adb(`shell input tap ${bounds.centerX} ${bounds.centerY}`);
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
  await sleep(4000);

  const socket = findDevtoolsSocket();
  if (!socket) fail('Could not find a WebView devtools socket.');
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

  console.log('Creating a single-task workout routine...');
  await mustEval(`window.__test.clickByText('.app-tabbar button', 'Routines')`, 'click Routines tab');
  await sleep(300);
  await mustEval(`window.__test.clickByText('button', '+ Add routine')`, 'click + Add routine');
  await sleep(300);
  await mustEval(
    `window.__test.setValue('.routine-form input[placeholder="e.g. Morning stretch"]', 'Emulator Workout Test')`,
    'set routine title'
  );
  await mustEval(`window.__test.clickByText('button', 'Workout')`, 'select Workout completion type');
  await sleep(200);
  await mustEval(`window.__test.clickByText('button', '+ Add exercise')`, 'click + Add exercise');
  await sleep(200);
  await mustEval(
    `window.__test.setValue('input[placeholder="e.g. Push-ups"]', 'Test Pushups')`,
    'set exercise name'
  );
  await mustEval(`window.__test.clickByText('button[type="submit"]', 'Add routine')`, 'submit Add routine');

  const routineSaved = await waitFor(page, `document.body.innerText.includes('Emulator Workout Test')`, 10000);
  console.log('Workout routine visible in list after save:', routineSaved);
  if (!routineSaved) fail('Workout routine was not created within 10s of submitting - form submission likely failed.');
  await sleep(500);

  await mustEval(`window.__test.clickByText('.app-tabbar button', 'Today')`, 'click Today tab');
  await sleep(500);

  console.log('Starting the native workout session...');
  await mustEval(`window.__test.clickByText('button.qty-btn.primary', 'Start workout')`, 'click Start workout');

  // WorkoutSession.start()'s Intent launches WorkoutSessionActivity + WorkoutTimerService.onCreate
  // natively - there's no WebView DOM signal to poll for this, so poll dumpsys itself instead of a
  // fixed sleep (native SQLite/Activity-launch timing is variable on a cold emulator, same issue
  // fixed in verify-notification-catchup.mjs).
  console.log('Waiting for the workout timer notification to appear...');
  let records1 = [];
  let timerNotif1 = null;
  const notifStart = Date.now();
  while (Date.now() - notifStart < 15000) {
    records1 = findAppRecords(dumpNotifications());
    timerNotif1 = records1.find((r) => r.channel === TIMER_CHANNEL_ID);
    if (timerNotif1) break;
    await sleep(500);
  }
  console.log('--- dumpsys notification right after starting the session ---');
  console.log(records1.map((r) => ({ flags: r.flags.toString(16), channel: r.channel })));
  if (!timerNotif1) {
    console.log(dumpNotifications());
    fail(`No notification found on the ${TIMER_CHANNEL_ID} channel after starting a workout session.`);
  }
  if (!(timerNotif1.flags & FLAG_FOREGROUND_SERVICE)) {
    fail(
      `Workout timer notification is missing FLAG_FOREGROUND_SERVICE (0x40) - flags were 0x${timerNotif1.flags.toString(16)}. ` +
        'This means it is not actually backed by a real foreground service, defeating the whole point of this migration.'
    );
  }
  console.log('PASS: workout timer notification is present with FLAG_FOREGROUND_SERVICE set.');

  console.log('Attempting to swipe-dismiss the notification via the shade...');
  const screen = getScreenSize();
  if (!screen) fail('Could not determine screen size via `adb shell wm size`.');
  adb(`shell cmd statusbar expand-notifications`);
  await sleep(2000);
  // Can't locate the notification's row via a UI Automator dump here - see uiDump()'s comment,
  // this is the exact case it can never succeed in. Sweep a real swipe gesture across a spread of
  // plausible row positions instead of one exact coordinate: exact row position depends on how
  // many other notifications are stacked above it, which varies by prior test state, but a swipe
  // is what this check needs to prove the OS itself refuses regardless of which row it lands on.
  for (let i = 0; i < 10; i++) {
    const y = Math.floor(screen.height * (0.15 + i * 0.06));
    adb(`shell input swipe ${Math.floor(screen.width * 0.15)} ${y} ${Math.floor(screen.width * 0.85)} ${y} 150`);
    await sleep(150);
  }
  await sleep(500);
  adb(`shell cmd statusbar collapse`);
  await sleep(500);

  const dump2 = dumpNotifications();
  const records2 = findAppRecords(dump2);
  const timerNotif2 = records2.find((r) => r.channel === TIMER_CHANNEL_ID);
  if (!timerNotif2) {
    fail(
      'The workout timer notification was swiped away - it is NOT actually swipe-resistant. ' +
        'The foreground service either is not correctly configured, or FLAG_FOREGROUND_SERVICE alone is not ' +
        'sufficient to block a shade swipe on this Android version.'
    );
  }
  console.log('PASS: workout timer notification survived a swipe attempt - genuinely swipe-resistant.');

  console.log('Closing the workout session...');
  const closeNode = await waitForNode('✕', 20000);
  if (!closeNode) fail('Could not find the session close ("✕") button via UI Automator.');
  tap(closeNode);
  await sleep(2000);

  console.log('--- dumpsys notification after closing the session ---');
  const dump3 = dumpNotifications();
  const records3 = findAppRecords(dump3);
  const timerNotif3 = records3.find((r) => r.channel === TIMER_CHANNEL_ID);
  if (timerNotif3) {
    console.log(dump3);
    fail('The workout timer notification is still present after closing the session - the service was not stopped.');
  }
  console.log('PASS: workout timer notification and its foreground service were cleared on session close.');

  page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
