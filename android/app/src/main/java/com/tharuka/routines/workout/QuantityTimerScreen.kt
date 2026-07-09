@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.tharuka.routines.workout

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The "pure timer" counterpart of WorkoutSessionScreen - launched by the same
 * WorkoutSessionActivity/WorkoutTimerService/WorkoutSessionPlugin infrastructure (see that
 * Activity's pureTimer branch) for a quantity task set up as a timer (RoutineForm's quantity
 * "Input as: Timer" mode). Deliberately just a TopAppBar plus the shared DurationTimer - no
 * exercise chips, PR/volume stats bar, or weight field, since none of that applies to a plain
 * quantity target. Reusing the real workout session's native host (not a plain in-WebView JS
 * timer) is what lets this survive backgrounding/screen-lock and run for a long time via the
 * same foreground service + chronometer notification a real workout gets - a setInterval inside
 * the WebView would be throttled/suspended the moment the app backgrounds.
 */
@Composable
fun QuantityTimerScreen(
    taskTitle: String,
    targetSeconds: Int,
    initialSeconds: Int?,
    onLog: (Int) -> Unit,
    onClose: () -> Unit,
) {
    Scaffold(
        containerColor = AppPalette.Background,
        topBar = {
            TopAppBar(
                title = { Text(taskTitle, fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton(onClick = onClose) { Text("✕", fontSize = 18.sp) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = AppPalette.Background),
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize().padding(horizontal = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            DurationTimer(targetSeconds = targetSeconds, initialSeconds = initialSeconds, onLog = onLog)
        }
    }
}
