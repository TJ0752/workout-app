import { describe, expect, it } from 'vitest';
import {
  buildSupersetSequence,
  findNextSupersetPosition,
  groupExercises,
  isLinkedToNext,
  nextSupersetPosition,
  normalizeSupersetGroups,
  prevSupersetPosition,
  shouldRestAfter,
  toggleSupersetLink,
} from './supersets.js';

function ex(id, groupId = null, targetSets = 3) {
  return { id, name: id, supersetGroupId: groupId, targetSets };
}

function completedSet(setIndex) {
  return { setIndex, completed: true };
}

describe('isLinkedToNext', () => {
  it('is false for ungrouped exercises', () => {
    const exercises = [ex('a'), ex('b')];
    expect(isLinkedToNext(exercises, 0)).toBe(false);
  });

  it('is true for two exercises sharing a group id', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1')];
    expect(isLinkedToNext(exercises, 0)).toBe(true);
  });

  it('is false at the last exercise (no next)', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1')];
    expect(isLinkedToNext(exercises, 1)).toBe(false);
  });

  it('is false when two exercises have different group ids', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g2')];
    expect(isLinkedToNext(exercises, 0)).toBe(false);
  });
});

describe('groupExercises', () => {
  it('treats every ungrouped exercise as its own group of one', () => {
    const exercises = [ex('a'), ex('b'), ex('c')];
    const groups = groupExercises(exercises);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.exercises.length)).toEqual([1, 1, 1]);
  });

  it('clusters a contiguous run sharing a group id into one group', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1'), ex('c', 'g1'), ex('d')];
    const groups = groupExercises(exercises);
    expect(groups).toHaveLength(2);
    expect(groups[0].exercises.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(groups[1].exercises.map((e) => e.id)).toEqual(['d']);
  });

  it('treats two separately-grouped runs as two distinct groups', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1'), ex('c', 'g2'), ex('d', 'g2')];
    const groups = groupExercises(exercises);
    expect(groups).toHaveLength(2);
    expect(groups[0].groupId).not.toBe(groups[1].groupId);
  });
});

describe('toggleSupersetLink', () => {
  it('links two previously ungrouped adjacent exercises', () => {
    const exercises = [ex('a'), ex('b'), ex('c')];
    const result = toggleSupersetLink(exercises, 0);
    expect(result[0].supersetGroupId).not.toBeNull();
    expect(result[0].supersetGroupId).toBe(result[1].supersetGroupId);
    expect(result[2].supersetGroupId).toBeNull();
  });

  it('extends an existing group forward when linking its last member to the next exercise', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1'), ex('c')];
    const result = toggleSupersetLink(exercises, 1);
    expect(result.map((e) => e.supersetGroupId)).toEqual([
      result[0].supersetGroupId,
      result[0].supersetGroupId,
      result[0].supersetGroupId,
    ]);
    expect(result[0].supersetGroupId).not.toBeNull();
  });

  it('fuses two separate groups into one when linking across their boundary', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1'), ex('c', 'g2'), ex('d', 'g2')];
    const result = toggleSupersetLink(exercises, 1);
    const ids = result.map((e) => e.supersetGroupId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBeNull();
  });

  it('unlinking a 2-member group returns both exercises to ungrouped', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1')];
    const result = toggleSupersetLink(exercises, 0);
    expect(result[0].supersetGroupId).toBeNull();
    expect(result[1].supersetGroupId).toBeNull();
  });

  it('unlinking one link in a 3-member group splits it into a pair and a single', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1'), ex('c', 'g1')];
    const result = toggleSupersetLink(exercises, 1);
    expect(result[0].supersetGroupId).toBe(result[1].supersetGroupId);
    expect(result[0].supersetGroupId).not.toBeNull();
    expect(result[2].supersetGroupId).toBeNull();
  });
});

describe('normalizeSupersetGroups', () => {
  it('collapses a group left at size 1 back to ungrouped', () => {
    // Simulates the remaining exercise after its only group partner was deleted.
    const exercises = [ex('a', 'g1'), ex('b')];
    const result = normalizeSupersetGroups(exercises);
    expect(result[0].supersetGroupId).toBeNull();
  });

  it('leaves a genuine 2+ group untouched', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1'), ex('c')];
    const result = normalizeSupersetGroups(exercises);
    expect(result[0].supersetGroupId).toBe(result[1].supersetGroupId);
    expect(result[0].supersetGroupId).not.toBeNull();
  });
});

describe('buildSupersetSequence', () => {
  it('degrades to plain in-order traversal for ungrouped exercises (pre-superset behavior)', () => {
    const exercises = [ex('a', null, 2), ex('b', null, 2)];
    expect(buildSupersetSequence(exercises)).toEqual([
      { exerciseIndex: 0, setIndex: 0 },
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 1, setIndex: 0 },
      { exerciseIndex: 1, setIndex: 1 },
    ]);
  });

  it('round-robins within a linked group instead of finishing one exercise first', () => {
    const exercises = [ex('a', 'g1', 2), ex('b', 'g1', 2)];
    expect(buildSupersetSequence(exercises)).toEqual([
      { exerciseIndex: 0, setIndex: 0 },
      { exerciseIndex: 1, setIndex: 0 },
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 1, setIndex: 1 },
    ]);
  });

  it('round-robins a 3-member group', () => {
    const exercises = [ex('a', 'g1', 2), ex('b', 'g1', 2), ex('c', 'g1', 2)];
    expect(buildSupersetSequence(exercises)).toEqual([
      { exerciseIndex: 0, setIndex: 0 },
      { exerciseIndex: 1, setIndex: 0 },
      { exerciseIndex: 2, setIndex: 0 },
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 1, setIndex: 1 },
      { exerciseIndex: 2, setIndex: 1 },
    ]);
  });

  it('sequences a group followed by a solo exercise correctly', () => {
    const exercises = [ex('a', 'g1', 2), ex('b', 'g1', 2), ex('c', null, 1)];
    expect(buildSupersetSequence(exercises)).toEqual([
      { exerciseIndex: 0, setIndex: 0 },
      { exerciseIndex: 1, setIndex: 0 },
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 1, setIndex: 1 },
      { exerciseIndex: 2, setIndex: 0 },
    ]);
  });

  it('defensively skips a round beyond a member with fewer sets than its group siblings', () => {
    // Editor auto-syncs targetSets across a group, but this stays robust for imported/legacy
    // data where a group's members might not actually match.
    const exercises = [ex('a', 'g1', 3), ex('b', 'g1', 1)];
    expect(buildSupersetSequence(exercises)).toEqual([
      { exerciseIndex: 0, setIndex: 0 },
      { exerciseIndex: 1, setIndex: 0 },
      { exerciseIndex: 0, setIndex: 1 },
      { exerciseIndex: 0, setIndex: 2 },
    ]);
  });
});

describe('findNextSupersetPosition', () => {
  it('returns the first incomplete position in traversal order', () => {
    const exercises = [ex('a', 'g1', 2), ex('b', 'g1', 2)];
    const logs = { a: [completedSet(0)] };
    expect(findNextSupersetPosition(exercises, logs)).toEqual({ exerciseIndex: 1, setIndex: 0 });
  });

  it('returns null once every set in every exercise is logged', () => {
    const exercises = [ex('a', 'g1', 1), ex('b', 'g1', 1)];
    const logs = { a: [completedSet(0)], b: [completedSet(0)] };
    expect(findNextSupersetPosition(exercises, logs)).toBeNull();
  });
});

describe('nextSupersetPosition / prevSupersetPosition', () => {
  it('advances within a group to the other member before returning to round 2', () => {
    const exercises = [ex('a', 'g1', 2), ex('b', 'g1', 2)];
    expect(nextSupersetPosition(exercises, { exerciseIndex: 0, setIndex: 0 })).toEqual({
      exerciseIndex: 1,
      setIndex: 0,
    });
    expect(nextSupersetPosition(exercises, { exerciseIndex: 1, setIndex: 0 })).toEqual({
      exerciseIndex: 0,
      setIndex: 1,
    });
  });

  it('returns null past the very last position', () => {
    const exercises = [ex('a', null, 1)];
    expect(nextSupersetPosition(exercises, { exerciseIndex: 0, setIndex: 0 })).toBeNull();
  });

  it('prevSupersetPosition is the exact inverse of nextSupersetPosition', () => {
    const exercises = [ex('a', 'g1', 2), ex('b', 'g1', 2), ex('c', null, 1)];
    const sequence = buildSupersetSequence(exercises);
    for (let i = 1; i < sequence.length; i++) {
      expect(prevSupersetPosition(exercises, sequence[i])).toEqual(sequence[i - 1]);
    }
    expect(prevSupersetPosition(exercises, sequence[0])).toBeNull();
  });
});

describe('shouldRestAfter', () => {
  it('is false mid-superset (chained into the next group member)', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1')];
    expect(shouldRestAfter(exercises, 0)).toBe(false);
  });

  it('is true for the last member of a group', () => {
    const exercises = [ex('a', 'g1'), ex('b', 'g1')];
    expect(shouldRestAfter(exercises, 1)).toBe(true);
  });

  it('is true for a solo, ungrouped exercise', () => {
    const exercises = [ex('a'), ex('b')];
    expect(shouldRestAfter(exercises, 0)).toBe(true);
  });
});
