import { generateId } from './id';

// A superset is any run of *contiguous* exercises in task.exercises[] sharing the same
// supersetGroupId - contiguity is enforced structurally (the only way to create/extend a group
// is linking two array-adjacent exercises, see toggleSupersetLink below), not validated
// separately. An exercise with no supersetGroupId is just a group of one, same as before this
// feature existed - nothing about a plain, ungrouped exercise changes.

// Whether the exercise at `index` shares a group with the one immediately after it.
export function isLinkedToNext(exercises, index) {
  const a = exercises[index];
  const b = exercises[index + 1];
  if (!a || !b) return false;
  return Boolean(a.supersetGroupId) && a.supersetGroupId === b.supersetGroupId;
}

// Splits exercises into its contiguous groups, in order. Every exercise appears in exactly one
// group; an ungrouped exercise is its own group of one. This is the shape both the editor
// (visual clustering) and session navigation (round-robin within a group) read from.
export function groupExercises(exercises) {
  const groups = [];
  for (const ex of exercises) {
    const last = groups[groups.length - 1];
    if (last && ex.supersetGroupId && ex.supersetGroupId === last.groupId) {
      last.exercises.push(ex);
    } else {
      groups.push({ groupId: ex.supersetGroupId || null, exercises: [ex] });
    }
  }
  return groups;
}

// Rebuilds every supersetGroupId in the array from a given "is exercise i linked to i+1"
// adjacency list. A chain of 2+ linked exercises gets one freshly generated shared id; a lone
// exercise (chain of 1) gets null. Group ids are never persisted as meaningful identity beyond
// "same id = same group" within this one rebuild, so regenerating them from scratch on every
// change is simpler and more robust than trying to hand-merge/split existing ids in place.
function rebuildFromLinks(exercises, linked) {
  const result = exercises.map((ex) => ({ ...ex }));
  let groupStart = 0;
  for (let i = 0; i <= result.length; i++) {
    if (i === result.length || !linked[i]) {
      const groupSize = i - groupStart + 1;
      if (groupSize > 1) {
        const groupId = generateId();
        for (let j = groupStart; j <= i; j++) result[j].supersetGroupId = groupId;
      } else if (groupStart < result.length) {
        result[groupStart].supersetGroupId = null;
      }
      groupStart = i + 1;
    }
  }
  return result;
}

// Toggles whether the exercise at `index` is linked (same superset) with the one right after
// it, then rebuilds group ids for the whole array from the resulting chain of adjacency.
export function toggleSupersetLink(exercises, index) {
  const linked = exercises.map((_, i) => isLinkedToNext(exercises, i));
  linked[index] = !linked[index];
  return rebuildFromLinks(exercises, linked);
}

// Cleans up any group left at size 1 (e.g. the rest of its group was deleted) back to
// ungrouped, without disturbing any group that's still genuinely 2+. Safe to call after any
// structural change to the exercises array (add/remove) that isn't itself a link toggle.
export function normalizeSupersetGroups(exercises) {
  const linked = exercises.map((_, i) => isLinkedToNext(exercises, i));
  return rebuildFromLinks(exercises, linked);
}

// Assigns a display letter (A, B, C, ...) to each *multi-member* group, in the order the
// groups appear - a solo/ungrouped exercise gets no entry. Used purely for UI labeling
// ("Superset A"); never persisted, since group identity is the id itself, not the letter.
export function supersetGroupLabels(exercises) {
  const labels = {};
  let letterCode = 65; // 'A'
  for (const group of groupExercises(exercises)) {
    if (group.exercises.length > 1) {
      const label = String.fromCharCode(letterCode);
      letterCode += 1;
      for (const ex of group.exercises) labels[ex.id] = label;
    }
  }
  return labels;
}

// --- Session navigation -----------------------------------------------------------------
//
// A superset changes the *order* sets get logged in, nothing else: round-robin within a
// group (every member's set 1, then every member's set 2, ...) instead of finishing one
// exercise before starting the next. A solo exercise is just a group of one, so it degrades
// to the exact plain in-order traversal every exercise used before this feature existed -
// this is why buildSupersetSequence is safe to use unconditionally, not just when a group is
// actually present.

/** The full ordered (exerciseIndex, setIndex) traversal for one session. */
export function buildSupersetSequence(exercises) {
  const sequence = [];
  let i = 0;
  while (i < exercises.length) {
    let j = i;
    while (isLinkedToNext(exercises, j)) j++;
    const groupIndices = [];
    for (let k = i; k <= j; k++) groupIndices.push(k);
    const maxSets = Math.max(...groupIndices.map((k) => Math.max(1, exercises[k].targetSets || 1)));
    for (let round = 0; round < maxSets; round++) {
      for (const k of groupIndices) {
        if (round < Math.max(1, exercises[k].targetSets || 1)) {
          sequence.push({ exerciseIndex: k, setIndex: round });
        }
      }
    }
    i = j + 1;
  }
  return sequence;
}

function sequenceIndexOf(sequence, position) {
  return sequence.findIndex((p) => p.exerciseIndex === position.exerciseIndex && p.setIndex === position.setIndex);
}

/** The first not-yet-completed position in traversal order, or null once every set is done. */
export function findNextSupersetPosition(exercises, logsForDate) {
  const sequence = buildSupersetSequence(exercises);
  for (const pos of sequence) {
    const exercise = exercises[pos.exerciseIndex];
    const sets = logsForDate?.[exercise.id] || [];
    if (!sets.find((s) => s.setIndex === pos.setIndex && s.completed)) return pos;
  }
  return null;
}

/** The position right after `current` in traversal order, or null if `current` was the last. */
export function nextSupersetPosition(exercises, current) {
  const sequence = buildSupersetSequence(exercises);
  const idx = sequenceIndexOf(sequence, current);
  if (idx === -1 || idx + 1 >= sequence.length) return null;
  return sequence[idx + 1];
}

/** The position right before `current` in traversal order, or null if `current` was the first. */
export function prevSupersetPosition(exercises, current) {
  const sequence = buildSupersetSequence(exercises);
  const idx = sequenceIndexOf(sequence, current);
  if (idx <= 0) return null;
  return sequence[idx - 1];
}

/** Whether completing a set of the exercise at `exerciseIndex` should trigger a rest before
 * advancing - false when it's chained mid-superset into the next group member (no rest between
 * superset exercises, regardless of that exercise's own configured restSeconds), true
 * otherwise (a solo exercise between its own sets/exercises, or the last member of a group
 * finishing a round - see the editor's "Rest after this superset" field). */
export function shouldRestAfter(exercises, exerciseIndex) {
  return !isLinkedToNext(exercises, exerciseIndex);
}
