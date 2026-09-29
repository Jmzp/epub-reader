import { describe, expect, it } from 'vitest';
import { lookupTerm } from '../src/dictionary';

describe('lookupTerm', () => {
  it('trims punctuation, quotes and possessives', () => {
    expect(lookupTerm('  "forsaken," ')).toBe('forsaken');
    expect(lookupTerm('Savior’s')).toBe('Savior');
    expect(lookupTerm('¿corazón?')).toBe('corazón');
    expect(lookupTerm('...')).toBe('');
  });
});
