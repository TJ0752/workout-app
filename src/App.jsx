import { useState } from 'react';
import { useEffect } from 'react';

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
    const nextCountdown = countdown - 1;

    // 🔊 Say "Next up: ..." 10 seconds before next exercise (during rest)
    if (isResting && nextCountdown === 10) {
      const next = workoutPlan[currentIndex + 1];
      if (next) say(`Next up: ${next.name}`);
    }

    // 🔊 Countdown 3, 2, 1
    if (nextCountdown <= 3 && nextCountdown > 0) {
      say(nextCountdown.toString());
    }

    setCountdown(nextCountdown);
  }, 1000);
} else if (isRunning && countdown === 0) {
  if (!isResting) {
    setIsResting(true);
    setCountdown(workoutPlan[currentIndex]?.rest || 0);
  } else {
    setIsResting(false);
    const nextIndex = currentIndex + 1;
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
      <h1>Workout Planner</h1>
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
