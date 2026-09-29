export interface Vec2 {
  x: number;
  y: number;
}

export interface CurlGeometry {
  axis: Vec2;
  dir: Vec2;
  radius: number;
  /** 0 = sheet flat, 1 = sheet fully turned over. */
  progress: number;
}

const len = (x: number, y: number) => Math.hypot(x, y);

/**
 * Keeps the grabbed corner where a real sheet could be: it is attached along the hinge
 * (x = 0), so it can never be farther from either hinge corner than it originally was.
 */
export function constrain(corner: Vec2, f: Vec2, H: number): Vec2 {
  let x = Math.min(f.x, corner.x - 0.01);
  let y = f.y;
  for (let i = 0; i < 3; i++) {
    for (const hy of [0, H]) {
      const max = len(corner.x, corner.y - hy);
      const dx = x;
      const dy = y - hy;
      const d = len(dx, dy);
      if (d > max) {
        x = (dx / d) * max;
        y = hy + (dy / d) * max;
      }
    }
  }
  return { x, y };
}

/**
 * Cylinder page-curl geometry for a sheet of size W×H (sheet-local coords) whose
 * `corner` (a point on the free edge x = W) is being carried to `finger`.
 *
 * With a flat fold the axis is the perpendicular bisector of corner→finger. With a
 * cylinder of radius R, the flipped corner lands at the finger when the axis sits at
 * distance (L + πR)/2 from the corner, L = |corner − finger|.
 */
export function curlGeometry(corner: Vec2, finger: Vec2, W: number, H: number): CurlGeometry {
  const f = constrain(corner, finger, H);
  const vx = corner.x - f.x;
  const vy = corner.y - f.y;
  const L = len(vx, vy);
  const dir = L > 1e-3 ? { x: vx / L, y: vy / L } : { x: 1, y: 0 };
  const progress = Math.min(1, Math.max(0, L / (2 * W)));

  // Radius grows as the sheet lifts, then shrinks so the page lands flat.
  const rMax = Math.min(W, H) * 0.075 + 10;
  const lift = Math.min(1, L / (W * 0.28));
  const land = 1 - smoothstep(0.55, 1, progress);
  const radius = Math.max(0.75, rMax * lift * (0.12 + 0.88 * land));

  const dc = (L + Math.PI * radius) / 2;
  return {
    axis: { x: corner.x - dir.x * dc, y: corner.y - dir.y * dc },
    dir,
    radius,
    progress,
  };
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Critically damped 2D spring: follows the finger's release velocity without overshoot. */
export class Spring {
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  constructor(
    pos: Vec2,
    vel: Vec2,
    target: Vec2,
    private omega = 13,
  ) {
    this.pos = { ...pos };
    this.vel = { ...vel };
    this.target = { ...target };
  }

  /** Advances by dt seconds; returns true when settled. */
  step(dt: number): boolean {
    const k = this.omega * this.omega;
    const c = 2 * this.omega;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 240);
      for (const a of ['x', 'y'] as const) {
        const acc = -k * (this.pos[a] - this.target[a]) - c * this.vel[a];
        this.vel[a] += acc * h;
        this.pos[a] += this.vel[a] * h;
      }
      remaining -= h;
    }
    const done =
      len(this.pos.x - this.target.x, this.pos.y - this.target.y) < 0.5 && len(this.vel.x, this.vel.y) < 20;
    if (done) this.pos = { ...this.target };
    return done;
  }
}

/** Tracks recent pointer samples to estimate release velocity (px/s). */
export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];

  add(t: number, x: number, y: number) {
    this.samples.push({ t, x, y });
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
  }

  velocity(): Vec2 {
    const s = this.samples;
    if (s.length < 2) return { x: 0, y: 0 };
    const a = s[0];
    const b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt } : { x: 0, y: 0 };
  }

  reset() {
    this.samples = [];
  }
}
