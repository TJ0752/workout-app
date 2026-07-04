/**
 * Drives the real debug APK on a GitHub Actions Android emulator (see
 * .github/workflows/android-emulator-verify.yml) to prove the native daily-digest path
 * (android/app/.../notify/DailyDigestScheduler.kt + DailyDigestAlarmReceiver.kt, fronted by
 * NativeNotificationsPlugin.scheduleDailyDigest/cancelDailyDigest) actually behaves as designed
 * on a real device for all 3 kinds it serves - morning, evening, and streak-risk (see CLAUDE.md's
 * "Native notifications" section).
 *
 * Morning/evening are unconditionally (re)scheduled with real computed content on every app
 * load (src/notifications.js's updateMorningDigest/updateEveningDigest, called from
 * syncDynamicNotifications), so this script can just wait for that initial sync to land and then
 * broadcast straight to DailyDigestAlarmReceiver for each kind - the same deterministic
 * broadcast-to-receiver technique verify-group-summary.mjs and verify-extra-reminder.mjs already
 * use, instead of waiting on AlarmManager's own clock.
 *
 * Streak-risk is conditional - it only has a persisted entry when some routine's streak is
 * actually at risk (updateStreakRiskNotification's own math, already covered by the mocked-
 * Capacitor unit tests in src/__tests__/notifications.test.js). Rather than engineering real
 * multi-day streak state through the UI just to exercise the *native* store/scheduler/receiver
 * plumbing (the part this migration actually changed), this script calls
 * `NativeNotifications.scheduleDailyDigest`/`cancelDailyDigest` directly through the WebView's
 * CDP bridge - the exact same plugin calls updateStreakRiskNotification itself makes - to
 * simulate "something's at risk" and then "now resolved." This is a faithful test of the native
 * mechanism without redundantly re-deriving the JS-side streak math a unit test already covers.
 */
import { execSync } from 'node:child_process';

const PACKAGE = 'com.tharuka.routines';
const CHANNEL_ID = 'daily-digest';
const ALARM_RECEIVER = `${PACKAGE}/com.tharuka.routines.notify.DailyDigestAlarmReceiver`;

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
      const channelMatch =
        b.match(/\bchannel=([^\s,)]+)/) || b.match(/channelId=([^\s,)]+)/) || b.match(/mChannelId=([^\s,)]+)/);
      const titleMatch = b.match(/android\.title=String \(([^)]*)\)/);
      const textMatch = b.match(/android\.text=String \(([^)]*)\)/);
      return {
        raw: b.slice(0, 400),
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
    scheduleNativeDigest: async (kind, title, body, hour, minute) => {
      await window.Capacitor.Plugins.NativeNotifications.scheduleDailyDigest({ kind, title, body, hour, minute });
      return true;
    },
    cancelNativeDigest: async (kind) => {
      await window.Capacitor.Plugins.NativeNotifications.cancelDailyDigest({ kind });
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

  // --- Morning/evening: always scheduled with real content on every app load, no setup needed.
  console.log('Waiting for the initial syncDynamicNotifications pass to schedule morning/evening digests...');
  await sleep(3000);

  console.log('Broadcasting kind=morning to DailyDigestAlarmReceiver...');
  adb(`shell am broadcast -n ${ALARM_RECEIVER} --es kind morning`);
  const morning = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === CHANNEL_ID && r.title === 'Good morning'),
    (r) => Boolean(r),
    10000
  );
  if (!morning) {
    console.log(dumpNotifications());
    fail('No "Good morning" notification appeared on the daily-digest channel after firing the morning alarm.');
  }
  console.log('PASS: morning digest fired with real content.', { text: morning.text });

  console.log('Broadcasting kind=evening to DailyDigestAlarmReceiver...');
  adb(`shell am broadcast -n ${ALARM_RECEIVER} --es kind evening`);
  const evening = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === CHANNEL_ID && r.title === 'Evening wrap-up'),
    (r) => Boolean(r),
    10000
  );
  if (!evening) {
    console.log(dumpNotifications());
    fail('No "Evening wrap-up" notification appeared on the daily-digest channel after firing the evening alarm.');
  }
  console.log('PASS: evening digest fired with real content.', { text: evening.text });

  // --- Streak-risk: simulate "at risk" and "now resolved" directly through the same native
  // plugin calls updateStreakRiskNotification itself makes (see file header).
  console.log('Simulating a streak-at-risk state via NativeNotifications.scheduleDailyDigest...');
  await page.evaluate(
    `window.__test.scheduleNativeDigest('streak-risk', 'Your streak is at risk', 'Finish "Test Routine" today to keep your streak alive.', 19, 0)`
  );
  await sleep(500);
  adb(`shell am broadcast -n ${ALARM_RECEIVER} --es kind streak-risk`);
  const atRisk = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === CHANNEL_ID && r.title === 'Your streak is at risk'),
    (r) => Boolean(r),
    10000
  );
  if (!atRisk) {
    console.log(dumpNotifications());
    fail('No streak-risk notification appeared after scheduling+firing it natively.');
  }
  console.log('PASS: streak-risk notification fired via the native alarm receiver.', { text: atRisk.text });

  console.log('Simulating the streak becoming resolved via NativeNotifications.cancelDailyDigest...');
  await page.evaluate(`window.__test.cancelNativeDigest('streak-risk')`);

  const cleared = await pollFor(
    () => findAppRecords(dumpNotifications()).find((r) => r.channel === CHANNEL_ID && r.title === 'Your streak is at risk'),
    (r) => !r,
    10000
  );
  if (cleared) {
    fail('The streak-risk notification was still showing after cancelDailyDigest - the resolved-streak cancel path did not remove it.');
  }
  console.log('PASS: cancelDailyDigest actively removed the shown streak-risk notification.');

  console.log('Re-firing kind=streak-risk after cancellation to confirm the persisted entry was actually cleared (not just the alarm)...');
  adb(`shell am broadcast -n ${ALARM_RECEIVER} --es kind streak-risk`);
  await sleep(2000);
  const repostedAfterCancel = findAppRecords(dumpNotifications()).find(
    (r) => r.channel === CHANNEL_ID && r.title === 'Your streak is at risk'
  );
  if (repostedAfterCancel) {
    fail(
      'Firing the streak-risk alarm after cancelDailyDigest still posted a notification - DailyDigestStore.clear() ' +
        'did not actually remove the persisted entry (DailyDigestAlarmReceiver should have found nothing to read and no-op).'
    );
  }
  console.log('PASS: the persisted streak-risk entry was genuinely cleared, not just its pending alarm.');

  page.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
