import { describe, expect, it } from 'vitest';
import { parseAiImportText } from './aiImport.js';

function workoutJson(exercises) {
  return JSON.stringify({
    routines: [
      {
        title: 'Superset Import Test',
        tasks: [{ completionType: 'workout', exercises }],
      },
    ],
  });
}

describe('parseAiImportText - superset import', () => {
  it('links a contiguous run sharing the same supersetGroup label', () => {
    const { results } = parseAiImportText(
      workoutJson([
        { name: 'Bench Press', supersetGroup: 'A' },
        { name: 'Squat', supersetGroup: 'A' },
        { name: 'Row' },
      ])
    );
    const exercises = results[0].tasks[0].exercises;
    expect(exercises[0].supersetGroupId).not.toBeNull();
    expect(exercises[0].supersetGroupId).toBe(exercises[1].supersetGroupId);
    expect(exercises[2].supersetGroupId).toBeNull();
  });

  it('leaves an exercise ungrouped when supersetGroup is omitted', () => {
    const { results } = parseAiImportText(workoutJson([{ name: 'Bench Press' }, { name: 'Squat' }]));
    const exercises = results[0].tasks[0].exercises;
    expect(exercises[0].supersetGroupId).toBeNull();
    expect(exercises[1].supersetGroupId).toBeNull();
  });

  it('links a 3-member contiguous run into one group', () => {
    const { results } = parseAiImportText(
      workoutJson([
        { name: 'Bench Press', supersetGroup: 'A' },
        { name: 'Squat', supersetGroup: 'A' },
        { name: 'Row', supersetGroup: 'A' },
      ])
    );
    const exercises = results[0].tasks[0].exercises;
    const groupId = exercises[0].supersetGroupId;
    expect(groupId).not.toBeNull();
    expect(exercises.every((e) => e.supersetGroupId === groupId)).toBe(true);
  });

  it('does not merge non-adjacent exercises sharing the same label, and notes it', () => {
    const { results, notes } = parseAiImportText(
      workoutJson([
        { name: 'Bench Press', supersetGroup: 'A' },
        { name: 'Squat', supersetGroup: 'A' },
        { name: 'Row' },
        { name: 'Deadlift', supersetGroup: 'A' },
      ])
    );
    const exercises = results[0].tasks[0].exercises;
    expect(exercises[0].supersetGroupId).toBe(exercises[1].supersetGroupId);
    expect(exercises[0].supersetGroupId).not.toBeNull();
    // The later, non-adjacent reuse of "A" is left ungrouped rather than silently merged.
    expect(exercises[3].supersetGroupId).toBeNull();
    expect(notes.some((n) => n.includes('supersetGroup "A"'))).toBe(true);
  });

  it('does not group a lone exercise carrying a label with no adjacent match', () => {
    const { results } = parseAiImportText(workoutJson([{ name: 'Bench Press', supersetGroup: 'A' }]));
    expect(results[0].tasks[0].exercises[0].supersetGroupId).toBeNull();
  });
});
