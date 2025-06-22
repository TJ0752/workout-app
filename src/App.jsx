import { useRef, useState, useEffect } from 'react'; // Add useRef here too

const say = (text) => {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onend = () => {
    console.log("Speech finished");
    // You can put other actions here if needed
  };
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
const spokenNextUpRef = useRef(false); // ✅ Declare outside useEffect

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
      setCountdown(countdown - 1);
    }, 1000);
  } else if (isRunning && countdown === 0) {
    const nextIndex = currentIndex + 1;

    if (!isResting) {
      // 🔊 Announce upcoming rest phase
      const restTime = workoutPlan[currentIndex]?.rest || 0;
      if (restTime > 0) {
        say(`Rest for ${restTime} seconds`);
        setTimeout(() => say("3"), 1000);
        setTimeout(() => say("2"), 2000);
        setTimeout(() => say("1"), 3000);
      }

      setIsResting(true);
      setCountdown(restTime);
    } else {
      // 🔊 Announce next exercise phase
      if (nextIndex < workoutPlan.length) {
        const next = workoutPlan[nextIndex];
        say(`Exercise for ${next.duration} seconds`);
        setTimeout(() => say("3"), 1000);
        setTimeout(() => say("2"), 2000);
        setTimeout(() => say("1"), 3000);

        setIsResting(false);
        setCurrentIndex(nextIndex);
        setCountdown(next.duration);
      } else {
        say("Workout complete! Great job!");
        setIsRunning(false);
        setCurrentIndex(0);
      }
    }
  }

  return () => clearTimeout(timer);
}, [isRunning, countdown, isResting, currentIndex, workoutPlan]);



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
      spokenNextUpRef.current = false; // ✅ Reset when rest ends

      const nextIndex = currentIndex + 1;
      if (nextIndex < workoutPlan.length) {
        setCurrentIndex(nextIndex);
        setCountdown(workoutPlan[nextIndex].duration);
      } else {
  say("Workout complete! Great job!");
  setIsRunning(false);
  setCurrentIndex(0);
  setCountdown(0); // You could keep a 5-second cooldown if you like
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
