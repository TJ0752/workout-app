/**
 * Drives the real debug APK on a GitHub Actions Android emulator (see
 * .github/workflows/android-emulator-verify.yml) to prove the
 * catchUpDueReminderIfNeeded fix in src/notifications.js: a task's pinned
 * due-by reminder must survive a second app-wide notification resync (e.g.
 * reopening the app) instead of silently vanishing until the same weekday
 * next week - see the comment on catchUpDueReminderIfNeeded for the root
 * cause this guards against.
 *
 * Connects to the installed app's WebView over Chrome DevTools Protocol
 * (debug builds have WebView debugging enabled) and drives the same UI a
 * person would, then inspects real `adb shell dumpsys notification` output
 * for the actual native notification - this is checking the real Android
 * notification manager state, not just app-level JS logic.
 */
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const PACKAGE = 'com.tharuka.routines';
const CHANNEL_ID = 'routine-reminders';

function adb(cmd) {
  return execSync(`adb ${cmd}`, { encoding: 'utf8' });
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
  // Each notification record block starts with "NotificationRecord(...)" and
  // contains "pkg=<package>" plus a "channel=" and "flags=0x.." line further down.
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

async function main() {
  console.log('Waiting for app to boot...');
  for (let i = 0; i < 30; i++) {
    const pid = adb(`shell pidof ${PACKAGE}`).trim();
    if (pid) break;
    execSync('sleep 1');
  }
  await new Promise((r) => setTimeout(r, 4000)); // let the WebView + JS bundle finish loading

  const socket = findDevtoolsSocket();
  if (!socket) fail('Could not find a WebView devtools socket - is the debug build\'s WebView debugging enabled?');
  console.log('Found devtools socket:', socket);
  adb(`forward tcp:9222 localabstract:${socket}`);

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.waitForEvent('page'));
  await page.waitForSelector('.app-tabbar', { timeout: 20000 });
  console.log('Connected to app WebView.');

  const { hhmm: nowHHMM, weekday } = deviceNow();
  const dueTime = minutesAgo(nowHHMM, 2);
  console.log(`Device time is ${nowHHMM}, weekday ${weekday}. Creating a task due at ${dueTime} (2 min ago).`);

  await page.click('.app-tabbar button:has-text("Routines")');
  await page.waitForTimeout(300);
  await page.click('button:has-text("+ Add routine")');
  await page.waitForTimeout(300);
  await page.fill('.routine-form input[placeholder="e.g. Morning stretch"]', 'Emulator Catchup Test');
  await page.fill('.routine-form input[type="time"] >> nth=1', dueTime); // "Due by" is the 2nd time input (after "Starts at")

  // Ensure today's weekday is selected (defaults to weekdays Mon-Fri; make sure it covers `weekday`)
  const dayButtons = await page.$$('.routine-form .day-buttons .day-chip');
  const dayLabels = await Promise.all(dayButtons.map((b) => b.textContent()));
  const labelOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const targetLabel = labelOrder[weekday];
  const targetIdx = dayLabels.findIndex((l) => l.trim() === targetLabel);
  const targetSelected = await dayButtons[targetIdx].getAttribute('class');
  if (!targetSelected.includes('selected')) {
    await dayButtons[targetIdx].click();
  }

  await page.click('button[type="submit"]:has-text("Add routine")');
  await page.waitForTimeout(2000); // let handleSaveRoutine's syncAllNotifications finish

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
  await page.reload();
  await page.waitForSelector('.app-tabbar', { timeout: 20000 });
  await page.waitForTimeout(3000); // let the mount effect's syncAllNotifications finish

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

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
