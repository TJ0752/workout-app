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
      const channelMatch = b.match(/channelId=([^\s,)]+)/) || b.match(/mChannelId=([^\s,)]+)/);
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
    const pid = adb(`shell pidof ${PACKAGE}`).trim();
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

  await page.evaluate(`window.__test.clickByText('.app-tabbar button', 'Routines')`);
  await sleep(300);
  await page.evaluate(`window.__test.clickByText('button', '+ Add routine')`);
  await sleep(300);
  await page.evaluate(
    `window.__test.setValue('.routine-form input[placeholder="e.g. Morning stretch"]', 'Emulator Catchup Test')`
  );
  // "Starts at" is the 1st time input, "Due by" is the 2nd
  await page.evaluate(`window.__test.setValue('.routine-form input[type="time"]', ${JSON.stringify(dueTime)}, 1)`);

  const labelOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const targetLabel = labelOrder[weekday];
  const selected = await page.evaluate(`window.__test.dayChipSelected(${JSON.stringify(targetLabel)})`);
  if (!selected) {
    await page.evaluate(`window.__test.clickDayChip(${JSON.stringify(targetLabel)})`);
  }

  await page.evaluate(`window.__test.clickByText('button[type="submit"]', 'Add routine')`);
  await sleep(2500); // let handleSaveRoutine's syncAllNotifications finish

  console.log('--- dumpsys notification after initial save ---');
  const dump1 = dumpNotifications();
  const records1 = findAppRecords(dump1);
  console.log(records1.map((r) => ({ flags: r.flags.toString(16), ongoing: r.ongoing, channel: r.channel })));
  const reminder1 = records1.find((r) => r.channel === CHANNEL_ID && r.ongoing);
  if (!reminder1) {
    console.log(dump1);
    fail('No ongoing routine-reminders notification found after initial save.');
  }
  console.log('PASS: ongoing due reminder present after initial save.');

  console.log('Reloading the WebView to simulate reopening the app (re-triggers syncAllNotifications)...');
  await page.evaluate(`window.location.reload(); true;`).catch(() => {});
  page.close();
  await sleep(1500);

  // The reload tears down the old CDP session's page context - reconnect fresh.
  const listRes2 = await fetch('http://localhost:9222/json');
  const targets2 = await listRes2.json();
  const target2 = targets2.find((t) => t.type === 'page') || targets2[0];
  const page2 = new CdpPage(target2.webSocketDebuggerUrl);
  await page2.connect();
  await page2.evaluate(JS_HELPERS);
  const appReady2 = await waitFor(page2, `window.__test.ready('.app-tabbar')`);
  if (!appReady2) fail('App did not re-render .app-tabbar after reload.');
  await sleep(3000); // let the mount effect's syncAllNotifications finish

  console.log('--- dumpsys notification after reload/resync ---');
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

  page2.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
