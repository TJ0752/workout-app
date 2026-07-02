package com.tharuka.routines;

import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import com.tharuka.routines.shared.workout.SharedInfo;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.d("MainActivity", "Linked shared module: " + SharedInfo.MODULE_NAME);
    }
}
