package com.tharuka.routines;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import com.tharuka.routines.notify.NativeNotificationsPlugin;
import com.tharuka.routines.notify.NotificationTapBridgeKt;
import com.tharuka.routines.shared.workout.SharedInfo;
import com.tharuka.routines.update.UpdateInstallerPlugin;
import com.tharuka.routines.workout.WorkoutSessionPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WorkoutSessionPlugin.class);
        registerPlugin(NativeNotificationsPlugin.class);
        registerPlugin(UpdateInstallerPlugin.class);
        super.onCreate(savedInstanceState);
        Log.d("MainActivity", "Linked shared module: " + SharedInfo.MODULE_NAME);
    }

    /**
     * Warm-start deep-link case: MainActivity is declared singleTask, so tapping a notification
     * while the app process is already alive delivers here instead of a fresh onCreate(). The
     * cold-start case is handled separately, by NativeNotificationsPlugin.load() reading
     * getIntent()'s extras directly once the bridge is ready.
     */
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NotificationTapBridgeKt.dispatchNotificationTapFromIntent(intent);
    }
}
