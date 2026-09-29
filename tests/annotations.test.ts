import { describe, expect, it } from 'vitest';
import { byPosition, compareAnchors, toMarkdown, type Highlight } from '../src/annotations';

const h = (section: number, path: number[], offset: number, text: string, extra: Partial<Highlight> = {}): Highlight => ({
  id: text,
  section,
  start: { path, offset },
  end: { path, offset: offset + text.length },
  text,
  color: 'yellow',
  createdAt: 0,
  ...extra,
});

describe('annotations', () => {
  it('orders anchors in document order', () => {
    expect(compareAnchors({ path: [1, 2], offset: 0 }, { path: [1, 3], offset: 0 })).toBe(-1);
    expect(compareAnchors({ path: [1], offset: 0 }, { path: [1, 0], offset: 0 })).toBe(-1);
    expect(compareAnchors({ path: [2, 0], offset: 5 }, { path: [2, 0], offset: 1 })).toBe(1);
    expect(compareAnchors({ path: [2, 0], offset: 1 }, { path: [2, 0], offset: 1 })).toBe(0);
  });

  it('sorts highlights by section, then position', () => {
    const list = [h(2, [0], 0, 'c'), h(1, [3, 1], 0, 'b'), h(1, [3, 0], 9, 'a')];
    expect(list.sort(byPosition((x) => x.start)).map((x) => x.text)).toEqual(['a', 'b', 'c']);
  });

  it('exports notes as Markdown grouped by chapter', () => {
    const md = toMarkdown('Book', 'Author', {
      highlights: [
        h(1, [5], 0, 'second  quote', { chapter: 'Two' }),
        h(1, [1], 0, 'first quote', { chapter: 'One', note: 'My note' }),
      ],
      bookmarks: [],
    });
    expect(md).toBe('# Book\n*Author*\n\n## One\n\n> first quote\n\nMy note\n\n## Two\n\n> second quote\n');
  });
});
