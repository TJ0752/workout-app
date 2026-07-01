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

function notificationIdFor(taskId, weekday) {
  return hashToInt(taskId) * 10 + weekday;
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

export async function cancelTaskNotifications(task) {
  if (!Capacitor.isNativePlatform()) return;
  const ids = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    id: notificationIdFor(task.id, day),
  }));
  try {
    await LocalNotifications.cancel({ notifications: ids });
  } catch (err) {
    console.warn('Failed to cancel notifications', err);
  }
}

export async function scheduleTaskNotifications(task, routine) {
  if (!Capacitor.isNativePlatform()) return;
  await cancelTaskNotifications(task);
  if (!task.active || task.days.length === 0) return;

  const [hour, minute] = task.time.split(':').map(Number);
  const title = routine && routine.title !== task.title ? `${routine.title} · ${task.title}` : task.title;
  const body = (routine && routine.notes) || 'Time to complete your task';

  const notifications = task.days.map((day) => ({
    id: notificationIdFor(task.id, day),
    title,
    body,
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
    for (const task of routine.tasks) {
      await scheduleTaskNotifications(task, routine);
    }
  }
}
