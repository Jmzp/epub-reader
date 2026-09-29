import type { CurlRenderer } from './curl/CurlRenderer';
import type { Section } from './section';

const MAX_TEXTURES = 24;
/** Keep rasterized SVG bitmaps below this width in device pixels (WebKit rasterizes eagerly). */
const MAX_WINDOW_PX = 8192;

interface Entry {
  tex: WebGLTexture;
  used: number;
}

/**
 * Rasterizes pages into GPU textures, a few pages per SVG decode.
 * Laying out a long chapter inside an SVG image costs tens of milliseconds, so pages
 * are rendered in windows and prefetched while the reader is idle — never mid-turn.
 */
export class PageTextures {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private blank?: WebGLTexture;
  private scratch = document.createElement('canvas');
  private clock = 0;
  /** Keys that must survive eviction (textures in use by a running animation). */
  private pinned = new Set<string>();

  constructor(
    private renderer: CurlRenderer,
    private paper: () => string,
    private css: () => string,
  ) {}

  private key(section: number, page: number) {
    return `${section}:${page}`;
  }

  get(section: Section, page: number): WebGLTexture | null {
    if (page >= section.pageCount) return this.blankTexture(section);
    const e = this.cache.get(this.key(section.index, page));
    if (!e) return null;
    e.used = ++this.clock;
    return e.tex;
  }

  /** Resolves once the page's texture is available. */
  async request(section: Section, page: number): Promise<void> {
    if (this.get(section, page)) return;
    const layout = section.layoutInfo!;
    const scale = window.devicePixelRatio || 1;
    const count = Math.max(1, Math.min(6, Math.floor(MAX_WINDOW_PX / (layout.pageW * scale))));
    const first = Math.floor(page / count) * count;
    const wkey = `${section.index}:w${first}`;
    let p = this.inflight.get(wkey);
    if (!p) {
      const gen = this.generation;
      p = this.queue = this.queue
        .then(() => (gen === this.generation ? this.rasterize(section, first, count, scale, gen) : undefined))
        .catch((err) => console.error('[pages] rasterize failed', err))
        .finally(() => this.inflight.delete(wkey));
      this.inflight.set(wkey, p);
    }
    await p;
  }

  private async rasterize(section: Section, first: number, count: number, scale: number, gen: number) {
    const layout = section.layoutInfo!;
    const last = Math.min(section.pageCount, first + count);
    if (first >= last) return;
    const svg = section.rasterSvg(first, last - first, this.css());
    const img = new Image();
    img.decoding = 'async';
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();

    const w = Math.round(layout.pageW * scale);
    const h = Math.round(layout.viewH * scale);
    const c = this.scratch;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext('2d')!;
    for (let page = first; page < last; page++) {
      // Stale work (layout, theme or marks changed meanwhile) must not repopulate the cache.
      if (gen !== this.generation) return;
      const k = this.key(section.index, page);
      if (this.cache.has(k)) continue;
      g.fillStyle = this.paper();
      g.fillRect(0, 0, w, h);
      // Destination-only drawImage: WebKit and Chromium disagree on the units of an SVG
      // image's source rect, but both rasterize the vector image crisply at the target size.
      g.drawImage(img, -(page - first) * layout.pageW * scale, 0, (last - first) * layout.pageW * scale, h);
      this.cache.set(k, { tex: this.renderer.createTexture(c), used: ++this.clock });
      // Yield between uploads so a pending frame is never delayed by more than one page.
      await new Promise((r) => setTimeout(r, 0));
    }
    this.evict();
  }

  /** Protects these pages from eviction until `unpinAll()`. */
  pin(section: Section, page: number) {
    this.pinned.add(this.key(section.index, page));
  }

  unpinAll() {
    this.pinned.clear();
    this.evict();
  }

  blankTexture(section: Section): WebGLTexture {
    if (!this.blank) {
      const l = section.layoutInfo!;
      const c = document.createElement('canvas');
      c.width = 4;
      c.height = Math.max(4, Math.round((4 * l.viewH) / l.pageW));
      const g = c.getContext('2d')!;
      g.fillStyle = this.paper();
      g.fillRect(0, 0, c.width, c.height);
      this.blank = this.renderer.createTexture(c);
    }
    return this.blank;
  }

  private evict() {
    if (this.cache.size <= MAX_TEXTURES) return;
    const entries = [...this.cache.entries()]
      .filter(([k]) => !this.pinned.has(k))
      .sort((a, b) => a[1].used - b[1].used);
    for (const [k, e] of entries.slice(0, Math.max(0, this.cache.size - MAX_TEXTURES))) {
      this.renderer.deleteTexture(e.tex);
      this.cache.delete(k);
    }
  }

  /** The section's content changed (highlights): its textures are stale. */
  dropSection(index: number) {
    this.generation++;
    this.inflight.clear();
    for (const [k, e] of this.cache) {
      if (!k.startsWith(`${index}:`)) continue;
      this.renderer.deleteTexture(e.tex);
      this.cache.delete(k);
      this.pinned.delete(k);
    }
  }

  /** Layout or theme changed: every texture is stale. */
  clear() {
    this.generation++;
    for (const e of this.cache.values()) this.renderer.deleteTexture(e.tex);
    this.cache.clear();
    this.inflight.clear();
    this.pinned.clear();
    if (this.blank) this.renderer.deleteTexture(this.blank);
    this.blank = undefined;
  }
}
