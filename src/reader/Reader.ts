import type { Book } from '../epub/book';
import { Resources } from '../epub/resources';
import type { SavedLocation } from '../storage';
import { CurlRenderer } from './curl/CurlRenderer';
import { PageTurner, type Dir, type TurnSource, type ViewTextures } from './curl/PageTurner';
import { gutterDarkness } from './curl/shaders';
import { computeLayout, readerCss, THEMES, type Layout, type ReaderSettings } from './layout';
import { PageTextures } from './pageCache';
import { Section } from './section';

export interface ReaderPosition {
  section: number;
  sectionCount: number;
  page: number;
  pageCount: number;
  pagesPerView: number;
  progress: number;
  href: string;
}

export interface ReaderCallbacks {
  onLocation(loc: SavedLocation, pos: ReaderPosition): void;
  onTapCenter(): void;
}

interface View {
  section: Section;
  page: number;
}

export class Reader {
  readonly el: HTMLElement;
  private frames: HTMLElement;
  private canvas: HTMLCanvasElement;
  private gutter: HTMLElement;
  private inputLayer: HTMLElement;
  private renderer: CurlRenderer;
  private turner: PageTurner;
  private textures: PageTextures;
  private res: Resources;
  private sections = new Map<number, Section>();
  private loading = new Map<number, Promise<Section | null>>();
  private cur = { section: 0, page: 0 };
  private layout!: Layout;
  private css = '';
  private resizeObserver: ResizeObserver;
  private resizeTimer = 0;
  private prefetchTimer = 0;
  private wheelLock = 0;
  private wheelAccum = 0;
  private destroyed = false;
  private jumping = false;

  constructor(
    host: HTMLElement,
    private book: Book,
    private settings: ReaderSettings,
    private cb: ReaderCallbacks,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'reader';
    this.frames = document.createElement('div');
    this.frames.className = 'reader-frames';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'reader-curl';
    this.inputLayer = document.createElement('div');
    this.inputLayer.className = 'reader-input';
    this.gutter = document.createElement('div');
    this.gutter.className = 'reader-gutter';
    this.el.append(this.frames, this.gutter, this.canvas, this.inputLayer);
    host.appendChild(this.el);

    this.res = new Resources(book);
    this.renderer = new CurlRenderer(this.canvas);
    this.textures = new PageTextures(
      this.renderer,
      () => THEMES[this.settings.theme].paper,
      () => this.css,
    );
    this.turner = new PageTurner(this.renderer, this.inputLayer, this.turnSource());
    this.applyTheme();
    this.inputLayer.addEventListener('wheel', this.onWheel, { passive: false });
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.relayout(), 120);
    });
  }

  get ppv(): number {
    return this.layout.pagesPerView;
  }

  async open(loc: SavedLocation | null) {
    this.layout = this.measure();
    this.css = readerCss(this.layout, this.settings);
    this.turner.setLayout(this.turnLayout());
    const first = this.book.spine.findIndex((s) => s.linear);
    const index = loc && loc.section < this.book.spine.length ? loc.section : Math.max(0, first);
    const section = await this.ensureSection(index);
    if (!section) return;
    let page = 0;
    if (loc) {
      page = loc.anchor ? section.pageOfAnchor(loc.anchor) : Math.floor(loc.fraction * section.pageCount);
    }
    this.cur = { section: index, page: this.align(page) };
    this.show();
    this.resizeObserver.observe(this.el);
    this.afterMove();
  }

  next() {
    void this.turn(1);
  }

  prev() {
    void this.turn(-1);
  }

  /** Right after opening, the neighbouring chapter may still be loading: wait for it. */
  private async turn(dir: Dir) {
    const s = this.sections.get(this.cur.section);
    const crossing = !s || (dir === 1 ? this.cur.page + this.ppv >= s.pageCount : this.cur.page === 0);
    if (crossing) await this.ensureSection(this.cur.section + dir);
    this.turner.flip(dir);
  }

  /**
   * Jumps to an href (TOC, links). With `animate`, riffles through a few real pages in
   * between, like thumbing through a book to reach the chapter.
   */
  async goTo(href: string, animate = true) {
    if (this.turner.busy || this.jumping) return;
    const [path, frag] = href.split('#');
    const index = this.book.spine.findIndex((s) => s.href === path);
    if (index < 0) return;
    this.jumping = true;
    try {
      const section = await this.ensureSection(index);
      if (!section || this.destroyed) return;
      const target = { section: index, page: this.alignIn(section, frag ? section.pageOfFragment(frag) : 0) };
      const order = Math.sign(target.section - this.cur.section) || Math.sign(target.page - this.cur.page);
      if (order === 0) return;
      if (animate) await this.riffleTo(target, order as Dir);
      else {
        this.cur = target;
        this.show();
        this.afterMove();
      }
    } finally {
      this.jumping = false;
    }
  }

  private async riffleTo(target: { section: number; page: number }, dir: Dir) {
    const views = this.riffleViews(target, dir);
    const pages = (v: View) => Array.from({ length: this.ppv }, (_, i) => v.page + i);
    const request = (v: View) => Promise.all(pages(v).map((p) => this.textures.request(v.section, p)));
    for (const v of views) pages(v).forEach((p) => this.textures.pin(v.section, p));
    // The first and last sheets must be exact; in-between ones are a blur, so don't wait long.
    await Promise.all([request(views[0]), request(views[views.length - 1])]);
    await Promise.race([Promise.all(views.slice(1, -1).map(request)), new Promise((r) => setTimeout(r, 120))]);
    if (this.destroyed) return;
    const textures = views.map((v) =>
      pages(v).map((p) => this.textures.get(v.section, p) ?? this.textures.blankTexture(v.section)),
    );
    await new Promise<void>((resolve) =>
      this.turner.riffle(textures, dir, () => {
        this.cur = target;
        resolve();
      }),
    );
    this.textures.unpinAll();
  }

  /** [current, up to 3 evenly spaced views in between, target], in travel order. */
  private riffleViews(target: { section: number; page: number }, dir: Dir): View[] {
    const cur = this.sections.get(this.cur.section)!;
    const dest = this.sections.get(target.section)!;
    const between: View[] = [];
    const push = (section: Section, from: number, to: number) => {
      for (let p = from; p < to; p += this.ppv) between.push({ section, page: p });
    };
    if (cur === dest) {
      const [lo, hi] = dir === 1 ? [this.cur.page, target.page] : [target.page, this.cur.page];
      push(cur, lo + this.ppv, hi);
    } else if (dir === 1) {
      push(cur, this.cur.page + this.ppv, cur.pageCount);
      push(dest, 0, target.page);
    } else {
      push(dest, target.page + this.ppv, dest.pageCount);
      push(cur, 0, this.cur.page);
    }
    if (dir === -1) between.reverse();
    const n = Math.min(3, between.length);
    const picked = Array.from({ length: n }, (_, i) => between[Math.round(((i + 1) * (between.length - 1)) / (n + 1))]);
    return [{ section: cur, page: this.cur.page }, ...picked, { section: dest, page: target.page }];
  }

  /** Page of an element id in the current section (for highlighting the TOC). */
  pageOfFragment(id: string): number {
    return this.sections.get(this.cur.section)?.pageOfFragment(id) ?? 0;
  }

  /** Jump to a fraction (0..1) of the current section. */
  seekSection(fraction: number) {
    const s = this.sections.get(this.cur.section);
    if (!s || this.turner.busy) return;
    this.cur.page = this.align(Math.round(fraction * (s.pageCount - 1)));
    this.show();
    this.afterMove();
  }

  setSettings(s: ReaderSettings) {
    this.settings = s;
    this.applyTheme();
    this.relayout(true);
  }

  private applyTheme() {
    const t = THEMES[this.settings.theme];
    this.renderer.setTheme(t.desk, t.paperRgb, t.showThrough);
    this.el.style.background = t.paper;
  }

  private measure(): Layout {
    return computeLayout(this.el.clientWidth || innerWidth, this.el.clientHeight || innerHeight, this.settings);
  }

  private turnLayout() {
    const l = this.layout;
    return { viewW: l.viewW, viewH: l.viewH, pageW: l.pageW, spread: l.pagesPerView === 2 };
  }

  private relayout(force = false) {
    if (this.destroyed) return;
    if (this.turner.busy) {
      this.resizeTimer = window.setTimeout(() => this.relayout(force), 150);
      return;
    }
    const next = this.measure();
    if (!force && next.key === this.layout.key) return;
    const section = this.sections.get(this.cur.section);
    const anchor = section?.anchorAt(this.cur.page) ?? null;
    this.layout = next;
    this.css = readerCss(next, this.settings);
    this.textures.clear();
    this.turner.setLayout(this.turnLayout());
    for (const s of this.sections.values()) s.applyLayout(next, this.css);
    if (section) this.cur.page = this.align(anchor ? section.pageOfAnchor(anchor) : 0);
    this.show();
    this.afterMove();
  }

  private alignIn(section: Section, page: number): number {
    return Math.max(0, Math.min(section.lastViewPage(), Math.floor(page / this.ppv) * this.ppv));
  }

  private align(page: number): number {
    const s = this.sections.get(this.cur.section);
    const max = s ? s.lastViewPage() : page;
    return Math.max(0, Math.min(max, Math.floor(page / this.ppv) * this.ppv));
  }

  private ensureSection(index: number): Promise<Section | null> {
    if (index < 0 || index >= this.book.spine.length) return Promise.resolve(null);
    const existing = this.sections.get(index);
    if (existing) return Promise.resolve(existing);
    let p = this.loading.get(index);
    if (!p) {
      const section = new Section(index, this.book.spine[index].href, this.book, this.res, this.frames);
      p = section
        .load(this.layout, this.css)
        .then(() => {
          if (this.destroyed) return null;
          if (section.layoutInfo?.key !== this.layout.key) section.applyLayout(this.layout, this.css);
          this.sections.set(index, section);
          return section;
        })
        .catch((err) => {
          console.error(`[reader] failed to load ${section.href}`, err);
          section.destroy();
          return null;
        })
        .finally(() => this.loading.delete(index));
      this.loading.set(index, p);
    }
    return p;
  }

  private viewAt(off: -1 | 0 | 1): View | null {
    const s = this.sections.get(this.cur.section);
    if (!s) return null;
    const page = this.cur.page + off * this.ppv;
    if (off === 0) return { section: s, page };
    if (page >= 0 && page < s.pageCount) return { section: s, page };
    const other = this.sections.get(this.cur.section + off);
    if (!other) return null;
    return { section: other, page: off === 1 ? 0 : other.lastViewPage() };
  }

  private turnSource(): TurnSource {
    return {
      hasView: (dir) => this.viewAt(dir) !== null,
      textures: (off) => {
        const v = this.viewAt(off);
        if (!v) return null;
        const out: ViewTextures = [];
        for (let i = 0; i < this.ppv; i++) {
          const t = this.textures.get(v.section, v.page + i);
          if (!t) return null;
          out.push(t);
        }
        return out;
      },
      ensure: async (offsets) => {
        const jobs: Promise<void>[] = [];
        for (const off of offsets) {
          const v = this.viewAt(off);
          if (!v) continue;
          for (let i = 0; i < this.ppv; i++) jobs.push(this.textures.request(v.section, v.page + i));
        }
        await Promise.all(jobs);
      },
      commit: (dir: Dir) => {
        const v = this.viewAt(dir);
        if (v) this.cur = { section: v.section.index, page: v.page };
      },
      begin: () => {
        clearTimeout(this.prefetchTimer);
        this.canvas.style.visibility = 'visible';
      },
      end: () => {
        this.show();
        this.canvas.style.visibility = 'hidden';
        this.afterMove();
      },
      tapCenter: () => this.cb.onTapCenter(),
      tap: (p) => this.followLink(p.x, p.y),
    };
  }

  private followLink(x: number, y: number): boolean {
    const s = this.sections.get(this.cur.section);
    const a = s?.doc.elementFromPoint(x, y)?.closest('a[data-epub-href]');
    const href = a?.getAttribute('data-epub-href');
    if (!href) return false;
    void this.goTo(href);
    return true;
  }

  /** Makes the live DOM show the current view. */
  /** Spine shading over the live DOM in two-page mode (the canvas draws its own while turning). */
  private updateGutter() {
    const { pageW, viewW, pagesPerView } = this.layout;
    if (pagesPerView !== 2) {
      this.gutter.style.display = 'none';
      return;
    }
    // Black at alpha a multiplies the page by (1 - a): exactly what the shader does.
    const reach = pageW * 0.6;
    const stops: string[] = [];
    for (let i = 0; i <= 24; i++) {
      const d = reach * (i / 24) ** 2;
      const a = gutterDarkness(d, pageW).toFixed(4);
      stops.unshift(`rgba(0,0,0,${a}) ${((pageW - d) / viewW) * 100}%`);
      stops.push(`rgba(0,0,0,${a}) ${((pageW + d) / viewW) * 100}%`);
    }
    stops.unshift('rgba(0,0,0,0) 0%');
    stops.push('rgba(0,0,0,0) 100%');
    this.gutter.style.cssText = `display:block;width:${viewW}px;height:${this.layout.viewH}px;background:linear-gradient(to right,${[...new Set(stops)].join(',')})`;
  }

  private show() {
    this.updateGutter();
    for (const s of this.sections.values()) {
      const active = s.index === this.cur.section;
      s.iframe.style.visibility = active ? 'visible' : 'hidden';
      if (active) s.showPage(this.cur.page);
    }
  }

  private afterMove() {
    this.report();
    // Keep only the neighbours of the current section in memory.
    for (const [i, s] of this.sections) {
      if (Math.abs(i - this.cur.section) > 1) {
        s.destroy();
        this.sections.delete(i);
      }
    }
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = window.setTimeout(() => this.prefetch(), 80);
  }

  private async prefetch() {
    if (this.destroyed || this.turner.busy) return;
    const src = this.turnSource();
    await Promise.all([this.ensureSection(this.cur.section + 1), this.ensureSection(this.cur.section - 1)]);
    if (this.turner.busy) return;
    // Current + next first (forward turns are far more common), then previous.
    await src.ensure([0, 1]);
    if (!this.turner.busy) await src.ensure([-1]);
  }

  private report() {
    const s = this.sections.get(this.cur.section);
    if (!s) return;
    const n = this.book.spine.length;
    const frac = s.pageCount > 1 ? this.cur.page / s.pageCount : 0;
    const progress = Math.min(1, (this.cur.section + frac) / n);
    this.cb.onLocation(
      { section: this.cur.section, anchor: s.anchorAt(this.cur.page), fraction: frac, progress },
      {
        section: this.cur.section,
        sectionCount: n,
        page: this.cur.page,
        pageCount: s.pageCount,
        pagesPerView: this.ppv,
        progress,
        href: s.href,
      },
    );
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.turner.busy || performance.now() < this.wheelLock) return;
    this.wheelAccum += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(this.wheelAccum) > 40) {
      this.turner.flip(this.wheelAccum > 0 ? 1 : -1);
      this.wheelAccum = 0;
      this.wheelLock = performance.now() + 450;
    }
  };

  destroy() {
    this.destroyed = true;
    clearTimeout(this.resizeTimer);
    clearTimeout(this.prefetchTimer);
    this.resizeObserver.disconnect();
    this.turner.destroy();
    this.textures.clear();
    for (const s of this.sections.values()) s.destroy();
    this.sections.clear();
    this.res.dispose();
    this.el.remove();
    this.renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
