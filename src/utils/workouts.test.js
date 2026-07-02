import { describe, expect, it } from 'vitest';
import {
  computeSessionFraction,
  getExercisePR,
  getExerciseVolume,
  getWorkoutSessionHistory,
  getWorkoutStats,
} from './workouts.js';

function set(overrides = {}) {
  return { completed: true, reps: 10, weight: 20, ...overrides };
}

describe('computeSessionFraction', () => {
  it('returns 0 when there are no exercises', () => {
    expect(computeSessionFraction([], {})).toBe(0);
    expect(computeSessionFraction(undefined, {})).toBe(0);
  });

  it('is completed sets / planned sets across all exercises', () => {
    const exercises = [
      { id: 'e1', targetSets: 3 },
      { id: 'e2', targetSets: 2 },
    ];
    const logs = {
      e1: [set(), set(), set({ completed: false })], // 2/3 completed
      e2: [set()], // 1/2 completed (only one set logged)
    };
    // planned = 3 + 2 = 5, completed = 2 + 1 = 3
    expect(computeSessionFraction(exercises, logs)).toBeCloseTo(0.6);
  });

  it('treats a missing/zero targetSets as needing at least 1 set (never divides by zero)', () => {
    const exercises = [{ id: 'e1', targetSets: 0 }];
    const logs = { e1: [set()] };
    expect(computeSessionFraction(exercises, logs)).toBe(1);
  });

  it('clamps to 1 when more sets are logged/completed than planned', () => {
    const exercises = [{ id: 'e1', targetSets: 2 }];
    const logs = { e1: [set(), set(), set(), set()] }; // 4 completed sets vs 2 planned
    expect(computeSessionFraction(exercises, logs)).toBe(1);
  });

  it('treats an exercise with no logged sets yet as 0 contribution, not an error', () => {
    const exercises = [{ id: 'e1', targetSets: 2 }];
    expect(computeSessionFraction(exercises, {})).toBe(0);
  });
});

describe('getExerciseVolume', () => {
  it('sums reps * weight for completed sets only', () => {
    const logs = [set({ reps: 10, weight: 20 }), set({ reps: 8, weight: 25 }), set({ completed: false, reps: 100, weight: 100 })];
    expect(getExerciseVolume(logs)).toBe(10 * 20 + 8 * 25);
  });

  it('excludes duration-based sets that have no weight', () => {
    const logs = [set({ reps: 10, weight: undefined }), set({ reps: undefined, weight: 20 })];
    expect(getExerciseVolume(logs)).toBe(0);
  });

  it('returns 0 for empty/missing logs', () => {
    expect(getExerciseVolume([])).toBe(0);
    expect(getExerciseVolume(undefined)).toBe(0);
  });
});

describe('getExercisePR', () => {
  it('picks the set with the highest completed weight', () => {
    const logs = [set({ weight: 20, reps: 10 }), set({ weight: 40, reps: 5 }), set({ weight: 30, reps: 8 })];
    expect(getExercisePR(logs).weight).toBe(40);
  });

  it('ties on weight are broken by higher reps', () => {
    const logs = [set({ weight: 40, reps: 5 }), set({ weight: 40, reps: 8 })];
    expect(getExercisePR(logs).reps).toBe(8);
  });

  it('ignores incomplete sets and sets with no weight', () => {
    const logs = [set({ weight: 100, completed: false }), set({ weight: undefined, reps: 999 })];
    expect(getExercisePR(logs)).toBeNull();
  });

  it('returns null for empty/missing logs', () => {
    expect(getExercisePR([])).toBeNull();
    expect(getExercisePR(undefined)).toBeNull();
  });
});

describe('getWorkoutSessionHistory', () => {
  it('regroups per-date logs into sessions, most recent first, respecting the limit', () => {
    const logsForTaskByDate = {
      '2026-07-01': { e1: [set()] },
      '2026-07-03': { e1: [set(), set({ completed: false })] },
      '2026-07-02': { e1: [set()] },
    };
    const history = getWorkoutSessionHistory(logsForTaskByDate, 2);
    expect(history).toHaveLength(2);
    expect(history[0].date).toBe('2026-07-03');
    expect(history[0].completedSets).toBe(1);
    expect(history[0].totalSets).toBe(2);
    expect(history[1].date).toBe('2026-07-02');
  });

  it('computes volume per session across all exercises', () => {
    const logsForTaskByDate = {
      '2026-07-01': {
        e1: [set({ reps: 10, weight: 20 })],
        e2: [set({ reps: 5, weight: 10 })],
      },
    };
    const history = getWorkoutSessionHistory(logsForTaskByDate);
    expect(history[0].volume).toBe(10 * 20 + 5 * 10);
  });

  it('returns an empty array for no logs', () => {
    expect(getWorkoutSessionHistory({})).toEqual([]);
    expect(getWorkoutSessionHistory(undefined)).toEqual([]);
  });
});

describe('getWorkoutStats', () => {
  it('aggregates PR/volume/setsLogged per exercise across all logged dates', () => {
    const task = {
      id: 'workout-task',
      exercises: [{ id: 'e1', name: 'Bench' }],
    };
    const logsForTask = {
      '2026-07-01': { e1: [set({ weight: 20, reps: 10 })] },
      '2026-07-02': { e1: [set({ weight: 30, reps: 8 }), set({ completed: false, weight: 100 })] },
    };
    const stats = getWorkoutStats(task, logsForTask);
    expect(stats.byExercise.e1.pr.weight).toBe(30);
    expect(stats.byExercise.e1.volume).toBe(20 * 10 + 30 * 8);
    expect(stats.byExercise.e1.setsLogged).toBe(2);
    expect(stats.recentSessions).toHaveLength(2);
  });

  it('handles a task with no exercises or no logs yet', () => {
    const stats = getWorkoutStats({ id: 't', exercises: [] }, undefined);
    expect(stats.byExercise).toEqual({});
    expect(stats.recentSessions).toEqual([]);
  });
});
