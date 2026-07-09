import { DurationTimer } from './DurationTimer';

/**
 * The web/dev-loop counterpart of the native "pure timer" flow (QuantityTimerScreen.kt) - a
 * quantity task set up as a timer (RoutineForm's "Input as: Timer" mode), reusing the exact same
 * DurationTimer widget the workout session's duration exercises use, with none of the
 * weight/reps/exercise-nav chrome around it. Only ever reached via `npm run dev` in a browser,
 * same as WorkoutSessionView - on a real device this task type launches the native screen instead
 * (see nativeWorkoutSession.js's startNativeQuantityTimer), specifically so a long-running timer
 * survives backgrounding via a real foreground service rather than a WebView setInterval that
 * Android would throttle/suspend.
 */
export default function QuantityTimerView({ task, onLog, onClose }) {
  return (
    <div className="workout-session">
      <div className="workout-session-header">
        <span className="workout-session-title">{task.title}</span>
        <button type="button" className="workout-session-close" onClick={onClose} aria-label="Close">
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <div className="workout-set-panel">
        <DurationTimer targetSeconds={Number(task.target) || 0} initialSeconds={null} onLog={onLog} />
      </div>
    </div>
  );
}
