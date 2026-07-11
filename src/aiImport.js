import { generateId } from './utils/id';
import { MAX_EXTRA_REMINDERS } from './utils/tasks';
import { ICON_OPTIONS } from './utils/icons';

const VALID_ICON_IDS = new Set(ICON_OPTIONS.map((o) => o.id));
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const COMPLETION_TYPES = ['boolean', 'quantity', 'workout'];
const QUANTITY_MODES = ['number', 'timer'];
const EXERCISE_TYPES = ['weights', 'calisthenics'];
const EXERCISE_UNITS = ['reps', 'seconds'];

/**
 * The exact schema an AI chat should be told to output - built from the same constants the
 * validator below enforces, so the two can't silently drift apart. Copy-pasted into a ChatGPT
 * (or similar) conversation before asking it to generate a routine; whenever RoutineForm gains a
 * new field, both this template and convertTask/convertRoutine below need the matching update -
 * that's the one place per new field, not two independently-maintained schemas.
 */
export const AI_IMPORT_PROMPT = `You are generating data for a habit/routine tracker app called "Daily Routines". \
Output ONLY a single raw JSON object (no markdown fences, no commentary before or after) matching this shape:

{
  "routines": [
    {
      "title": "string, required",
      "icon": "one of: ${ICON_OPTIONS.map((o) => o.id).join(', ')} — or omit/null to auto-pick from the title",
      "notes": "string, optional",
      "defaultDays": [1, 2, 3, 4, 5],
      "tasks": [
        {
          "title": "string - only required if this routine has more than one task",
          "time": "HH:MM in 24h - the due-by time, default 08:00",
          "windowStart": "HH:MM in 24h - when the task becomes relevant, default 00:00 (all day)",
          "days": [1, 2, 3, 4, 5],
          "reminderTimes": ["HH:MM", "..."],
          "completionType": "boolean | quantity | workout, default boolean",

          "quantityMode": "number | timer, default number - quantity only",
          "target": 10,
          "unit": "reps",
          "quickAdd": [5, 10],
          "autoUpdateTarget": false,

          "exercises": [
            {
              "name": "string, required",
              "type": "weights | calisthenics, default weights",
              "targetSets": 3,
              "unit": "reps | seconds, default reps",
              "targetReps": 10,
              "targetDurationSeconds": 30,
              "restSeconds": 60,
              "supersetGroup": "optional string label, e.g. \\"A\\" - see Rules below"
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- days: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
- All durations (target in timer mode, targetDurationSeconds, restSeconds) are whole seconds -
  e.g. a 10-minute target is 600, not 10.
- "target" is required for a quantity task: a plain count in "number" mode, whole seconds in
  "timer" mode.
- A workout task needs at least one entry in "exercises", each with a "name".
- "supersetGroup" links 2+ exercises into a superset (performed back-to-back with no rest
  between them, one shared rest only after the last one) - give matching exercises the exact
  same label (any string) to link them. Linked exercises MUST be adjacent/consecutive in the
  "exercises" array - a label used on non-adjacent exercises is ignored. Omit entirely for a
  normal, standalone exercise.
- Every field not marked "required" can be omitted entirely - sensible defaults are used.
- A routine with exactly one task doesn't need that task's own "title" (it's shown flat, using
  the routine's own title).
- You can generate more than one routine at once inside the "routines" array.
- Output raw JSON only - nothing else, so it can be copied straight into the app.`;

export class AiImportError extends Error {
  constructor(issues) {
    super(issues.join('\n'));
    this.issues = issues;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validDays(value) {
  return Array.isArray(value) && value.length > 0 && value.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

function validTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

function convertExercise(raw, label, index, notes) {
  const exLabel = `${label} > exercise ${index + 1}`;
  if (!isPlainObject(raw)) {
    notes.push(`${exLabel}: skipped - must be an object.`);
    return null;
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    notes.push(`${exLabel}: skipped - "name" is required.`);
    return null;
  }
  const type = EXERCISE_TYPES.includes(raw.type) ? raw.type : 'weights';
  const unit = EXERCISE_UNITS.includes(raw.unit) ? raw.unit : 'reps';
  const targetSets = Number.isFinite(raw.targetSets) && raw.targetSets > 0 ? Math.round(raw.targetSets) : 3;
  const targetReps =
    unit === 'reps' ? (Number.isFinite(raw.targetReps) && raw.targetReps > 0 ? Math.round(raw.targetReps) : 10) : null;
  const targetDurationSeconds =
    unit === 'seconds'
      ? Number.isFinite(raw.targetDurationSeconds) && raw.targetDurationSeconds > 0
        ? Math.round(raw.targetDurationSeconds)
        : 30
      : null;
  const restSeconds = Number.isFinite(raw.restSeconds) && raw.restSeconds >= 0 ? Math.round(raw.restSeconds) : null;
  // A temporary label, not the real supersetGroupId - resolveSupersetGroups (below) turns
  // matching *adjacent* labels into a real shared id once every exercise in the task has been
  // converted, then strips this field. Kept as a plain string here since an AI has no way to
  // produce this app's own generateId() scheme.
  const supersetGroup = typeof raw.supersetGroup === 'string' && raw.supersetGroup.trim() ? raw.supersetGroup.trim() : null;

  return {
    id: generateId(),
    name,
    type,
    targetSets,
    targetReps,
    targetDurationSeconds,
    unit,
    restSeconds,
    supersetGroupId: null,
    supersetGroup,
  };
}

/**
 * Turns each exercise's temporary `supersetGroup` label into a real `supersetGroupId`,
 * matching the same contiguity rule RoutineForm's Link/Unlink editor enforces (see
 * utils/supersets.js): only a *contiguous* run of exercises sharing a label actually becomes
 * one superset. A label reused by a later, non-adjacent exercise (or a second separate
 * contiguous run) can't be merged into the first group, so it's left ungrouped with a note
 * instead of silently producing a different grouping than the AI likely intended.
 */
function resolveSupersetGroups(exercises, label, notes) {
  const seenLabels = new Set();
  const result = exercises.map((ex) => ({ ...ex }));
  let i = 0;
  while (i < result.length) {
    const group = result[i].supersetGroup;
    let j = i;
    while (j + 1 < result.length && group != null && result[j + 1].supersetGroup === group) j++;
    if (group != null) {
      if (seenLabels.has(group)) {
        notes.push(
          `${label}: supersetGroup "${group}" is used by exercises that aren't all adjacent - only the first contiguous run was linked as a superset; the rest were left standalone.`
        );
      } else {
        seenLabels.add(group);
        if (j > i) {
          const groupId = generateId();
          for (let k = i; k <= j; k++) result[k].supersetGroupId = groupId;
        }
      }
    }
    i = j + 1;
  }
  return result.map((ex) => ({
    id: ex.id,
    name: ex.name,
    type: ex.type,
    targetSets: ex.targetSets,
    targetReps: ex.targetReps,
    targetDurationSeconds: ex.targetDurationSeconds,
    unit: ex.unit,
    restSeconds: ex.restSeconds,
    supersetGroupId: ex.supersetGroupId,
  }));
}

function convertTask(raw, routineLabel, index, isSimple, routineTitle, routineDefaultDays, notes) {
  const label = isSimple ? routineLabel : `${routineLabel} > task ${index + 1}`;
  if (!isPlainObject(raw)) {
    notes.push(`${label}: skipped - must be an object.`);
    return null;
  }

  const title = isSimple ? routineTitle : typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!isSimple && !title) {
    notes.push(`${label}: skipped - "title" is required for a task in a multi-task routine.`);
    return null;
  }

  let time = '08:00';
  if (raw.time != null) {
    if (validTime(raw.time)) time = raw.time;
    else notes.push(`${label}: "time" ignored (must be HH:MM 24h) - defaulted to 08:00.`);
  }

  let windowStart = '00:00';
  if (raw.windowStart != null) {
    if (validTime(raw.windowStart)) windowStart = raw.windowStart;
    else notes.push(`${label}: "windowStart" ignored (must be HH:MM 24h) - defaulted to 00:00.`);
  }

  let days = routineDefaultDays;
  if (raw.days != null) {
    if (validDays(raw.days)) days = raw.days;
    else notes.push(`${label}: "days" ignored (must be a non-empty array of integers 0-6) - defaulted to the routine's days.`);
  }

  const reminderTimes = Array.isArray(raw.reminderTimes) ? raw.reminderTimes.filter(validTime).slice(0, MAX_EXTRA_REMINDERS) : [];

  const completionType = COMPLETION_TYPES.includes(raw.completionType) ? raw.completionType : 'boolean';

  let target = null;
  let unit = null;
  let quickAdd = null;
  let quantityMode = 'number';
  let autoUpdateTarget = false;
  let exercises = [];

  if (completionType === 'quantity') {
    quantityMode = QUANTITY_MODES.includes(raw.quantityMode) ? raw.quantityMode : 'number';
    const fallbackTarget = quantityMode === 'timer' ? 300 : 10;
    if (Number.isFinite(raw.target) && raw.target > 0) {
      target = raw.target;
    } else {
      target = fallbackTarget;
      notes.push(`${label}: "target" ignored (must be a positive number) - defaulted to ${fallbackTarget}.`);
    }
    if (quantityMode === 'number') {
      unit = typeof raw.unit === 'string' ? raw.unit : null;
      const rawQuickAdd = Array.isArray(raw.quickAdd) ? raw.quickAdd.filter((n) => Number.isFinite(n) && n > 0) : null;
      quickAdd = rawQuickAdd && rawQuickAdd.length ? rawQuickAdd : null;
    } else {
      autoUpdateTarget = Boolean(raw.autoUpdateTarget);
    }
  } else if (completionType === 'workout') {
    const rawExercises = Array.isArray(raw.exercises) ? raw.exercises : [];
    exercises = rawExercises.map((ex, i) => convertExercise(ex, label, i, notes)).filter(Boolean);
    if (!exercises.length) {
      notes.push(`${label}: skipped - a workout task needs at least one valid exercise.`);
      return null;
    }
    exercises = resolveSupersetGroups(exercises, label, notes);
  }

  return {
    id: generateId(),
    title,
    time,
    windowStart,
    reminderTimes,
    days,
    completionType,
    target,
    unit,
    quickAdd,
    quantityMode,
    autoUpdateTarget,
    exercises,
    active: true,
    createdAt: new Date().toISOString(),
  };
}

function convertRoutine(raw, index, notes) {
  const titleGuess = isPlainObject(raw) && typeof raw.title === 'string' ? raw.title.trim() : '';
  const routineLabel = `Routine ${index + 1}${titleGuess ? ` ("${titleGuess}")` : ''}`;

  if (!isPlainObject(raw)) {
    notes.push(`${routineLabel}: skipped - must be an object.`);
    return null;
  }
  const title = titleGuess;
  if (!title) {
    notes.push(`${routineLabel}: skipped - "title" is required.`);
    return null;
  }

  const icon = typeof raw.icon === 'string' && VALID_ICON_IDS.has(raw.icon) ? raw.icon : null;
  const notesField = typeof raw.notes === 'string' ? raw.notes : '';

  let defaultDays = DEFAULT_DAYS;
  if (raw.defaultDays != null) {
    if (validDays(raw.defaultDays)) defaultDays = raw.defaultDays;
    else notes.push(`${routineLabel}: "defaultDays" ignored (must be a non-empty array of integers 0-6) - defaulted to weekdays.`);
  }

  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  if (!rawTasks.length) {
    notes.push(`${routineLabel}: skipped - needs at least one task in "tasks".`);
    return null;
  }
  const isSimple = rawTasks.length === 1;
  const routineId = generateId();

  const tasks = rawTasks
    .map((t, i) => convertTask(t, routineLabel, i, isSimple, title, defaultDays, notes))
    .filter(Boolean)
    .map((t) => ({ ...t, routineId }));

  if (!tasks.length) {
    notes.push(`${routineLabel}: skipped - no valid tasks survived validation.`);
    return null;
  }

  return {
    routine: { id: routineId, title, icon, notes: notesField, defaultDays, active: true, createdAt: new Date().toISOString() },
    tasks,
  };
}

/**
 * Parses and validates AI-generated (or hand-written) JSON into the exact {routine, tasks} shape
 * upsertRoutine/upsertTask expect - additive only (fresh ids throughout), never touches or
 * replaces anything already in the app, unlike backup.js's full destructive restore. Accepts a
 * single routine object, a bare array of routines, or {"routines": [...]} , since it's genuinely
 * unpredictable which of those an AI chat will produce even when asked for one specific shape.
 * Every problem found (a routine/task/exercise that couldn't be used at all, or a field that got
 * silently defaulted) is collected into `notes` rather than failing the whole import over one bad
 * field - a partially-usable AI response should still import what it got right.
 */
export function parseAiImportText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AiImportError([`That's not valid JSON: ${err.message}`]);
  }

  let rawRoutines;
  if (Array.isArray(parsed)) {
    rawRoutines = parsed;
  } else if (isPlainObject(parsed) && Array.isArray(parsed.routines)) {
    rawRoutines = parsed.routines;
  } else if (isPlainObject(parsed)) {
    rawRoutines = [parsed];
  } else {
    throw new AiImportError(['Expected a routine object, an array of routines, or {"routines": [...]}.']);
  }
  if (!rawRoutines.length) {
    throw new AiImportError(['No routines found - the "routines" array is empty.']);
  }

  const notes = [];
  const results = rawRoutines.map((r, i) => convertRoutine(r, i, notes)).filter(Boolean);

  if (!results.length) {
    throw new AiImportError(notes.length ? notes : ['Nothing importable was found in that JSON.']);
  }

  return { results, notes };
}
