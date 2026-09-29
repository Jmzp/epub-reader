import { resolveHref, resolvePath, type Book } from '../epub/book';
import type { Resources, UrlMode } from '../epub/resources';
import type { Layout } from './layout';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const READER_STYLE_ID = '__reader_style';
const READER_PLACEHOLDER = '/*__READER_CSS__*/';

/** A position inside a section that survives re-pagination (font/size changes). */
export interface Anchor {
  path: number[];
  offset: number;
}

/**
 * Builds a self-contained XHTML string for a spine item with every resource rewritten
 * to blob: or data: URLs and a placeholder `<style>` for the reader CSS.
 */
export function buildSectionXhtml(book: Book, res: Resources, href: string, mode: UrlMode): string {
  const source = book.text(href);
  let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(source, 'text/html');

  const all = (sel: string) => Array.from(doc.querySelectorAll(sel));
  all('script, iframe, object, embed').forEach((el) => el.remove());

  for (const link of all('link')) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    const target = resolvePath(href, link.getAttribute('href') ?? '');
    if (rel.includes('stylesheet') && book.has(target)) {
      const style = doc.createElementNS(XHTML_NS, 'style');
      style.textContent = res.css(target, mode);
      link.replaceWith(style);
    } else {
      link.remove();
    }
  }
  for (const style of all('style')) {
    style.textContent = res.rewriteCss(style.textContent ?? '', href, mode);
  }
  for (const el of all('[style]')) {
    el.setAttribute('style', res.rewriteCss(el.getAttribute('style') ?? '', href, mode));
  }
  for (const img of all('img[src]')) {
    const url = res.url(resolvePath(href, img.getAttribute('src')!), mode);
    if (url) img.setAttribute('src', url);
    img.removeAttribute('srcset');
  }
  for (const img of Array.from(doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'image'))) {
    const ref = img.getAttributeNS(XLINK_NS, 'href') ?? img.getAttribute('href');
    if (!ref) continue;
    const url = res.url(resolvePath(href, ref), mode);
    if (!url) continue;
    img.removeAttributeNS(XLINK_NS, 'href');
    img.setAttribute('href', url);
  }
  // Mark internal links so the reader can navigate them instead of the iframe.
  for (const a of all('a[href]')) {
    const h = a.getAttribute('href')!;
    if (!/^[a-z]+:/i.test(h)) {
      a.setAttribute('data-epub-href', resolveHref(href, h));
      a.setAttribute('href', '#');
    }
  }

  const root = doc.documentElement;
  let head = doc.querySelector('head');
  if (!head) {
    head = doc.createElementNS(XHTML_NS, 'head');
    root.insertBefore(head, root.firstChild);
  }
  if (!doc.querySelector('body')) root.appendChild(doc.createElementNS(XHTML_NS, 'body'));
  const readerStyle = doc.createElementNS(XHTML_NS, 'style');
  readerStyle.setAttribute('id', READER_STYLE_ID);
  readerStyle.textContent = READER_PLACEHOLDER;
  head.appendChild(readerStyle);

  let xhtml = new XMLSerializer().serializeToString(root);
  if (!xhtml.includes(`xmlns="${XHTML_NS}"`)) xhtml = xhtml.replace(/^<html/, `<html xmlns="${XHTML_NS}"`);
  return xhtml;
}

/**
 * One spine item, laid out in a persistent iframe with CSS multi-column pagination.
 * The iframe shows real, selectable text while the reader is at rest.
 */
export class Section {
  readonly iframe: HTMLIFrameElement;
  pageCount = 1;
  private displayUrl = '';
  private rasterTemplate?: string;
  private layout?: Layout;
  private shownPage = 0;

  constructor(
    readonly index: number,
    readonly href: string,
    private book: Book,
    private res: Resources,
    host: HTMLElement,
  ) {
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'section-frame';
    // No scripts; same-origin so the reader can measure and navigate the document.
    this.iframe.setAttribute('sandbox', 'allow-same-origin');
    this.iframe.setAttribute('scrolling', 'no');
    this.iframe.tabIndex = -1;
    host.appendChild(this.iframe);
  }

  get layoutInfo(): Layout | undefined {
    return this.layout;
  }

  get doc(): Document {
    return this.iframe.contentDocument!;
  }

  async load(layout: Layout, css: string): Promise<void> {
    const xhtml = buildSectionXhtml(this.book, this.res, this.href, 'blob');
    this.displayUrl = URL.createObjectURL(
      new Blob([xhtml.replace(READER_PLACEHOLDER, '')], { type: 'application/xhtml+xml' }),
    );
    this.sizeFrame(layout);
    await new Promise<void>((resolve) => {
      this.iframe.addEventListener('load', () => resolve(), { once: true });
      this.iframe.src = this.displayUrl;
    });
    await this.waitForImages();
    this.applyLayout(layout, css);
  }

  applyLayout(layout: Layout, css: string) {
    this.layout = layout;
    this.sizeFrame(layout);
    const style = this.doc.getElementById(READER_STYLE_ID);
    if (style) style.textContent = css;
    const body = this.doc.body;
    body.style.transform = 'none';
    // body.scrollWidth ≈ N*pageW - marginX (or N*pageW when trailing padding is counted).
    this.pageCount = Math.max(1, Math.round((body.scrollWidth + layout.marginX) / layout.pageW));
    this.showPage(Math.min(this.shownPage, this.lastViewPage()));
  }

  /** First page index of the last view (views are pagesPerView pages wide). */
  lastViewPage(): number {
    const ppv = this.layout?.pagesPerView ?? 1;
    return Math.floor((this.pageCount - 1) / ppv) * ppv;
  }

  showPage(page: number) {
    this.shownPage = page;
    const pageW = this.layout?.pageW ?? 0;
    this.doc.body.style.transform = `translate3d(${-page * pageW}px,0,0)`;
  }

  private sizeFrame(l: Layout) {
    this.iframe.style.width = `${l.viewW}px`;
    this.iframe.style.height = `${l.viewH}px`;
  }

  private async waitForImages() {
    const imgs = Array.from(this.doc.images).filter((i) => !i.complete);
    await Promise.all(
      imgs.map(
        (i) =>
          new Promise((r) => {
            i.addEventListener('load', r, { once: true });
            i.addEventListener('error', r, { once: true });
          }),
      ),
    );
  }

  /** Page (0-based, within this section) holding the given x position in the unshifted layout. */
  private pageOfX(x: number): number {
    const l = this.layout!;
    return Math.max(0, Math.min(this.pageCount - 1, Math.floor(x / l.pageW)));
  }

  private shift(): number {
    return this.shownPage * (this.layout?.pageW ?? 0);
  }

  pageOfFragment(id: string): number {
    const el = this.doc.getElementById(id) ?? this.doc.querySelector(`[name="${CSS.escape(id)}"]`);
    if (!el) return 0;
    const range = this.doc.createRange();
    range.selectNodeContents(el);
    const rect = range.getClientRects()[0] ?? el.getBoundingClientRect();
    return this.pageOfX(rect.left + this.shift() + 1);
  }

  pageOfNode(node: Node): number {
    const range = this.doc.createRange();
    range.selectNode(node);
    const rect = range.getClientRects()[0];
    return rect ? this.pageOfX(rect.left + this.shift() + 1) : 0;
  }

  /** Anchor for the first character shown on `page`. */
  anchorAt(page: number): Anchor | null {
    const l = this.layout;
    if (!l) return null;
    const start = page * l.pageW - this.shift();
    const walker = this.doc.createTreeWalker(this.doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const range = this.doc.createRange();
    const rightOf = (node: Text, offset: number) => {
      range.setStart(node, offset);
      range.setEnd(node, Math.min(offset + 1, node.length));
      const r = range.getClientRects()[0];
      return r ? r.left >= start - 1 : false;
    };
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      range.selectNodeContents(n);
      const rects = range.getClientRects();
      if (!rects.length || rects[rects.length - 1].right < start) continue;
      // Binary search the first character whose box starts on this page.
      let lo = 0;
      let hi = n.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rightOf(n, mid)) hi = mid;
        else lo = mid + 1;
      }
      return { path: nodePath(this.doc.body, n), offset: lo };
    }
    return null;
  }

  pageOfAnchor(a: Anchor): number {
    const node = nodeAtPath(this.doc.body, a.path);
    if (!node) return 0;
    const range = this.doc.createRange();
    const len = node.nodeType === Node.TEXT_NODE ? (node as Text).length : node.childNodes.length;
    const off = Math.min(a.offset, Math.max(0, len - 1));
    range.setStart(node, off);
    range.setEnd(node, Math.min(off + 1, len));
    const rect = range.getClientRects()[0];
    return rect ? this.pageOfX(rect.left + this.shift() + 1) : 0;
  }

  /**
   * SVG image string rendering `count` consecutive pages starting at `firstPage`,
   * Sized in CSS pixels; callers scale it when drawing. Uses data: URLs so it can be drawn to a canvas.
   */
  rasterSvg(firstPage: number, count: number, css: string): string {
    const l = this.layout!;
    this.rasterTemplate ??= buildSectionXhtml(this.book, this.res, this.href, 'data');
    const w = count * l.pageW;
    const override = `html{overflow:visible !important}body{transform:translateX(${-firstPage * l.pageW}px) !important}`;
    const html = this.rasterTemplate.replace(READER_PLACEHOLDER, css + override);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${l.viewH}" viewBox="0 0 ${w} ${l.viewH}">` +
      `<foreignObject x="0" y="0" width="${w}" height="${l.viewH}">${html}</foreignObject></svg>`
    );
  }

  destroy() {
    this.iframe.remove();
    if (this.displayUrl) URL.revokeObjectURL(this.displayUrl);
  }
}

function nodePath(root: Node, node: Node): number[] {
  const path: number[] = [];
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) {
    path.unshift(Array.prototype.indexOf.call(n.parentNode!.childNodes, n));
  }
  return path;
}

function nodeAtPath(root: Node, path: number[]): Node | null {
  let n: Node | null = root;
  for (const i of path) {
    n = n?.childNodes[i] ?? null;
    if (!n) return null;
  }
  return n;
}
