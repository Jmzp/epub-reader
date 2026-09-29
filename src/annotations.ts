import type { Anchor } from './reader/section';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export interface Highlight {
  id: string;
  section: number;
  start: Anchor;
  end: Anchor;
  text: string;
  color: HighlightColor;
  note?: string;
  /** Table-of-contents label where it was made. */
  chapter?: string;
  createdAt: number;
}

export interface Bookmark {
  id: string;
  section: number;
  anchor: Anchor;
  /** First words of the page, shown in the list. */
  snippet: string;
  chapter?: string;
  createdAt: number;
}

export interface Annotations {
  highlights: Highlight[];
  bookmarks: Bookmark[];
}

/** Translucent fills drawn under the text; they read well on every theme. */
export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: 'rgba(250, 204, 21, 0.38)',
  green: 'rgba(74, 222, 128, 0.32)',
  blue: 'rgba(96, 165, 250, 0.34)',
  pink: 'rgba(244, 114, 182, 0.32)',
};

/** Solid version of each color for UI swatches. */
export const SWATCHES: Record<HighlightColor, string> = {
  yellow: '#f5c518',
  green: '#3fbf6f',
  blue: '#4f93f0',
  pink: '#ec5fa3',
};

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Document order of two anchors in the same section (-1, 0, 1). */
export function compareAnchors(a: Anchor, b: Anchor): number {
  const n = Math.min(a.path.length, b.path.length);
  for (let i = 0; i < n; i++) if (a.path[i] !== b.path[i]) return a.path[i] < b.path[i] ? -1 : 1;
  if (a.path.length !== b.path.length) return a.path.length < b.path.length ? -1 : 1;
  return Math.sign(a.offset - b.offset);
}

/** Sorts by position in the book. */
export function byPosition<T extends { section: number }>(anchor: (t: T) => Anchor) {
  return (a: T, b: T) => a.section - b.section || compareAnchors(anchor(a), anchor(b));
}

const key = (bookId: string) => `notes:${bookId}`;

export const annotationStore = {
  load(bookId: string): Annotations {
    try {
      const raw = localStorage.getItem(key(bookId));
      const data = raw ? (JSON.parse(raw) as Partial<Annotations>) : {};
      return { highlights: data.highlights ?? [], bookmarks: data.bookmarks ?? [] };
    } catch {
      return { highlights: [], bookmarks: [] };
    }
  },
  save(bookId: string, a: Annotations) {
    try {
      localStorage.setItem(key(bookId), JSON.stringify(a));
    } catch {
      // Storage unavailable: annotations live for this session only.
    }
  },
};

/** Markdown export of every note and highlight, in reading order. */
export function toMarkdown(title: string, author: string, a: Annotations): string {
  const lines = [`# ${title}`, author ? `*${author}*` : '', ''];
  let chapter = '';
  for (const h of [...a.highlights].sort(byPosition((x) => x.start))) {
    const c = h.chapter ?? '';
    if (c && c !== chapter) {
      chapter = c;
      lines.push(`## ${c}`, '');
    }
    lines.push(`> ${h.text.replace(/\s+/g, ' ').trim()}`, '');
    if (h.note) lines.push(h.note.trim(), '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
