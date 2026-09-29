import { CurlRenderer, type Frame } from './CurlRenderer';
import { Spring, VelocityTracker, curlGeometry, type Vec2 } from './physics';

export type Dir = 1 | -1;

/** Textures of a view (1 page in single mode, [left, right] in spread mode). */
export type ViewTextures = WebGLTexture[];

export interface TurnSource {
  hasView(dir: Dir): boolean;
  /** Synchronous: returns null when a texture is not rasterized yet. */
  textures(offset: -1 | 0 | 1): ViewTextures | null;
  ensure(offsets: (-1 | 0 | 1)[]): Promise<void>;
  /** The turn completed: advance the current view. */
  commit(dir: Dir): void;
  /** The canvas is about to cover the live DOM (first frame already rendered). */
  begin(): void;
  /** The animation ended; the live DOM should be shown again. */
  end(): void;
  /** Tap in the middle of the page. */
  tapCenter?(): void;
  /** Any tap; return true when handled (e.g. a link was followed). */
  tap?(p: Vec2): boolean;
}

export interface TurnLayout {
  viewW: number;
  viewH: number;
  pageW: number;
  spread: boolean;
}

type State =
  | { kind: 'idle' }
  | { kind: 'pressed'; id: number; start: Vec2; t: number }
  | { kind: 'dragging'; id: number | null; dir: Dir; start: Vec2; corner: Vec2; cornerMode: boolean; ready: boolean }
  | { kind: 'settling'; dir: Dir; corner: Vec2; spring: Spring; complete: boolean }
  | {
      kind: 'riffle';
      dir: Dir;
      /** Views in travel order: [current, ...intermediate, target]. */
      views: ViewTextures[];
      index: number;
      corner: Vec2;
      spring: Spring;
      onDone: () => void;
    };

const DRAG_SLOP = 6;
const FLICK = 350; // px/s

/**
 * Turns pointer input into a physically plausible page curl.
 * Rendering happens in requestAnimationFrame only while a turn is in progress;
 * input handlers just record positions.
 */
export class PageTurner {
  private state: State = { kind: 'idle' };
  private layout: TurnLayout = { viewW: 1, viewH: 1, pageW: 1, spread: false };
  private finger: Vec2 = { x: 0, y: 0 };
  private tracker = new VelocityTracker();
  private raf = 0;
  private lastT = 0;
  private queued: Dir | null = null;
  private canvasShown = false;
  onFrameStats?: (ms: number) => void;

  constructor(
    private renderer: CurlRenderer,
    private input: HTMLElement,
    private source: TurnSource,
  ) {
    input.style.touchAction = 'none';
    input.addEventListener('pointerdown', this.onDown);
    input.addEventListener('pointermove', this.onMove);
    input.addEventListener('pointerup', this.onUp);
    input.addEventListener('pointercancel', this.onUp);
  }

  get busy(): boolean {
    return this.state.kind !== 'idle' && this.state.kind !== 'pressed';
  }

  setLayout(l: TurnLayout) {
    this.layout = l;
    this.renderer.resize(l.viewW, l.viewH);
  }

  /** Animated turn (tap, keyboard, wheel). */
  flip(dir: Dir) {
    if (this.state.kind === 'riffle') return;
    if (this.state.kind === 'settling' || this.state.kind === 'dragging') {
      if (this.state.kind === 'settling') this.queued = dir;
      return;
    }
    if (!this.source.hasView(dir)) return;
    const { W, H } = this.sheetSize();
    const corner = { x: W, y: H };
    const start = dir === 1 ? corner : { x: -W, y: H };
    const target = dir === 1 ? { x: -W, y: H } : corner;
    // An upward kick makes the corner arc like a hand-turned page.
    const vel = { x: (dir === 1 ? -1 : 1) * W * 2.2, y: -H * 0.9 };
    this.whenReady(dir, () => {
      this.state = { kind: 'settling', dir, corner, spring: new Spring(start, vel, target, 11), complete: true };
      this.kick();
    });
  }

  /**
   * Riffles through several sheets in a row (e.g. jumping to a chapter from the TOC).
   * `views` are the textures of each view in travel order, first = current, last = target.
   * `onDone` must make the target the current view; the live DOM is shown right after.
   */
  riffle(views: ViewTextures[], dir: Dir, onDone: () => void) {
    if (this.busy || views.length < 2) {
      onDone();
      this.source.end();
      return;
    }
    const { H } = this.sheetSize();
    const corner = { x: this.sheetSize().W, y: H };
    this.state = { kind: 'riffle', dir, views, index: 0, corner, spring: this.riffleSpring(dir, 0, views.length - 1), onDone };
    this.kick();
  }

  /** Spring for sheet k of n: gentle first and last sheets, quick ones in between. */
  private riffleSpring(dir: Dir, k: number, n: number): Spring {
    const { W, H } = this.sheetSize();
    const corner = { x: W, y: H };
    const turned = { x: -W, y: H };
    const pace = n > 1 ? Math.sin((Math.PI * k) / (n - 1)) : 0;
    const omega = 17 + 21 * pace;
    const kick = omega / 11;
    const vel = { x: (dir === 1 ? -1 : 1) * W * 2.2 * kick, y: -H * 0.9 * kick };
    return dir === 1 ? new Spring(corner, vel, turned, omega) : new Spring(turned, vel, corner, omega);
  }

  private sheetSize() {
    return { W: this.layout.pageW, H: this.layout.viewH };
  }

  private sheetOrigin(): Vec2 {
    return { x: this.layout.spread ? this.layout.pageW : 0, y: 0 };
  }

  private offsets(dir: Dir): [-1 | 0 | 1, -1 | 0 | 1] {
    return dir === 1 ? [0, 1] : [-1, 0];
  }

  private whenReady(dir: Dir, run: () => void) {
    const [a, b] = this.offsets(dir);
    if (this.source.textures(a) && this.source.textures(b)) run();
    else this.source.ensure([a, b]).then(run, () => {});
  }

  private local(e: PointerEvent): Vec2 {
    const r = this.input.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent) => {
    if (e.button > 0 || this.state.kind !== 'idle') return;
    this.state = { kind: 'pressed', id: e.pointerId, start: this.local(e), t: e.timeStamp };
    this.tracker.reset();
    this.tracker.add(e.timeStamp, e.clientX, e.clientY);
    try {
      this.input.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers (tests) cannot be captured.
    }
  };

  private onMove = (e: PointerEvent) => {
    const s = this.state;
    if ((s.kind !== 'pressed' && s.kind !== 'dragging') || s.id !== e.pointerId) return;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ce of events.length ? events : [e]) this.tracker.add(ce.timeStamp, ce.clientX, ce.clientY);
    const p = this.local(e);
    // Predicted points shave a frame of latency off pen/touch input.
    const pred = e.getPredictedEvents?.().at(-1);
    this.finger = pred
      ? { x: p.x + (pred.clientX - e.clientX) / 2, y: p.y + (pred.clientY - e.clientY) / 2 }
      : p;

    if (s.kind === 'pressed') {
      const dx = p.x - s.start.x;
      if (Math.hypot(dx, p.y - s.start.y) < DRAG_SLOP || Math.abs(dx) < 2) return;
      const dir: Dir = dx < 0 ? 1 : -1;
      if (!this.source.hasView(dir)) return;
      const { W, H } = this.sheetSize();
      const band = H * 0.22;
      const cornerMode = s.start.y < band || s.start.y > H - band;
      const cy = cornerMode ? (s.start.y < band ? 0 : H) : s.start.y;
      this.state = { kind: 'dragging', id: s.id, dir, start: s.start, corner: { x: W, y: cy }, cornerMode, ready: false };
      this.whenReady(dir, () => {
        const st = this.state;
        if (st.kind === 'dragging' && st.dir === dir) st.ready = true;
      });
      this.kick();
    }
  };

  private onUp = (e: PointerEvent) => {
    const s = this.state;
    if ((s.kind !== 'pressed' && s.kind !== 'dragging') || s.id !== e.pointerId) return;
    if (this.input.hasPointerCapture(e.pointerId)) this.input.releasePointerCapture(e.pointerId);

    if (s.kind === 'pressed') {
      this.state = { kind: 'idle' };
      if (e.type === 'pointercancel' || e.timeStamp - s.t > 500) return;
      if (this.source.tap?.(s.start)) return;
      const x = s.start.x / this.layout.viewW;
      if (x > 0.7) this.flip(1);
      else if (x < 0.3) this.flip(-1);
      else this.source.tapCenter?.();
      return;
    }

    const v = this.tracker.velocity();
    const f = this.fingerToCorner(s);
    const { W } = this.sheetSize();
    const g = curlGeometry(s.corner, f, W, this.layout.viewH);
    let complete: boolean;
    if (s.dir === 1) complete = v.x < -FLICK || (v.x < FLICK && g.progress > 0.3);
    else complete = v.x > FLICK || (v.x > -FLICK && g.progress < 0.75);
    if (e.type === 'pointercancel') complete = false;

    if (!s.ready) {
      // Textures never arrived during the drag: nothing was shown, just jump.
      this.state = { kind: 'idle' };
      if (complete) this.whenReady(s.dir, () => this.flip(s.dir));
      return;
    }
    const flat = s.corner;
    const turned = { x: -W, y: s.corner.y };
    const target = (s.dir === 1) === complete ? turned : flat;
    const k = s.dir === -1 && !this.layout.spread ? 2 : 1;
    const vel = { x: v.x * k, y: s.cornerMode ? v.y : v.y * 0.25 };
    this.state = { kind: 'settling', dir: s.dir, corner: s.corner, spring: new Spring(f, vel, target), complete };
    this.kick();
  };

  /** Where the grabbed corner of the sheet goes for the current finger position (sheet-local). */
  private fingerToCorner(s: Extract<State, { kind: 'dragging' }>): Vec2 {
    const { W } = this.sheetSize();
    const dx = this.finger.x - s.start.x;
    const dy = this.finger.y - s.start.y;
    const ky = s.cornerMode ? 1 : 0.25;
    if (s.dir === 1) return { x: s.corner.x + dx, y: s.corner.y + dy * ky };
    // Turning back: the previous sheet starts fully turned. In single-page mode its
    // turned position is off-screen, so the fold (half-way) follows the finger.
    const kx = this.layout.spread ? 1 : 2;
    return { x: -W + dx * kx, y: s.corner.y + dy * ky };
  }

  private kick() {
    if (!this.raf) {
      this.lastT = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  private tick = (now: number) => {
    this.raf = 0;
    const t0 = performance.now();
    const dt = Math.max(0, (now - this.lastT) / 1000);
    this.lastT = now;
    const s = this.state;
    let corner: Vec2 | null = null;
    let f: Vec2 | null = null;
    let dir: Dir = 1;

    if (s.kind === 'dragging') {
      if (s.ready) {
        corner = s.corner;
        f = this.fingerToCorner(s);
        dir = s.dir;
      }
      this.raf = requestAnimationFrame(this.tick);
    } else if (s.kind === 'riffle') {
      const n = s.views.length - 1;
      const last = s.index === n - 1;
      const done = s.spring.step(dt);
      const { W } = this.sheetSize();
      // Intermediate sheets hand over to the next one just before landing, so the riffle flows.
      const landed = done || (!last && Math.abs(s.spring.pos.x - s.spring.target.x) < W * 0.05);
      if (landed && last) {
        this.state = { kind: 'idle' };
        s.onDone();
        this.canvasShown = false;
        this.source.end();
        return;
      }
      if (landed) {
        s.index++;
        s.spring = this.riffleSpring(s.dir, s.index, n);
      }
      const [a, b] = s.dir === 1 ? [s.views[s.index], s.views[s.index + 1]] : [s.views[s.index + 1], s.views[s.index]];
      this.drawTextures(a, b, s.corner, s.spring.pos);
      this.onFrameStats?.(performance.now() - t0);
      this.raf = requestAnimationFrame(this.tick);
      return;
    } else if (s.kind === 'settling') {
      const done = s.spring.step(dt);
      corner = s.corner;
      f = s.spring.pos;
      dir = s.dir;
      if (done) {
        this.finish(s);
        return;
      }
      this.raf = requestAnimationFrame(this.tick);
    }

    if (corner && f) {
      this.draw(dir, corner, f);
      this.onFrameStats?.(performance.now() - t0);
    }
  };

  private draw(dir: Dir, corner: Vec2, f: Vec2) {
    const [a, b] = this.offsets(dir);
    const ta = this.source.textures(a);
    const tb = this.source.textures(b);
    if (ta && tb) this.drawTextures(ta, tb, corner, f);
  }

  /** `ta` = the earlier view (its right page is the sheet's front), `tb` = the later one. */
  private drawTextures(ta: ViewTextures, tb: ViewTextures, corner: Vec2, f: Vec2) {
    const { W, H } = this.sheetSize();
    const l = this.layout;
    const geometry = curlGeometry(corner, f, W, H);
    const frame: Frame = l.spread
      ? {
          pages: [
            { tex: ta[0], x: 0, y: 0, w: W, h: H },
            { tex: tb[1], x: W, y: 0, w: W, h: H },
          ],
          sheet: { front: ta[1], back: tb[0], origin: this.sheetOrigin(), width: W, height: H, geometry },
          spineX: W,
          gutter: 1,
        }
      : {
          pages: [{ tex: tb[0], x: 0, y: 0, w: W, h: H }],
          sheet: { front: ta[0], back: null, origin: this.sheetOrigin(), width: W, height: H, geometry },
          spineX: -1e5,
          gutter: 0,
        };
    this.renderer.render(frame);
    if (!this.canvasShown) {
      this.canvasShown = true;
      this.source.begin();
    }
  }

  private finish(s: Extract<State, { kind: 'settling' }>) {
    this.state = { kind: 'idle' };
    // Completed forward turn or completed backward turn both change the view.
    const turned = s.complete;
    if (turned) this.source.commit(s.dir);
    this.canvasShown = false;
    this.source.end();
    const q = this.queued;
    this.queued = null;
    if (q) this.flip(q);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.input.removeEventListener('pointerdown', this.onDown);
    this.input.removeEventListener('pointermove', this.onMove);
    this.input.removeEventListener('pointerup', this.onUp);
    this.input.removeEventListener('pointercancel', this.onUp);
  }
}
