import { describe, expect, it } from 'vitest';
import { parseEpub, resolveHref, resolvePath } from '../src/epub/book';
import { makeEpub } from './makeEpub';

describe.each([2, 3] as const)('parseEpub (EPUB %i)', (version) => {
  const book = parseEpub(makeEpub(version));

  it('reads metadata', () => {
    expect(book.metadata).toMatchObject({
      title: `Test Book ${version}`,
      creator: 'Jane Author',
      language: 'es',
      identifier: `urn:uuid:test-${version}`,
    });
  });

  it('reads the spine in order, decoding escaped hrefs', () => {
    expect(book.spine.map((s) => s.href)).toEqual(['OEBPS/Text/chapter 1.xhtml', 'OEBPS/Text/chapter2.xhtml']);
    expect(book.text(book.spine[0].href)).toContain('Chapter 1');
  });

  it(`reads the nested table of contents from the ${version === 2 ? 'NCX' : 'nav document'}`, () => {
    expect(book.toc.map((t) => t.label)).toEqual(['Chapter 1', 'Chapter 2']);
    expect(book.toc[0].href).toBe('OEBPS/Text/chapter 1.xhtml#c1');
    expect(book.toc[0].children).toMatchObject([{ label: 'Section 1.1', href: 'OEBPS/Text/chapter 1.xhtml' }]);
    expect(book.toc[1].href).toBe('OEBPS/Text/chapter2.xhtml#c2');
  });

  it('finds the cover image', () => {
    expect(book.coverHref).toBe('OEBPS/Images/cover.png');
    expect(book.mediaType('OEBPS/Images/cover.png')).toBe('image/png');
  });
});

describe('path resolution', () => {
  it('resolves relative paths against the base directory', () => {
    expect(resolvePath('OEBPS/Text/ch1.xhtml', '../Images/a%20b.png')).toBe('OEBPS/Images/a b.png');
    expect(resolveHref('OEBPS/toc.ncx', 'Text/ch1.xhtml#s2')).toBe('OEBPS/Text/ch1.xhtml#s2');
    expect(resolveHref('OEBPS/Text/ch1.xhtml', '#note')).toBe('OEBPS/Text/ch1.xhtml#note');
  });
});
