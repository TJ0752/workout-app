import { describe, expect, it } from 'vitest';
import {
  computeSessionFraction,
  getExercisePR,
  getExerciseVolume,
  getWorkoutSessionHistory,
  getWorkoutStats,
  epley1RM,
  getExerciseE1RM,
  getExerciseRepPR,
  getExerciseTotalReps,
  getExerciseDurationPR,
  getExerciseTotalDuration,
  getExerciseSessionSeries,
  getSessionMixByWeek,
  getFitnessOverview,
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

  it('adds the adaptive bodyweight/duration metrics alongside the existing weighted ones', () => {
    const task = { id: 't', exercises: [{ id: 'pushups', name: 'Push-ups' }] };
    const logsForTask = {
      '2026-07-01': { pushups: [set({ weight: undefined, reps: 20 })] },
      '2026-07-02': { pushups: [set({ weight: undefined, reps: 25 })] },
    };
    const stats = getWorkoutStats(task, logsForTask);
    expect(stats.byExercise.pushups.isWeighted).toBe(false);
    expect(stats.byExercise.pushups.repPR.reps).toBe(25);
    expect(stats.byExercise.pushups.totalReps).toBe(45);
    expect(stats.byExercise.pushups.pr).toBeNull(); // no weight ever logged
    expect(stats.byExercise.pushups.series).toHaveLength(2);
  });
});

describe('epley1RM', () => {
  it('estimates a 1-rep max from weight x reps (Epley: weight * (1 + reps/30))', () => {
    expect(epley1RM(100, 1)).toBeCloseTo(100 * (1 + 1 / 30));
    expect(epley1RM(60, 8)).toBeCloseTo(60 * (1 + 8 / 30));
  });

  it('returns 0 for missing weight or reps', () => {
    expect(epley1RM(0, 8)).toBe(0);
    expect(epley1RM(60, 0)).toBe(0);
  });
});

describe('getExerciseE1RM', () => {
  it('picks the set with the highest estimated 1RM, which can differ from the raw top weight', () => {
    // 100kg x 1 -> e1RM ~103.3. 85kg x 8 -> e1RM ~107.7, higher despite less raw weight.
    const logs = [set({ weight: 100, reps: 1 }), set({ weight: 85, reps: 8 })];
    const best = getExerciseE1RM(logs);
    expect(best.weight).toBe(85);
    expect(best.reps).toBe(8);
  });

  it('ignores incomplete sets and sets missing weight or reps', () => {
    const logs = [set({ weight: 100, completed: false }), set({ weight: undefined, reps: 10 })];
    expect(getExerciseE1RM(logs)).toBeNull();
  });

  it('returns null for empty/missing logs', () => {
    expect(getExerciseE1RM([])).toBeNull();
    expect(getExerciseE1RM(undefined)).toBeNull();
  });
});

describe('getExerciseRepPR/getExerciseTotalReps (bodyweight)', () => {
  it('finds the most reps in a single completed set with no weight', () => {
    const logs = [set({ weight: undefined, reps: 20 }), set({ weight: undefined, reps: 30 }), set({ weight: undefined, reps: 25 })];
    expect(getExerciseRepPR(logs).reps).toBe(30);
    expect(getExerciseTotalReps(logs)).toBe(75);
  });

  it('excludes weighted sets from the bodyweight rep PR/total', () => {
    const logs = [set({ weight: 20, reps: 999 }), set({ weight: undefined, reps: 15 })];
    expect(getExerciseRepPR(logs).reps).toBe(15);
    expect(getExerciseTotalReps(logs)).toBe(15);
  });

  it('returns null/0 for empty logs', () => {
    expect(getExerciseRepPR([])).toBeNull();
    expect(getExerciseTotalReps([])).toBe(0);
  });
});

describe('getExerciseDurationPR/getExerciseTotalDuration', () => {
  it('finds the longest hold and sums time under tension', () => {
    const logs = [
      set({ weight: undefined, reps: undefined, durationSeconds: 40 }),
      set({ weight: undefined, reps: undefined, durationSeconds: 70 }),
    ];
    expect(getExerciseDurationPR(logs).durationSeconds).toBe(70);
    expect(getExerciseTotalDuration(logs)).toBe(110);
  });

  it('returns null/0 for empty logs', () => {
    expect(getExerciseDurationPR([])).toBeNull();
    expect(getExerciseTotalDuration([])).toBe(0);
  });
});

describe('getExerciseSessionSeries', () => {
  it('returns one entry per date with completed sets, sorted chronologically', () => {
    const logsForTaskByDate = {
      '2026-07-03': { e1: [set({ weight: 60, reps: 5 })] },
      '2026-07-01': { e1: [set({ weight: 50, reps: 5 })] },
      '2026-07-02': { e1: [] },
    };
    const series = getExerciseSessionSeries(logsForTaskByDate, 'e1');
    expect(series.map((s) => s.date)).toEqual(['2026-07-01', '2026-07-03']);
    expect(series[1].e1rm).toBeCloseTo(epley1RM(60, 5));
  });

  it('returns an empty array when the exercise has no logs', () => {
    expect(getExerciseSessionSeries({}, 'e1')).toEqual([]);
  });
});

describe('getSessionMixByWeek', () => {
  it('classifies each session as weighted or bodyweight and buckets by week', () => {
    const logsForTaskByDate = {
      '2026-06-01': { e1: [set({ weight: 60, reps: 5 })] }, // Monday - weighted
      '2026-06-03': { e1: [set({ weight: undefined, reps: 20 })] }, // Wednesday - bodyweight
      '2026-06-08': { e1: [set({ weight: 60, reps: 5 })] }, // next Monday - weighted
    };
    const mix = getSessionMixByWeek(logsForTaskByDate);
    expect(mix).toHaveLength(2);
    expect(mix[0]).toMatchObject({ weighted: 1, bodyweight: 1, weightedPct: 50 });
    expect(mix[1]).toMatchObject({ weighted: 1, bodyweight: 0, weightedPct: 100 });
  });

  it('a session with both weighted and bodyweight sets counts as weighted', () => {
    const logsForTaskByDate = {
      '2026-06-01': {
        e1: [set({ weight: 60, reps: 5 })],
        e2: [set({ weight: undefined, reps: 20 })],
      },
    };
    const mix = getSessionMixByWeek(logsForTaskByDate);
    expect(mix[0]).toMatchObject({ weighted: 1, bodyweight: 0 });
  });

  it('returns an empty array for no logs', () => {
    expect(getSessionMixByWeek({})).toEqual([]);
  });
});

describe('getFitnessOverview', () => {
  const routines = [
    {
      id: 'r1',
      tasks: [
        {
          id: 'task-a',
          completionType: 'workout',
          exercises: [
            { id: 'bench-a', name: 'Bench Press' },
            { id: 'pushups', name: 'Push-ups' },
          ],
        },
      ],
    },
    {
      id: 'r2',
      tasks: [
        {
          id: 'task-b',
          completionType: 'workout',
          exercises: [{ id: 'bench-b', name: 'Bench Press' }],
        },
      ],
    },
  ];
  const workoutLogsByTask = {
    'task-a': {
      '2026-07-01': {
        'bench-a': [set({ weight: 60, reps: 5 })],
        pushups: [set({ weight: undefined, reps: 20 })],
      },
    },
    'task-b': {
      '2026-07-02': { 'bench-b': [set({ weight: 65, reps: 5 })] },
    },
  };

  it('merges the same-named exercise across different routines/tasks into one entry', () => {
    const overview = getFitnessOverview(routines, workoutLogsByTask);
    const bench = overview.exercises.find((e) => e.name === 'Bench Press');
    expect(bench.pr.weight).toBe(65); // the higher of the two routines' logged sets
    expect(bench.isWeighted).toBe(true);
    expect(bench.series).toHaveLength(2); // one session from each routine's task
  });

  it('picks the adaptive top-PR tiles: weighted from weighted exercises, bodyweight from bodyweight ones', () => {
    const overview = getFitnessOverview(routines, workoutLogsByTask);
    expect(overview.topWeightedPR.name).toBe('Bench Press');
    expect(overview.topRepPR.name).toBe('Push-ups');
    expect(overview.topRepPR.repPR.reps).toBe(20);
    expect(overview.topDurationPR).toBeNull();
  });

  it('never puts a duration-only exercise into topRepPR (regression: repPR is null there, and the UI reads .repPR.reps unconditionally)', () => {
    const plankRoutines = [
      {
        id: 'r1',
        tasks: [{ id: 'task-a', completionType: 'workout', exercises: [{ id: 'plank', name: 'Plank' }] }],
      },
    ];
    const plankLogs = {
      'task-a': {
        '2026-07-01': { plank: [set({ weight: undefined, reps: undefined, durationSeconds: 40 })] },
        '2026-07-02': { plank: [set({ weight: undefined, reps: undefined, durationSeconds: 60 })] },
      },
    };
    const overview = getFitnessOverview(plankRoutines, plankLogs);
    expect(overview.topRepPR).toBeNull();
    expect(overview.topDurationPR.name).toBe('Plank');
    expect(overview.topDurationPR.durationPR.durationSeconds).toBe(60);
  });

  it('sessionMix aggregates across every workout task, not just one', () => {
    const overview = getFitnessOverview(routines, workoutLogsByTask);
    const totalWeighted = overview.sessionMix.reduce((sum, w) => sum + w.weighted, 0);
    const totalBodyweight = overview.sessionMix.reduce((sum, w) => sum + w.bodyweight, 0);
    // task-a's session has both a weighted and bodyweight set -> counts as weighted;
    // task-b's session is weighted too -> 2 weighted sessions, 0 bodyweight-only sessions.
    expect(totalWeighted).toBe(2);
    expect(totalBodyweight).toBe(0);
  });

  it('hasWorkouts is false and PR tiles are null when there are no workout tasks or no logs', () => {
    const overview = getFitnessOverview([{ id: 'r1', tasks: [{ id: 't1', completionType: 'boolean' }] }], {});
    expect(overview.hasWorkouts).toBe(false);
    expect(overview.exercises).toEqual([]);
    expect(overview.topWeightedPR).toBeNull();
    expect(overview.topRepPR).toBeNull();
    expect(overview.topDurationPR).toBeNull();
  });

  it('handles missing routines/logs gracefully', () => {
    expect(getFitnessOverview(undefined, undefined).hasWorkouts).toBe(false);
    expect(getFitnessOverview([], {}).hasWorkouts).toBe(false);
  });
});
