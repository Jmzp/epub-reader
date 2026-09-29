export type ThemeName = 'paper' | 'sepia' | 'night';
export type FontChoice = 'book' | 'serif' | 'sans';

export interface ReaderSettings {
  fontSize: number;
  fontFamily: FontChoice;
  lineHeight: number;
  margin: number; // multiplier: 0.6 narrow, 1 normal, 1.6 wide
  theme: ThemeName;
  spread: 'auto' | 'single';
  /** Clock, battery, chapter page and book percentage along the bottom edge. */
  statusBar: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 19,
  fontFamily: 'serif',
  lineHeight: 1.5,
  margin: 1,
  theme: 'paper',
  spread: 'auto',
  statusBar: true,
};

export interface Theme {
  paper: string;
  ink: string;
  link: string;
  desk: string;
  /** Paper color as linear 0..1 RGB for the shaders. */
  paperRgb: [number, number, number];
  /** How visible the mirrored text is through the back of a turning page (single-page mode). */
  showThrough: number;
  /** Fill of the text selection and of search hits. */
  selection: string;
}

const hex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

export const THEMES: Record<ThemeName, Theme> = {
  paper: { paper: '#fbf8f1', ink: '#1f1c17', link: '#7a4b12', desk: '#d9d3c7', paperRgb: hex('#fbf8f1'), showThrough: 0.3, selection: 'rgba(122,75,18,.22)' },
  sepia: { paper: '#f2e5c9', ink: '#3d2f1f', link: '#8a4f14', desk: '#cbbd9f', paperRgb: hex('#f2e5c9'), showThrough: 0.3, selection: 'rgba(122,75,18,.22)' },
  night: { paper: '#1f1e1c', ink: '#d6d1c6', link: '#d9a760', desk: '#0f0f0e', paperRgb: hex('#1f1e1c'), showThrough: 0.22, selection: 'rgba(217,167,96,.35)' },
};

const FONT_STACKS: Record<Exclude<FontChoice, 'book'>, string> = {
  serif: `Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Palatino, serif`,
  sans: `'Segoe UI Variable Text', 'Segoe UI', -apple-system, system-ui, Helvetica, Arial, sans-serif`,
};

export interface Layout {
  viewW: number;
  viewH: number;
  pageW: number;
  pagesPerView: 1 | 2;
  marginX: number;
  marginY: number;
  /** Identifies everything that affects pagination; texture caches are keyed by it. */
  key: string;
}

export function computeLayout(viewW: number, viewH: number, s: ReaderSettings): Layout {
  viewW = Math.floor(viewW);
  viewH = Math.floor(viewH);
  const spread = s.spread === 'auto' && viewW >= 900 && viewW > viewH * 1.15;
  const pagesPerView = spread ? 2 : 1;
  // Keep pages an integer width so columns land on exact pixels.
  const pageW = Math.floor(viewW / pagesPerView);
  viewW = pageW * pagesPerView;
  // Cap the line length (~70 characters) so a single wide page stays readable.
  const maxMeasure = s.fontSize * 36;
  const marginX = Math.round(Math.max(Math.max(20, Math.min(pageW * 0.08, 72)) * s.margin, (pageW - maxMeasure) / 2));
  const marginY = Math.round(Math.max(28, Math.min(viewH * 0.06, 64)));
  const key = [viewW, viewH, pagesPerView, marginX, marginY, s.fontSize, s.fontFamily, s.lineHeight, s.theme].join(':');
  return { viewW, viewH, pageW, pagesPerView, marginX, marginY, key };
}

/** CSS injected into every section document. Paginates with CSS multi-column. */
export function readerCss(l: Layout, s: ReaderSettings): string {
  const t = THEMES[s.theme];
  const colW = l.pageW - 2 * l.marginX;
  const font = s.fontFamily === 'book' ? '' : `font-family: ${FONT_STACKS[s.fontFamily]} !important;`;
  const textColors =
    s.theme === 'paper' ? '' : `body * { color: inherit !important; border-color: currentColor !important; }`;
  return `
html {
  width: ${l.viewW}px !important; height: ${l.viewH}px !important;
  margin: 0 !important; padding: 0 !important; overflow: hidden !important;
  background: ${t.paper} !important;
  -webkit-text-size-adjust: none; text-size-adjust: none;
}
body {
  box-sizing: border-box !important;
  width: ${l.viewW}px !important; height: ${l.viewH}px !important;
  max-width: none !important; min-height: 0 !important;
  margin: 0 !important; padding: ${l.marginY}px ${l.marginX}px !important;
  column-width: ${colW}px !important; column-gap: ${2 * l.marginX}px !important; column-fill: auto !important;
  overflow: visible !important;
  background: transparent !important; color: ${t.ink} !important;
  font-size: ${s.fontSize}px !important; line-height: ${s.lineHeight} !important; ${font}
  hyphens: auto; -webkit-hyphens: auto; orphans: 2; widows: 2;
  will-change: transform;
}
body * { background-color: transparent !important; max-width: ${colW}px; }
${textColors}
p, li, blockquote, dd { line-height: inherit; }
a, a * { color: ${t.link} !important; text-decoration: none; }
img, svg, video, canvas, image {
  max-width: 100% !important; max-height: ${l.viewH - 2 * l.marginY}px !important;
  object-fit: contain; break-inside: avoid; page-break-inside: avoid;
}
body > div:only-child > svg:only-child, body > svg:only-child {
  display: block; width: 100%; height: ${l.viewH - 2 * l.marginY - 4}px;
}
h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
::selection { background: ${t.selection}; }
`;
}
