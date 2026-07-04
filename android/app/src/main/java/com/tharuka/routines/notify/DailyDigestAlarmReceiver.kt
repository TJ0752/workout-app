package com.tharuka.routines.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Fires when a daily-digest alarm goes off (morning, evening, or streak-risk) - reads the entry
 * from the store (not app memory) so this works with the app process fully dead, posts the
 * notification, and immediately self-reschedules tomorrow's occurrence.
 */
class DailyDigestAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val kind = intent.getStringExtra(EXTRA_DIGEST_KIND) ?: return
        val entry = DailyDigestStore.read(context, kind) ?: return
        val notification = buildDailyDigestNotification(context, entry)
        NotificationManagerCompat.from(context).notify(dailyDigestNotificationId(kind), notification)
        DailyDigestScheduler.arm(context, entry)
    }
}
