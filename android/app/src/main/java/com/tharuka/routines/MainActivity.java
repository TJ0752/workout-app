package com.tharuka.routines;

import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import com.tharuka.routines.notify.NativeNotificationsPlugin;
import com.tharuka.routines.shared.workout.SharedInfo;
import com.tharuka.routines.workout.WorkoutSessionPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WorkoutSessionPlugin.class);
        registerPlugin(NativeNotificationsPlugin.class);
        super.onCreate(savedInstanceState);
        Log.d("MainActivity", "Linked shared module: " + SharedInfo.MODULE_NAME);
    }
}
