// Which "style" of workout an exercise belongs to - lives on the shared exercise repository row
// (see storage.js's resolveExerciseId), not per-task-instance, so the same real-world exercise
// (e.g. "Bench Press") classifies identically everywhere it's reused across routines, exactly
// like exerciseId itself already unifies PR/volume history. Only strength/bodyweight/
// stretch_mobility/yoga get a dedicated Workout Detail treatment in Analytics 2 today (see
// CLAUDE.md's "Analytics 2" section, Phase 1-3) - running/hiit are included now purely so a user
// can start tagging those exercises ahead of Phase 4's dedicated distance/round-status logging
// and analytics landing later.
export const EXERCISE_CATEGORIES = [
  { id: 'strength', label: 'Strength' },
  { id: 'bodyweight', label: 'Bodyweight' },
  { id: 'stretch_mobility', label: 'Stretch & Mobility' },
  { id: 'yoga', label: 'Yoga' },
  { id: 'running', label: 'Running' },
  { id: 'hiit', label: 'HIIT / Circuit' },
];

const CATEGORY_LABELS = Object.fromEntries(EXERCISE_CATEGORIES.map((c) => [c.id, c.label]));

export function exerciseCategoryLabel(categoryId) {
  return CATEGORY_LABELS[categoryId] || null;
}

/**
 * Best-effort default category from an exercise's own config - deliberately simple (type/unit
 * only, the two fields every exercise already has) rather than trying to guess Yoga vs.
 * Stretch & Mobility, Running, or HIIT, none of which this app has any real signal for yet.
 * A duration-based exercise (unit: 'seconds') defaults to 'stretch_mobility' as the more common
 * case - one tap in the editor re-categorizes it to Yoga (or anything else) if that's wrong, and
 * this is only ever used as the *initial* value for a brand-new exercise (see resolveExerciseId
 * in storage.js) - it never overwrites a category the user or an earlier save already set.
 */
export function inferExerciseCategory(exercise) {
  if (!exercise) return null;
  if (exercise.unit === 'seconds') return 'stretch_mobility';
  if (exercise.type === 'calisthenics') return 'bodyweight';
  return 'strength';
}
