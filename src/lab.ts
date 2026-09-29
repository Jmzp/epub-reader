// Isolated playground for tuning the page curl with synthetic pages.
import { CurlRenderer } from './reader/curl/CurlRenderer';
import { PageTurner, type Dir, type TurnSource } from './reader/curl/PageTurner';
import { THEMES } from './reader/layout';
import { curlGeometry } from './reader/curl/physics';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const stage = document.getElementById('stage')!;
const statsEl = document.getElementById('stats')!;
const renderer = new CurlRenderer(canvas);
const theme = THEMES.paper;
renderer.setTheme(theme.desk, theme.paperRgb, theme.showThrough);

let spread = false;
let view = 0;
const PAGES = 40;
const textures = new Map<number, WebGLTexture>();
const LOREM =
  'The death of the Lord Jesus Christ is a subject of never-failing interest to all who study prayerfully the Scripture of Truth. This is so not only because the believer\'s all, both for time and eternity, depends upon it, but also because of its transcendent uniqueness. ';

function pageTexture(n: number, w: number, h: number): WebGLTexture {
  const key = n * 1e8 + w * 1e4 + h;
  let t = textures.get(key);
  if (t) return t;
  const dpr = devicePixelRatio;
  const c = document.createElement('canvas');
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  g.fillStyle = theme.paper;
  g.fillRect(0, 0, w, h);
  g.fillStyle = theme.ink;
  g.font = 'bold 28px Georgia';
  g.fillText(`Page ${n + 1}`, 40, 70);
  g.font = '18px Georgia';
  const words = LOREM.repeat(12).split(' ');
  let line = '';
  let y = 110;
  for (const word of words) {
    if (g.measureText(line + word).width > w - 80) {
      g.fillText(line, 40, y);
      line = '';
      y += 28;
      if (y > h - 50) break;
    }
    line += word + ' ';
  }
  g.font = '14px Georgia';
  g.fillText(String(n + 1), w / 2 - 6, h - 20);
  t = renderer.createTexture(c);
  textures.set(key, t);
  return t;
}

const ppv = () => (spread ? 2 : 1);
const pageW = () => Math.floor(innerWidth / ppv());

const source: TurnSource = {
  hasView: (dir: Dir) => (view + dir) * ppv() >= 0 && (view + dir) * ppv() < PAGES,
  textures: (off) => {
    const first = (view + off) * ppv();
    return Array.from({ length: ppv() }, (_, i) => pageTexture(first + i, pageW(), innerHeight));
  },
  ensure: async () => {},
  commit: (dir) => {
    view += dir;
    drawRest();
  },
  begin: () => {},
  end: () => drawRest(),
};

const turner = new PageTurner(renderer, stage, source);

function drawRest() {
  const W = pageW();
  const tex = source.textures(0)!;
  renderer.render({
    pages: tex.map((t, i) => ({ tex: t, x: i * W, y: 0, w: W, h: innerHeight })),
    sheet: null,
    spineX: spread ? W : -1e5,
    gutter: spread ? 1 : 0,
  });
}

function relayout() {
  turner.setLayout({ viewW: pageW() * ppv(), viewH: innerHeight, pageW: pageW(), spread });
  drawRest();
}

let frames = 0;
let worst = 0;
let last = performance.now();
turner.onFrameStats = (ms) => {
  worst = Math.max(worst, ms);
};
(function loop(now: number) {
  frames++;
  if (now - last > 500) {
    statsEl.textContent = `${Math.round((frames * 1000) / (now - last))} fps · cpu ${worst.toFixed(1)} ms`;
    frames = 0;
    worst = 0;
    last = now;
  }
  requestAnimationFrame(loop);
})(performance.now());

document.getElementById('mode')!.onclick = () => {
  spread = !spread;
  view = 0;
  relayout();
};
document.getElementById('next')!.onclick = () => turner.flip(1);
document.getElementById('prev')!.onclick = () => turner.flip(-1);
document.getElementById('hud')!.addEventListener('pointerdown', (e) => e.stopPropagation());
addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') turner.flip(1);
  if (e.key === 'ArrowLeft') turner.flip(-1);
});
addEventListener('resize', relayout);
relayout();

// Debug: freeze a pose. `fx, fy` = where the grabbed corner is carried (sheet-local).
(window as unknown as Record<string, unknown>).pose = (fx: number, fy: number, cy = innerHeight) => {
  const W = pageW();
  const H = innerHeight;
  const cur = source.textures(0)!;
  const nxt = source.textures(1)!;
  const geometry = curlGeometry({ x: W, y: cy }, { x: fx, y: fy }, W, H);
  renderer.render(
    spread
      ? {
          pages: [
            { tex: cur[0], x: 0, y: 0, w: W, h: H },
            { tex: nxt[1], x: W, y: 0, w: W, h: H },
          ],
          sheet: { front: cur[1], back: nxt[0], origin: { x: W, y: 0 }, width: W, height: H, geometry },
          spineX: W,
          gutter: 1,
        }
      : {
          pages: [{ tex: nxt[0], x: 0, y: 0, w: W, h: H }],
          sheet: { front: cur[0], back: null, origin: { x: 0, y: 0 }, width: W, height: H, geometry },
          spineX: -1e5,
          gutter: 0,
        },
  );
  return geometry;
};
