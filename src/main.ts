import { parseEpub, type Book, type TocEntry } from './epub/book';
import { openedFile, toggleFullscreen } from './platform';
import { Reader, type ReaderPosition } from './reader/Reader';
import type { ReaderSettings } from './reader/layout';
import { bookBytes, coverBlob, library, prefs, type LibraryBook, type SavedLocation } from './storage';

const app = document.getElementById('app')!;
let settings = prefs.settings();
let reader: Reader | null = null;
let cleanupReader: (() => void) | null = null;

const ICONS = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  toc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  type: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h11v2M9.5 5v14M7 19h5M14 12v-1h7v1M17.5 11v8M16 19h3"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
};

function applyUiTheme() {
  document.documentElement.dataset.theme = settings.theme;
}
applyUiTheme();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]) {
  const e: HTMLElementTagNameMap[K] = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function bookId(book: Book, size: number): string {
  return (book.metadata.identifier || `${book.metadata.title}|${book.metadata.creator}|${size}`).trim();
}

/* ------------------------------------------------------------------ Library */

async function showLibrary(error?: string) {
  cleanupReader?.();
  localStorage.removeItem('lastOpen');
  applyUiTheme();
  app.replaceChildren();
  const input = el('input', { type: 'file', accept: '.epub,application/epub+zip', multiple: true, hidden: true });
  const openBtn = el('button', { className: 'btn primary', textContent: 'Abrir EPUB' });
  openBtn.onclick = () => input.click();
  input.onchange = () => input.files && importFiles([...input.files]);
  const root = el('div', { className: 'library' }, el('header', {}, el('h1', { textContent: 'Biblioteca' }), openBtn, input));
  if (error) root.append(el('p', { className: 'error', textContent: error }));

  const books = await library.list().catch(() => [] as LibraryBook[]);
  if (!books.length) {
    root.append(el('div', { className: 'drop' }, 'Arrastra un archivo .epub aquí o pulsa «Abrir EPUB».'));
  } else {
    const grid = el('div', { className: 'grid' });
    for (const b of books) grid.append(bookCard(b));
    root.append(grid);
  }

  root.addEventListener('dragover', (e) => {
    e.preventDefault();
    root.classList.add('dragging');
  });
  root.addEventListener('dragleave', () => root.classList.remove('dragging'));
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    root.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.name.toLowerCase().endsWith('.epub'));
    if (files.length) void importFiles(files);
  });
  app.append(root);
}

function bookCard(b: LibraryBook): HTMLElement {
  const cover = el('div', { className: 'cover' });
  const coverImg = coverBlob(b);
  if (coverImg) {
    const url = URL.createObjectURL(coverImg);
    cover.append(el('img', { src: url, alt: '', onload: () => URL.revokeObjectURL(url) }));
  } else {
    cover.style.padding = '16px';
    cover.textContent = b.title;
  }
  const remove = el('button', { className: 'remove', title: 'Quitar de la biblioteca', textContent: '×' });
  remove.onclick = async (e) => {
    e.stopPropagation();
    await library.remove(b.id);
    void showLibrary();
  };
  const bar = el('div', { className: 'bar' }, el('i'));
  (bar.firstChild as HTMLElement).style.width = `${Math.round((b.progress ?? 0) * 100)}%`;
  const card = el(
    'div',
    { className: 'card', tabIndex: 0 },
    cover,
    remove,
    el('div', { className: 'title', textContent: b.title }),
    el('div', { className: 'author', textContent: b.author }),
    bar,
  );
  card.onclick = () => void openFromLibrary(b.id);
  card.onkeydown = (e) => e.key === 'Enter' && void openFromLibrary(b.id);
  return card;
}

async function importFiles(files: File[]) {
  let last: string | null = null;
  try {
    for (const f of files) last = await importBytes(new Uint8Array(await f.arrayBuffer()));
  } catch (err) {
    console.error(err);
    return showLibrary(`No se pudo abrir el archivo: ${(err as Error).message}`);
  }
  if (last) await openFromLibrary(last);
}

async function importBytes(bytes: Uint8Array): Promise<string> {
  const book = parseEpub(bytes);
  const id = bookId(book, bytes.length);
  const existing = await library.get(id);
  const cover = book.coverHref
    ? { bytes: book.bytes(book.coverHref).slice().buffer as ArrayBuffer, type: book.mediaType(book.coverHref) }
    : undefined;
  await library.put({
    id,
    title: book.metadata.title,
    author: book.metadata.creator,
    cover,
    data: bytes.slice().buffer as ArrayBuffer,
    addedAt: existing?.addedAt ?? Date.now(),
    openedAt: Date.now(),
    progress: existing?.progress,
  });
  return id;
}

async function openFromLibrary(id: string) {
  const entry = await library.get(id);
  if (!entry) return showLibrary();
  const bytes = await bookBytes(entry);
  await library.put({ ...entry, openedAt: Date.now() });
  openReader(parseEpub(bytes), entry);
}

/* ------------------------------------------------------------------- Reader */

function openReader(book: Book, entry: LibraryBook) {
  cleanupReader?.();
  app.replaceChildren();
  localStorage.setItem('lastOpen', entry.id);
  const shell = el('div', { className: 'reader-shell ui-hidden' });
  shell.style.cssText = 'position:absolute;inset:0';
  app.append(shell);

  const loading = el('div', { className: 'loading', textContent: 'Abriendo…' });
  shell.append(loading);

  // Top bar
  const title = el('div', { className: 'bar-title', textContent: book.metadata.title });
  const iconBtn = (svg: string, label: string) => {
    const b = el('button', { className: 'icon', title: label, ariaLabel: label });
    b.innerHTML = svg;
    return b;
  };
  const backBtn = iconBtn(ICONS.back, 'Biblioteca');
  const tocBtn = iconBtn(ICONS.toc, 'Índice');
  const setBtn = iconBtn(ICONS.type, 'Ajustes de lectura');
  const fullBtn = iconBtn(ICONS.full, 'Pantalla completa (F11)');
  const top = el('div', { className: 'chrome top' }, el('div', { className: 'bar-inner' }, backBtn, tocBtn, title, setBtn, fullBtn));

  // Bottom bar
  const chapter = el('span', { className: 'chapter' });
  const slider = el('input', { type: 'range', min: '0', max: '1000', value: '0' });
  const pos = el('span', { className: 'pos' });
  const bottom = el('div', { className: 'chrome bottom' }, el('div', { className: 'bar-inner' }, chapter, slider, pos));

  // Panels
  const toc = el('div', { className: 'panel toc', hidden: true });
  const settingsPanel = el('div', { className: 'panel settings', hidden: true });
  shell.append(top, bottom, toc, settingsPanel);

  const flatToc: { entry: TocEntry; depth: number }[] = [];
  const walk = (list: TocEntry[], depth: number) =>
    list.forEach((e) => {
      flatToc.push({ entry: e, depth });
      walk(e.children, depth + 1);
    });
  walk(book.toc, 0);

  let uiVisible = false;
  const setUi = (v: boolean) => {
    uiVisible = v;
    shell.classList.toggle('ui-hidden', !v);
    if (!v) closePanels();
  };
  const closePanels = () => {
    toc.hidden = true;
    settingsPanel.hidden = true;
    tocBtn.classList.remove('active');
    setBtn.classList.remove('active');
  };
  const togglePanel = (panel: HTMLElement, btn: HTMLElement) => {
    const open = !!panel.hidden;
    closePanels();
    panel.hidden = !open;
    btn.classList.toggle('active', open);
  };

  let lastPos: ReaderPosition | null = null;
  let saveTimer = 0;
  const onLocation = (loc: SavedLocation, p: ReaderPosition) => {
    lastPos = p;
    prefs.saveLocation(entry.id, loc);
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void library.put({ ...entry, progress: loc.progress, openedAt: Date.now() }), 800);
    const lastShown = Math.min(p.pageCount, p.page + p.pagesPerView);
    pos.textContent = `${lastShown > p.page + 1 ? `${p.page + 1}–${lastShown}` : p.page + 1} / ${p.pageCount}`;
    slider.value = String(p.pageCount > 1 ? Math.round((p.page / (p.pageCount - 1)) * 1000) : 0);
    const current = currentTocEntry(flatToc, p, reader);
    chapter.textContent = current?.label ?? '';
    for (const a of toc.querySelectorAll('a')) a.classList.toggle('current', a.dataset.href === current?.href);
  };

  reader = new Reader(shell, book, settings, { onLocation, onTapCenter: () => setUi(!uiVisible) });
  shell.insertBefore(reader.el, shell.firstChild);

  for (const { entry: e, depth } of flatToc) {
    const a = el('a', { textContent: e.label });
    a.dataset.href = e.href;
    if (depth) a.className = 'sub';
    a.style.paddingLeft = `${12 + depth * 16}px`;
    a.onclick = () => {
      void reader?.goTo(e.href);
      setUi(false);
    };
    toc.append(a);
  }
  if (!flatToc.length) toc.append(el('div', { textContent: 'Este libro no tiene índice.' }));

  buildSettings(settingsPanel, (s) => {
    settings = s;
    prefs.saveSettings(s);
    applyUiTheme();
    reader?.setSettings(s);
  });

  backBtn.onclick = () => void showLibrary();
  tocBtn.onclick = () => togglePanel(toc, tocBtn);
  setBtn.onclick = () => togglePanel(settingsPanel, setBtn);
  fullBtn.onclick = () => void toggleFullscreen();
  slider.oninput = () => reader?.seekSection(Number(slider.value) / 1000);

  const onKey = (e: KeyboardEvent) => {
    if (!reader) return;
    if (e.key === 'F11') {
      e.preventDefault();
      void toggleFullscreen();
      return;
    }
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (['ArrowRight', 'PageDown', ' ', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      reader.next();
    } else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      reader.prev();
    } else if (e.key === 'Escape') {
      setUi(false);
    }
  };
  window.addEventListener('keydown', onKey);
  const saveNow = () => lastPos && library.put({ ...entry, progress: lastPos.progress, openedAt: Date.now() });

  cleanupReader = () => {
    window.removeEventListener('keydown', onKey);
    clearTimeout(saveTimer);
    void saveNow();
    reader?.destroy();
    reader = null;
    cleanupReader = null;
  };

  // Double rAF: the shell must have its final size before paginating.
  requestAnimationFrame(() =>
    requestAnimationFrame(async () => {
      await reader?.open(prefs.location(entry.id));
      loading.remove();
    }),
  );
}

function currentTocEntry(flat: { entry: TocEntry }[], p: ReaderPosition, r: Reader | null): TocEntry | undefined {
  let best: TocEntry | undefined;
  for (const { entry } of flat) {
    const [path, frag] = entry.href.split('#');
    if (path !== p.href) continue;
    const page = frag && r ? r.pageOfFragment(frag) : 0;
    if (page <= p.page + p.pagesPerView - 1) best = entry;
  }
  return best;
}

function buildSettings(panel: HTMLElement, onChange: (s: ReaderSettings) => void) {
  const seg = <T extends string | number>(label: string, key: keyof ReaderSettings, options: [T, string][]) => {
    const wrap = el('div', {}, el('label', { textContent: label }));
    const row = el('div', { className: 'seg' });
    for (const [value, text] of options) {
      const b = el('button', { textContent: text });
      b.classList.toggle('on', settings[key] === value);
      b.onclick = () => {
        row.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onChange({ ...settings, [key]: value });
      };
      row.append(b);
    }
    wrap.append(row);
    return wrap;
  };

  const sizeRow = el('div', { className: 'seg' });
  const sizeLabel = el('button', { textContent: `${settings.fontSize}px`, disabled: true });
  const size = (d: number) => {
    const fontSize = Math.max(12, Math.min(34, settings.fontSize + d));
    sizeLabel.textContent = `${fontSize}px`;
    onChange({ ...settings, fontSize });
  };
  sizeRow.append(el('button', { textContent: 'A−', onclick: () => size(-1) }), sizeLabel, el('button', { textContent: 'A+', onclick: () => size(1) }));

  panel.append(
    el('div', {}, el('label', { textContent: 'Tamaño' }), sizeRow),
    seg('Tipografía', 'fontFamily', [
      ['serif', 'Serif'],
      ['sans', 'Sans'],
      ['book', 'Libro'],
    ]),
    seg('Interlineado', 'lineHeight', [
      [1.3, 'Compacto'],
      [1.5, 'Normal'],
      [1.75, 'Amplio'],
    ]),
    seg('Márgenes', 'margin', [
      [0.6, 'Estrechos'],
      [1, 'Normales'],
      [1.6, 'Anchos'],
    ]),
    seg('Tema', 'theme', [
      ['paper', 'Papel'],
      ['sepia', 'Sepia'],
      ['night', 'Noche'],
    ]),
    seg('Páginas', 'spread', [
      ['auto', 'Libro abierto'],
      ['single', 'Una página'],
    ]),
  );
}

/* --------------------------------------------------------------------- Boot */

async function boot() {
  try {
    const file = await openedFile();
    if (file) {
      const id = await importBytes(file.bytes);
      return openFromLibrary(id);
    }
  } catch (err) {
    console.error(err);
  }
  const last = localStorage.getItem('lastOpen');
  if (last && (await library.get(last).catch(() => undefined))) return openFromLibrary(last);
  return showLibrary();
}

void boot();
