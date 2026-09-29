import { resolveHref, resolvePath, type Book } from '../epub/book';
import type { Resources, UrlMode } from '../epub/resources';
import type { Layout } from './layout';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const READER_STYLE_ID = '__reader_style';
const READER_PLACEHOLDER = '/*__READER_CSS__*/';
const MARKS_ID = '__reader_marks';

/** A position inside a section that survives re-pagination (font/size changes). */
export interface Anchor {
  path: number[];
  offset: number;
}

/** A painted text range (highlight, search hit, live selection). */
export interface Mark {
  id: string;
  start: Anchor;
  end: Anchor;
  /** CSS color of the fill, drawn under the text. */
  color: string;
  /** Adds a thin line under the text (highlights carrying a note). */
  underline?: boolean;
}

interface MarkRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  underline: boolean;
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
  private marks: Mark[] = [];
  private transient: Mark[] = [];
  /** Mark rectangles in unshifted section coordinates (page p spans p*pageW..(p+1)*pageW). */
  private rects: MarkRect[] = [];

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
    this.paintMarks();
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
    const layer = this.doc.getElementById(MARKS_ID);
    if (layer) layer.style.transform = `translate3d(${-page * pageW}px,0,0)`;
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

  /* ---------------------------------------------------------------- Marks */

  /**
   * Persistent marks (highlights) are painted in the live DOM and in rasterized pages, so
   * they look the same at rest and while turning. Callers must drop this section's
   * textures after changing them.
   */
  setMarks(marks: Mark[]) {
    this.marks = marks;
    this.paintMarks();
  }

  /** Live-only marks (selection, search hit); they never reach the textures. */
  setTransientMarks(marks: Mark[]) {
    this.transient = marks;
    this.paintMarks();
  }

  /** Id of the persistent mark under a point of the current view, if any. */
  markAt(x: number, y: number): string | null {
    const ux = x + this.shift();
    const hit = this.rects.find((r) => ux >= r.x && ux <= r.x + r.w && y >= r.y - 2 && y <= r.y + r.h + 2);
    return hit?.id ?? null;
  }

  /** Bounding box, in view coordinates, of the part of a range visible on the current view. */
  viewRect(start: Anchor, end: Anchor): DOMRect | null {
    const range = this.range(start, end);
    if (!range) return null;
    const l = this.layout!;
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.right > 0 && r.left < l.viewW);
    if (!rects.length) return null;
    const x = Math.min(...rects.map((r) => r.left));
    const y = Math.min(...rects.map((r) => r.top));
    return new DOMRect(x, y, Math.max(...rects.map((r) => r.right)) - x, Math.max(...rects.map((r) => r.bottom)) - y);
  }

  private paintMarks() {
    if (!this.layout || !this.doc?.body) return;
    this.rects = this.measureMarks(this.marks);
    const live = [...this.rects, ...this.measureMarks(this.transient)];
    let layer = this.doc.getElementById(MARKS_ID);
    if (!layer) {
      layer = this.doc.createElementNS(XHTML_NS, 'div') as HTMLElement;
      layer.id = MARKS_ID;
      // Outside <body> so node paths (anchors) never change, and before it so marks sit under the text.
      this.doc.documentElement.insertBefore(layer, this.doc.body);
    }
    layer.style.cssText = `position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;transform:translate3d(${-this.shift()}px,0,0)`;
    layer.innerHTML = marksHtml(live);
  }

  private measureMarks(marks: Mark[]): MarkRect[] {
    const out: MarkRect[] = [];
    const shift = this.shift();
    for (const m of marks) {
      const range = this.range(m.start, m.end);
      if (!range) continue;
      // Per text node: a range spanning elements also reports their whole boxes.
      for (const r of textRects(range)) {
        out.push({ id: m.id, x: r.left + shift, y: r.top, w: r.width, h: r.height, color: m.color, underline: !!m.underline });
      }
    }
    return out;
  }

  /** DOM range for two anchors of this section. */
  range(start: Anchor, end: Anchor): Range | null {
    const a = nodeAtPath(this.doc.body, start.path);
    const b = nodeAtPath(this.doc.body, end.path);
    if (!a || !b) return null;
    const range = this.doc.createRange();
    try {
      range.setStart(a, Math.min(start.offset, nodeLength(a)));
      range.setEnd(b, Math.min(end.offset, nodeLength(b)));
    } catch {
      return null;
    }
    return range.collapsed ? null : range;
  }

  anchorOf(node: Node, offset: number): Anchor {
    return { path: nodePath(this.doc.body, node), offset };
  }

  /** Up to `max` characters of text starting at an anchor (bookmark labels). */
  textFrom(a: Anchor, max = 90): string {
    const start = nodeAtPath(this.doc.body, a.path);
    if (!start) return '';
    const walker = this.doc.createTreeWalker(this.doc.body, NodeFilter.SHOW_TEXT);
    walker.currentNode = start;
    let out = start.nodeType === Node.TEXT_NODE ? (start as Text).data.slice(a.offset) : '';
    for (let n = walker.nextNode(); n && out.length < max * 2; n = walker.nextNode()) out += ' ' + (n as Text).data;
    const text = out.replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max).replace(/\s\S*$/, '') + '…' : text;
  }

  /** Text position under a point of the current view (view coordinates). */
  caretAt(x: number, y: number): { node: Text; offset: number } | null {
    const d = this.doc as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (d.caretPositionFromPoint) {
      const p = d.caretPositionFromPoint(x, y);
      if (p) ({ offsetNode: node, offset } = p);
    } else if (d.caretRangeFromPoint) {
      const r = d.caretRangeFromPoint(x, y);
      if (r) ({ startContainer: node, startOffset: offset } = r);
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !this.doc.body.contains(node)) return null;
    return { node: node as Text, offset };
  }

  /** Text of the section as flat text nodes (for search). */
  static textNodes(root: Node): Text[] {
    const out: Text[] = [];
    const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
    return out;
  }

  /**
   * SVG image string rendering `count` consecutive pages starting at `firstPage`,
   * Sized in CSS pixels; callers scale it when drawing. Uses data: URLs so it can be drawn to a canvas.
   */
  rasterSvg(firstPage: number, count: number, css: string): string {
    const l = this.layout!;
    this.rasterTemplate ??= buildSectionXhtml(this.book, this.res, this.href, 'data');
    const w = count * l.pageW;
    const shift = -firstPage * l.pageW;
    const override = `html{overflow:visible !important}body{transform:translateX(${shift}px) !important}`;
    let html = this.rasterTemplate.replace(READER_PLACEHOLDER, css + override);
    if (this.rects.length) {
      const layer = `<div xmlns="${XHTML_NS}" style="position:absolute;left:0;top:0;width:0;height:0;transform:translateX(${shift}px)">${marksHtml(this.rects)}</div>`;
      html = html.replace(/<body[\s>]/, (m) => layer + m);
    }
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

function nodeLength(n: Node): number {
  return n.nodeType === Node.TEXT_NODE ? (n as Text).length : n.childNodes.length;
}

function textRects(range: Range): DOMRect[] {
  const doc = range.startContainer.ownerDocument!;
  const root = range.commonAncestorContainer;
  const nodes =
    root.nodeType === Node.TEXT_NODE ? [root as Text] : Section.textNodes(root).filter((t) => range.intersectsNode(t));
  const out: DOMRect[] = [];
  const sub = doc.createRange();
  for (const t of nodes) {
    sub.selectNodeContents(t);
    if (t === range.startContainer) sub.setStart(t, range.startOffset);
    if (t === range.endContainer) sub.setEnd(t, range.endOffset);
    if (sub.collapsed) continue;
    for (const r of sub.getClientRects()) if (r.width > 0.5) out.push(r);
  }
  return out;
}

function marksHtml(rects: MarkRect[]): string {
  let html = '';
  for (const r of rects) {
    const box = `position:absolute;left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${r.w.toFixed(1)}px;height:${r.h.toFixed(1)}px;background:${r.color};border-radius:2px`;
    html += `<div style="${box}"></div>`;
    if (r.underline) {
      html += `<div style="position:absolute;left:${r.x.toFixed(1)}px;top:${(r.y + r.h - 1.5).toFixed(1)}px;width:${r.w.toFixed(1)}px;height:1.5px;background:${r.color};filter:saturate(3) brightness(0.7)"></div>`;
    }
  }
  return html;
}

export function nodePath(root: Node, node: Node): number[] {
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
