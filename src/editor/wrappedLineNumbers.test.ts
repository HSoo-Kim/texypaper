import { describe, expect, it } from 'vitest';
import { continuationMarks, wrapRows } from './wrappedLineNumbers';

describe('wrapped line numbers', () => {
  it('counts the measured rows of a line block and never drops below one', () => {
    expect(wrapRows(23.1, 23.1)).toBe(1);
    expect(wrapRows(69.3, 23.1)).toBe(3);
    expect(wrapRows(69.9, 23.1)).toBe(3);
    expect(wrapRows(0, 23.1)).toBe(1);
    expect(wrapRows(Number.NaN, 23.1)).toBe(1);
    expect(wrapRows(46.2, 0)).toBe(1);
  });

  it('marks only the continuation rows, one per row', () => {
    expect(continuationMarks(1)).toBe('');
    expect(continuationMarks(2)).toBe('↳');
    expect(continuationMarks(4)).toBe('↳\n↳\n↳');
  });
});
