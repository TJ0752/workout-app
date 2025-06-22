import { useRef, useState, useEffect } from 'react';

const say = (text) => {
  const utterance = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.speak(utterance);
};

function App() {
  const [exercise, setExercise] = useState('');
  const [duration, setDuration] = useState('');
  const [rest, setRest] = useState('');
  const [workoutPlan, setWorkoutPlan] = useState([]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [isResting, setIsResting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const spokenNextUpRef = useRef(false); // To prevent repeated speech in 1 cycle

  const handleAddExercise = () => {
    const newStep = {
      name: exercise,
      duration: parseInt(duration),
      rest: parseInt(rest),
    };
    setWorkoutPlan([...workoutPlan, newStep]);
    setExercise('');
    setDuration('');
    setRest('');
  };

useEffect(() => {
  let timer;

  if (isRunning && countdown > 0) {
    timer = setTimeout(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);

    // 🟡 Start speaking announcement early enough (e.g., 7s left)
    if (countdown === 7 && !spokenNextUpRef.current) {
      spokenNextUpRef.current = true;

      const nextIndex = isResting ? currentIndex + 1 : currentIndex;
      const isNextRest = !isResting;
      const nextItem = workoutPlan[nextIndex];

      const phrase = isNextRest
        ? `Rest for ${workoutPlan[currentIndex]?.rest} seconds`
        : `Exercise: ${nextItem?.name} for ${nextItem?.duration} seconds`;

      say(phrase);
    }

    // 🔊 Voice countdown synced with timer at 3s, 2s, 1s
    if ([3, 2, 1].includes(countdown)) {
      say(countdown.toString());
    }
  }

  else if (isRunning && countdown === 0) {
    const nextIndex = currentIndex + 1;

    if (!isResting) {
      setIsResting(true);
      spokenNextUpRef.current = false;
      setCountdown(workoutPlan[currentIndex]?.rest || 0);
    } else {
      setIsResting(false);
      spokenNextUpRef.current = false;

      if (nextIndex < workoutPlan.length) {
        setCurrentIndex(nextIndex);
        setCountdown(workoutPlan[nextIndex].duration);
      } else {
        say("Workout complete! Great job!");
        setIsRunning(false);
        setCurrentIndex(0);
      }
    }
  }

  return () => clearTimeout(timer);
}, [isRunning, countdown, isResting, currentIndex, workoutPlan]);


  return (
    <div style={{ padding: '20px', maxWidth: '500px', margin: '0 auto' }}>
      <h1>Workout Planner 🔥</h1>
      <input
        type="text"
        placeholder="Exercise name"
        value={exercise}
        onChange={(e) => setExercise(e.target.value)}
      />
      <input
        type="number"
        placeholder="Duration (sec)"
        value={duration}
        onChange={(e) => setDuration(e.target.value)}
      />
      <input
        type="number"
        placeholder="Rest (sec)"
        value={rest}
        onChange={(e) => setRest(e.target.value)}
      />
      <button onClick={handleAddExercise}>Add</button>

      <h2>Workout Plan</h2>
      <ul>
        {workoutPlan.map((step, index) => (
          <li key={index}>
            <strong>{step.name}</strong> – {step.duration}s + {step.rest}s rest
          </li>
        ))}
      </ul>

      {workoutPlan.length > 0 && !isRunning && (
        <button
          onClick={() => {
            say(`Starting workout. First exercise: ${workoutPlan[0].name} for ${workoutPlan[0].duration} seconds`);
            setIsRunning(true);
            setCurrentIndex(0);
            setIsResting(false);
            setCountdown(workoutPlan[0].duration);
          }}
        >
          Start Workout
        </button>
      )}

      {isRunning && (
        <div style={{ marginTop: '20px' }}>
          <h2>{isResting ? 'Rest' : 'Exercise'} Time</h2>
          <h3>{workoutPlan[currentIndex]?.name || ''}</h3>
          <h1>{countdown}s</h1>
        </div>
      )}
    </div>
  );
}

export default App;
