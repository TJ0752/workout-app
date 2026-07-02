import { describe, expect, it } from 'vitest';
import { todayKey } from './date.js';
import { MAX_EXTRA_REMINDERS, isTaskDoneToday, parseQuickAddText, quickAddAmountsFor } from './tasks.js';

describe('MAX_EXTRA_REMINDERS', () => {
  it('is a fixed positive integer (notification id slots depend on this being stable)', () => {
    expect(MAX_EXTRA_REMINDERS).toBe(5);
  });
});

describe('quickAddAmountsFor', () => {
  it("returns the task's own quickAdd amounts when present", () => {
    expect(quickAddAmountsFor({ quickAdd: [1, 2, 3] })).toEqual([1, 2, 3]);
  });

  it('falls back to the default [5, 10] when quickAdd is missing or empty', () => {
    expect(quickAddAmountsFor({})).toEqual([5, 10]);
    expect(quickAddAmountsFor({ quickAdd: [] })).toEqual([5, 10]);
  });
});

describe('parseQuickAddText', () => {
  it('parses a comma-separated list of positive numbers', () => {
    expect(parseQuickAddText('5, 10, 15')).toEqual([5, 10, 15]);
  });

  it('filters out non-numeric, zero, and negative entries', () => {
    expect(parseQuickAddText('5, abc, 0, -3, 10')).toEqual([5, 10]);
  });

  it('returns an empty array for blank input', () => {
    expect(parseQuickAddText('')).toEqual([]);
  });
});

describe('isTaskDoneToday', () => {
  const key = todayKey();

  it('boolean tasks: done iff a truthy value is recorded today', () => {
    const task = { id: 't1', completionType: 'boolean' };
    expect(isTaskDoneToday(task, { t1: { [key]: 1 } })).toBe(true);
    expect(isTaskDoneToday(task, { t1: {} })).toBe(false);
    expect(isTaskDoneToday(task, {})).toBe(false);
  });

  it('quantity tasks: done iff actual >= target and target is truthy', () => {
    const task = { id: 't2', completionType: 'quantity', target: 10 };
    expect(isTaskDoneToday(task, { t2: { [key]: 10 } })).toBe(true);
    expect(isTaskDoneToday(task, { t2: { [key]: 12 } })).toBe(true);
    expect(isTaskDoneToday(task, { t2: { [key]: 9 } })).toBe(false);
    expect(isTaskDoneToday(task, { t2: {} })).toBe(false);
  });

  it('quantity tasks with a falsy/zero target are never "done" even with a logged value', () => {
    const task = { id: 't3', completionType: 'quantity', target: 0 };
    expect(isTaskDoneToday(task, { t3: { [key]: 5 } })).toBe(false);
  });

  it('workout tasks: done iff the stored session fraction is >= 1', () => {
    const task = { id: 't4', completionType: 'workout' };
    expect(isTaskDoneToday(task, { t4: { [key]: 1 } })).toBe(true);
    expect(isTaskDoneToday(task, { t4: { [key]: 1.2 } })).toBe(true);
    expect(isTaskDoneToday(task, { t4: { [key]: 0.9 } })).toBe(false);
    expect(isTaskDoneToday(task, { t4: {} })).toBe(false);
  });
});
