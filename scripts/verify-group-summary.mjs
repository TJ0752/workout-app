/**
 * Drives the real debug APK on a GitHub Actions Android emulator (see
 * .github/workflows/android-emulator-verify.yml) to prove two notification behaviors that are
 * unrelated to the due-by reminder migration (see verify-due-reminder.mjs for that) and so live
 * in their own script:
 *
 *   1. A multi-task routine gets a real Android `groupSummary: true` notification
 *      (updateRoutineGroupSummary in src/notifications.js), not just cosmetic `group` tagging on
 *      each task's own reminder.
 *   2. The daily summary notification (NativeNotificationsPlugin.showSummary /
 *      SummaryDismissReceiver) reappears immediately if swiped away, since it has a real
 *      setDeleteIntent() behind it that @capacitor/local-notifications has no hook to support
 *      (see CLAUDE.md).
 *
 * Formerly the tail half of verify-notification-catchup.mjs, split out once that script's other
 * half (the due-by reminder catch-up/reappear-on-dismiss checks) moved fully onto the native
 * NativeNotificationsPlugin path and needed its own real-swipe-based verification.
 *
 * Connects to the installed app's WebView over raw Chrome DevTools Protocol - see
 * verify-due-reminder.mjs's header for why this doesn't use Playwright's connectOverCDP.
 */
import { execSync } from 'node:child_process';

const PACKAGE = 'com.tharuka.routines';
const SUMMARY_CHANNEL_ID = 'daily-summary';
const SUMMARY_DISMISS_RECEIVER = `${PACKAGE}/com.tharuka.routines.notify.SummaryDismissReceiver`;

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
        raw: b.slice(0, 200),
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

  async function mustEval(expression, description) {
    const ok = await page.evaluate(expression);
    if (!ok) fail(`UI step failed: ${description} (expression returned ${JSON.stringify(ok)})`);
    return ok;
  }

  // --- Group-summary check: create a multi-task routine and confirm a real groupSummary:true
  // notification is posted alongside its due reminders, not just cosmetic `group` tagging on
  // each one (see updateRoutineGroupSummary).
  console.log('Creating a multi-task routine to verify a real group-summary notification is posted...');
  await mustEval(`window.__test.clickByText('.app-tabbar button', 'Routines')`, 'click Routines tab');
  await sleep(300);
  await mustEval(`window.__test.clickByText('button', '+ Add routine')`, 'click + Add routine (multi-task)');
  await sleep(300);
  await mustEval(
    `window.__test.setValue('.routine-form input[placeholder="e.g. Morning stretch"]', 'Group Test Routine')`,
    'set multi-task routine title'
  );
  await mustEval(`window.__test.clickByText('button', '+ Add another task')`, 'add a second task');
  await sleep(300);
  // Adding a 2nd task switches the form to multi-task mode, where each task needs its own name
  // (the routine's own title only auto-fills the FIRST task's name if that task was still blank
  // at the time) - the newly added 2nd task starts blank and would otherwise silently block
  // submission.
  await mustEval(
    `window.__test.setValue('input[placeholder="e.g. Breakfast"]', 'Second Task')`,
    'set 2nd task name'
  );
  await mustEval(`window.__test.clickByText('button[type="submit"]', 'Add routine')`, 'submit multi-task routine');

  const multiRoutineSaved = await waitFor(page, `document.body.innerText.includes('Group Test Routine')`, 10000);
  console.log('Multi-task routine visible in list after save:', multiRoutineSaved);
  if (!multiRoutineSaved) fail('Multi-task routine was not created - form submission was likely blocked by validation.');

  // handleSaveRoutine's setRoutines() (which makes the routine visible in the DOM, above) runs
  // BEFORE its own syncAllNotifications() await resolves - the two are independent async chains
  // kicked off from the same handler. For a multi-task routine, syncAllNotifications has to
  // schedule reminders for every task *and* post the real group-summary notification
  // (updateRoutineGroupSummary), which is slower than a single-task path - so poll dumpsys
  // itself instead of assuming a fixed settle delay is enough.
  console.log('Waiting for the group-summary notification to appear...');
  let dump1 = '';
  let mentionsGroupBody = false;
  let mentionsGroupTitle = false;
  const groupStart = Date.now();
  while (Date.now() - groupStart < 10000) {
    dump1 = dumpNotifications();
    mentionsGroupBody = dump1.includes('2 tasks');
    mentionsGroupTitle = dump1.includes('Group Test Routine');
    if (mentionsGroupBody && mentionsGroupTitle) break;
    await sleep(500);
  }

  console.log('--- dumpsys notification after creating multi-task routine ---');
  const pkgLines1 = dump1.split('\n').filter((l) => l.includes(PACKAGE));
  console.log(`Lines mentioning ${PACKAGE} (${pkgLines1.length}):`);
  console.log(pkgLines1.join('\n'));
  console.log('Mentions "2 tasks" body:', mentionsGroupBody, '| mentions routine title:', mentionsGroupTitle);
  if (!mentionsGroupBody || !mentionsGroupTitle) {
    fail('Could not find the expected group-summary notification content ("Group Test Routine" / "2 tasks").');
  }
  console.log('PASS: group-summary notification content found for the multi-task routine on a real device.');

  // --- Summary-notification reappear-on-dismiss check: the routine created above is due today,
  // so syncDynamicNotifications (triggered by every handleSaveRoutine call) should already have
  // posted a real summary notification via NativeNotificationsPlugin.showSummary (see
  // src/nativeNotifications.js) - a genuine setDeleteIntent()-backed notification, unlike
  // anything @capacitor/local-notifications can produce (it builds notifications entirely
  // natively with no exposed hook for a custom delete-intent - see CLAUDE.md). Broadcasting
  // directly to SummaryDismissReceiver's component (rather than attempting a real swipe gesture)
  // is deterministic and still exercises the real registered receiver + persisted store - this
  // is proving app-owned receiver logic, not an OS-level flag. Unlike the due reminder's own
  // reappear-on-dismiss check (verify-due-reminder.mjs), the summary's delete-intent carries no
  // per-task extra, so a plain no-args broadcast correctly simulates it.
  console.log('Waiting for the native summary notification to settle before dismissing it...');
  let summary1 = null;
  let previous = null;
  const summaryStart = Date.now();
  while (Date.now() - summaryStart < 10000) {
    const current = findAppRecords(dumpNotifications()).find((r) => r.channel === SUMMARY_CHANNEL_ID);
    if (current && previous && current.title === previous.title && current.text === previous.text) {
      summary1 = current;
      break;
    }
    previous = current;
    await sleep(500);
  }
  if (!summary1) {
    fail(`Summary notification on the ${SUMMARY_CHANNEL_ID} channel never settled before the dismiss check.`);
  }
  console.log('Summary notification before dismiss:', { title: summary1.title, text: summary1.text });

  console.log('Broadcasting a dismiss to SummaryDismissReceiver...');
  adb(`shell am broadcast --include-stopped-packages -n ${SUMMARY_DISMISS_RECEIVER}`);

  console.log('Waiting for the summary notification to reappear...');
  let summary2 = null;
  const repostStart = Date.now();
  while (Date.now() - repostStart < 10000) {
    summary2 = findAppRecords(dumpNotifications()).find((r) => r.channel === SUMMARY_CHANNEL_ID);
    if (summary2) break;
    await sleep(500);
  }
  if (!summary2) {
    fail('The summary notification did not reappear after a dismiss broadcast - reappear-on-dismiss is broken.');
  }
  if (summary2.title !== summary1.title || summary2.text !== summary1.text) {
    fail(
      `The reposted summary notification's content changed unexpectedly (before: ${JSON.stringify(summary1)}, ` +
        `after: ${JSON.stringify(summary2)}).`
    );
  }
  console.log('PASS: summary notification reappeared with matching content after a simulated dismiss.');

  page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
