package com.tharuka.redlight

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher

/**
 * A red-only screen flashlight.
 *
 * - OFF: black screen with dim red controls; one tap on the big button turns the light on.
 * - ON: the whole screen is pure red, every touch on it is swallowed, and Back is blocked.
 *   The only things that respond are:
 *     - the OFF button, which needs a double tap (two taps within [DOUBLE_TAP_WINDOW_MS]);
 *     - the brightness slider, which stays locked until its lock button is held for
 *       [UNLOCK_HOLD_MS], and re-locks itself [RELOCK_AFTER_MS] after the last adjustment.
 */
class MainActivity : Activity() {

    private companion object {
        const val PREFS = "red_light"
        const val KEY_BRIGHTNESS = "brightness"
        const val MIN_BRIGHTNESS = 0.01f
        const val DOUBLE_TAP_WINDOW_MS = 400L
        const val UNLOCK_HOLD_MS = 800L
        const val RELOCK_AFTER_MS = 4000L

        const val RED = 0xFFFF0000.toInt()
        const val DARK_RED = 0xFF5A0000.toInt()
        const val MID_RED = 0xFFB00000.toInt()
        const val PANEL_ON = 0x66000000 // translucent black over the red screen
        const val PANEL_OFF = 0xFF1A0000.toInt()
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout
    private lateinit var powerButton: Button
    private lateinit var hint: TextView
    private lateinit var panel: LinearLayout
    private lateinit var lockButton: Button
    private lateinit var slider: SeekBar
    private lateinit var percentLabel: TextView

    private var isOn = false
    private var unlocked = false
    private var lastOffTap = 0L
    private var brightness = 1f
    private var backCallback: Any? = null

    private val relock = Runnable { setUnlocked(false) }
    private val unlockAfterHold = Runnable { setUnlocked(true) }
    private val clearTapAgain = Runnable { if (isOn) hint.text = "Double-tap to turn off" }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        brightness = getSharedPreferences(PREFS, MODE_PRIVATE)
            .getFloat(KEY_BRIGHTNESS, 1f).coerceIn(MIN_BRIGHTNESS, 1f)
        buildUi()
        setContentView(root)
        applyBrightness()
        render()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    // ---------------------------------------------------------------- UI

    @SuppressLint("ClickableViewAccessibility")
    private fun buildUi() {
        root = FrameLayout(this).apply {
            // Swallow every touch that lands on the background itself.
            setOnTouchListener { _, _ -> true }
            setOnApplyWindowInsetsListener { v, insets ->
                val bottom: Int
                val top: Int
                if (Build.VERSION.SDK_INT >= 30) {
                    val i = insets.getInsetsIgnoringVisibility(
                        WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
                    )
                    top = i.top; bottom = i.bottom
                } else {
                    @Suppress("DEPRECATION")
                    top = insets.systemWindowInsetTop
                    @Suppress("DEPRECATION")
                    bottom = insets.systemWindowInsetBottom
                }
                v.setPadding(0, top, 0, bottom)
                insets
            }
        }

        powerButton = Button(this).apply {
            textSize = 22f
            typeface = Typeface.DEFAULT_BOLD
            isAllCaps = false
            stateListAnimator = null
            setOnClickListener { onPowerTapped() }
        }
        hint = TextView(this).apply {
            textSize = 15f
            gravity = Gravity.CENTER
        }
        val center = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            addView(powerButton, LinearLayout.LayoutParams(dp(220), dp(220)))
            addView(hint, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(16) })
        }
        root.addView(center, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER
        ))

        lockButton = Button(this).apply {
            textSize = 14f
            isAllCaps = false
            stateListAnimator = null
            setOnTouchListener { _, e ->
                when (e.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        if (unlocked) setUnlocked(false)
                        else handler.postDelayed(unlockAfterHold, UNLOCK_HOLD_MS)
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
                        handler.removeCallbacks(unlockAfterHold)
                }
                true
            }
        }
        percentLabel = TextView(this).apply {
            textSize = 15f
            gravity = Gravity.END
            typeface = Typeface.DEFAULT_BOLD
        }
        slider = SeekBar(this).apply {
            max = 100
            progress = toProgress(brightness)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar, p: Int, fromUser: Boolean) {
                    if (!fromUser) return
                    brightness = fromProgress(p)
                    applyBrightness()
                    updatePercent()
                    scheduleRelock()
                }
                override fun onStartTrackingTouch(sb: SeekBar) = handler.removeCallbacks(relock)
                override fun onStopTrackingTouch(sb: SeekBar) {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putFloat(KEY_BRIGHTNESS, brightness).apply()
                    scheduleRelock()
                }
            })
        }
        val topRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(lockButton, LinearLayout.LayoutParams(0, dp(52), 1f))
            addView(percentLabel, LinearLayout.LayoutParams(dp(72), ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(16))
            addView(topRow)
            addView(slider, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48)
            ).apply { topMargin = dp(8) })
        }
        root.addView(panel, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM
        ).apply { setMargins(dp(12), 0, dp(12), dp(12)) })
    }

    private fun render() {
        root.setBackgroundColor(if (isOn) RED else Color.BLACK)
        powerButton.text = if (isOn) "OFF" else "ON"
        powerButton.setTextColor(if (isOn) RED else Color.BLACK)
        powerButton.background = circle(if (isOn) DARK_RED else MID_RED)
        hint.setTextColor(if (isOn) Color.BLACK else MID_RED)
        hint.text = if (isOn) "Double-tap to turn off" else "Tap to turn on"
        panel.background = rounded(if (isOn) PANEL_ON else PANEL_OFF)
        percentLabel.setTextColor(if (isOn) RED else MID_RED)
        renderLock()
        updatePercent()
    }

    private fun renderLock() {
        val fg = if (isOn) RED else MID_RED
        lockButton.text = if (unlocked) "Brightness unlocked - tap to lock"
                          else "Hold to unlock brightness"
        lockButton.setTextColor(if (unlocked) Color.BLACK else fg)
        lockButton.background = rounded(if (unlocked) fg else Color.TRANSPARENT, strokeColor = fg)
        slider.isEnabled = unlocked
        slider.alpha = if (unlocked) 1f else 0.35f
        val tint = android.content.res.ColorStateList.valueOf(fg)
        slider.progressTintList = tint
        slider.thumbTintList = tint
        slider.progressBackgroundTintList = tint
    }

    private fun updatePercent() {
        percentLabel.text = "${(brightness * 100).toInt().coerceAtLeast(1)}%"
    }

    // ---------------------------------------------------------------- behaviour

    private fun onPowerTapped() {
        if (!isOn) {
            setOn(true)
            return
        }
        val now = SystemClock.uptimeMillis()
        if (now - lastOffTap <= DOUBLE_TAP_WINDOW_MS) {
            lastOffTap = 0L
            setOn(false)
        } else {
            lastOffTap = now
            hint.text = "Tap again to turn off"
            handler.removeCallbacks(clearTapAgain)
            handler.postDelayed(clearTapAgain, DOUBLE_TAP_WINDOW_MS + 600)
        }
    }

    private fun setOn(on: Boolean) {
        isOn = on
        lastOffTap = 0L
        handler.removeCallbacks(clearTapAgain)
        setUnlocked(false)
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        updateBackBlocking()
        render()
    }

    private fun setUnlocked(value: Boolean) {
        unlocked = value
        handler.removeCallbacks(relock)
        handler.removeCallbacks(unlockAfterHold)
        if (value) scheduleRelock()
        renderLock()
    }

    private fun scheduleRelock() {
        handler.removeCallbacks(relock)
        handler.postDelayed(relock, RELOCK_AFTER_MS)
    }

    private fun applyBrightness() {
        window.attributes = window.attributes.apply { screenBrightness = brightness }
    }

    private fun toProgress(b: Float) = (b * 100).toInt().coerceIn(1, 100)
    private fun fromProgress(p: Int) = (p / 100f).coerceIn(MIN_BRIGHTNESS, 1f)

    // Back is ignored while the light is on, so a stray swipe can't close it.
    private fun updateBackBlocking() {
        if (Build.VERSION.SDK_INT < 33) return
        val dispatcher = onBackInvokedDispatcher
        if (isOn && backCallback == null) {
            val cb = OnBackInvokedCallback { /* swallow */ }
            dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb)
            backCallback = cb
        } else if (!isOn && backCallback != null) {
            dispatcher.unregisterOnBackInvokedCallback(backCallback as OnBackInvokedCallback)
            backCallback = null
        }
    }

    @Deprecated("Needed for API < 33")
    override fun onBackPressed() {
        if (isOn) return
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        }
    }

    // ---------------------------------------------------------------- helpers

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun circle(color: Int) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
    }

    private fun rounded(color: Int, strokeColor: Int? = null) = GradientDrawable().apply {
        cornerRadius = dp(16).toFloat()
        setColor(color)
        if (strokeColor != null) setStroke(dp(2), strokeColor)
    }
}
