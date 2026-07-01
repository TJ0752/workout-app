import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

const CHANNEL_ID = 'routine-reminders';

function hashToInt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 1000000;
}

function notificationIdFor(routineId, weekday) {
  return hashToInt(routineId) * 10 + weekday;
}

export async function initNotifications() {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      await LocalNotifications.requestPermissions();
    }
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Routine reminders',
      importance: 4,
      visibility: 1,
    });
    return true;
  } catch (err) {
    console.warn('Notification init failed', err);
    return false;
  }
}

export async function cancelRoutineNotifications(routine) {
  if (!Capacitor.isNativePlatform()) return;
  const ids = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    id: notificationIdFor(routine.id, day),
  }));
  try {
    await LocalNotifications.cancel({ notifications: ids });
  } catch (err) {
    console.warn('Failed to cancel notifications', err);
  }
}

export async function scheduleRoutineNotifications(routine) {
  if (!Capacitor.isNativePlatform()) return;
  await cancelRoutineNotifications(routine);
  if (!routine.active || routine.days.length === 0) return;

  const [hour, minute] = routine.time.split(':').map(Number);
  const notifications = routine.days.map((day) => ({
    id: notificationIdFor(routine.id, day),
    title: routine.title,
    body: routine.notes || 'Time to complete your routine',
    channelId: CHANNEL_ID,
    schedule: {
      on: { weekday: day + 1, hour, minute },
      allowWhileIdle: true,
    },
  }));

  try {
    await LocalNotifications.schedule({ notifications });
  } catch (err) {
    console.warn('Failed to schedule notifications', err);
  }
}

export async function syncAllNotifications(routines) {
  if (!Capacitor.isNativePlatform()) return;
  for (const routine of routines) {
    await scheduleRoutineNotifications(routine);
  }
}
