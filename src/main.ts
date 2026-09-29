import {
  annotationStore,
  byPosition,
  newId,
  SWATCHES,
  toMarkdown,
  type Highlight,
  type HighlightColor,
} from './annotations';
import { parseEpub, type Book, type TocEntry } from './epub/book';
import { openedFile, toggleFullscreen } from './platform';
import { Reader, type ReaderPosition, type SearchHit, type SelectionInfo } from './reader/Reader';
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
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  notes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>',
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
  const searchBtn = iconBtn(ICONS.search, 'Buscar en el libro (Ctrl+F)');
  const notesBtn = iconBtn(ICONS.notes, 'Notas y marcadores');
  const markBtn = iconBtn(ICONS.bookmark, 'Marcar esta página');
  const setBtn = iconBtn(ICONS.type, 'Ajustes de lectura');
  const fullBtn = iconBtn(ICONS.full, 'Pantalla completa (F11)');
  const top = el(
    'div',
    { className: 'chrome top' },
    el('div', { className: 'bar-inner' }, backBtn, tocBtn, title, searchBtn, notesBtn, markBtn, setBtn, fullBtn),
  );

  // Bottom bar
  const chapter = el('span', { className: 'chapter' });
  const slider = el('input', { type: 'range', min: '0', max: '1000', value: '0' });
  const pos = el('span', { className: 'pos' });
  const bottom = el('div', { className: 'chrome bottom' }, el('div', { className: 'bar-inner' }, chapter, slider, pos));

  // Panels
  const toc = el('div', { className: 'panel toc', hidden: true });
  const settingsPanel = el('div', { className: 'panel settings', hidden: true });
  const searchPanel = el('div', { className: 'panel side search', hidden: true });
  const notesPanel = el('div', { className: 'panel side notes', hidden: true });
  const selMenu = el('div', { className: 'selmenu', hidden: true });
  const noteEditor = el('div', { className: 'panel note-editor', hidden: true });
  const toast = el('div', { className: 'toast', hidden: true });
  const status = el('div', { className: 'status' });
  shell.append(status, top, bottom, toc, settingsPanel, searchPanel, notesPanel, selMenu, noteEditor, toast);

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
  const panels: [HTMLElement, HTMLElement][] = [
    [toc, tocBtn],
    [settingsPanel, setBtn],
    [searchPanel, searchBtn],
    [notesPanel, notesBtn],
  ];
  const closePanels = () => {
    for (const [panel, btn] of panels) {
      panel.hidden = true;
      btn.classList.remove('active');
    }
  };
  const togglePanel = (panel: HTMLElement, btn: HTMLElement) => {
    const open = !!panel.hidden;
    closePanels();
    panel.hidden = !open;
    btn.classList.toggle('active', open);
  };

  let lastPos: ReaderPosition | null = null;
  let currentChapter = '';
  let saveTimer = 0;
  const ann = annotationStore.load(entry.id);
  const onLocation = (loc: SavedLocation, p: ReaderPosition) => {
    lastPos = p;
    prefs.saveLocation(entry.id, loc);
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void library.put({ ...entry, progress: loc.progress, openedAt: Date.now() }), 800);
    const lastShown = Math.min(p.pageCount, p.page + p.pagesPerView);
    pos.textContent = `${lastShown > p.page + 1 ? `${p.page + 1}–${lastShown}` : p.page + 1} / ${p.pageCount}`;
    slider.value = String(p.pageCount > 1 ? Math.round((p.page / (p.pageCount - 1)) * 1000) : 0);
    const current = currentTocEntry(flatToc, p, reader);
    currentChapter = current?.label ?? '';
    chapter.textContent = currentChapter;
    for (const a of toc.querySelectorAll('a')) a.classList.toggle('current', a.dataset.href === current?.href);
    updateStatus();
    updateRibbon();
  };

  reader = new Reader(shell, book, settings, {
    onLocation,
    onTapCenter: () => setUi(!uiVisible),
    onSelection: (sel) => (sel ? showSelectionMenu(sel) : hideSelMenu()),
    onHighlightTap: (id, rect) => {
      const h = ann.highlights.find((x) => x.id === id);
      if (h) showHighlightMenu(h, rect);
    },
  });
  shell.insertBefore(reader.el, shell.firstChild);
  reader.setHighlights(ann.highlights);

  /* ---- Annotations */

  const persist = () => {
    annotationStore.save(entry.id, ann);
    reader?.setHighlights(ann.highlights);
    updateRibbon();
    if (!notesPanel.hidden) renderNotes();
  };

  const flashToast = (text: string) => {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 1600);
  };
  let toastTimer = 0;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea', { value: text });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    flashToast('Copiado');
  };

  const hideSelMenu = () => {
    selMenu.hidden = true;
  };

  /** Floating menu above (or below) a rect in view coordinates. */
  const placeMenu = (rect: DOMRect) => {
    selMenu.hidden = false;
    const w = selMenu.offsetWidth;
    const h = selMenu.offsetHeight;
    const x = Math.max(8, Math.min(shell.clientWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    const above = rect.top - h - 12;
    const y = above > 8 ? above : Math.min(shell.clientHeight - h - 8, rect.bottom + 12);
    selMenu.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  const swatches = (current: HighlightColor | null, pick: (c: HighlightColor) => void) =>
    (Object.keys(SWATCHES) as HighlightColor[]).map((c) => {
      const b = el('button', { className: `swatch-btn${c === current ? ' on' : ''}`, title: 'Resaltar', ariaLabel: `Resaltar ${c}` });
      b.style.setProperty('--c', SWATCHES[c]);
      b.onclick = () => pick(c);
      return b;
    });

  const menuBtn = (label: string, run: () => void) => el('button', { className: 'menu-btn', textContent: label, onclick: run });

  const showSelectionMenu = (sel: SelectionInfo) => {
    const make = (color: HighlightColor): Highlight => {
      const h: Highlight = {
        id: newId(),
        section: sel.section,
        start: sel.start,
        end: sel.end,
        text: sel.text,
        color,
        chapter: currentChapter || undefined,
        createdAt: Date.now(),
      };
      ann.highlights.push(h);
      reader?.clearSelection();
      persist();
      return h;
    };
    selMenu.replaceChildren(
      ...swatches(null, (c) => make(c)),
      el('span', { className: 'sep' }),
      menuBtn('Nota', () => editNote(make('yellow'))),
      menuBtn('Copiar', () => {
        void copy(sel.text);
        reader?.clearSelection();
      }),
      menuBtn('Buscar', () => {
        reader?.clearSelection();
        openSearch(sel.text);
      }),
    );
    placeMenu(sel.rect);
  };

  const showHighlightMenu = (h: Highlight, rect: DOMRect) => {
    selMenu.replaceChildren(
      ...swatches(h.color, (c) => {
        h.color = c;
        persist();
        hideSelMenu();
      }),
      el('span', { className: 'sep' }),
      menuBtn(h.note ? 'Editar nota' : 'Nota', () => editNote(h)),
      menuBtn('Copiar', () => {
        void copy(h.text);
        hideSelMenu();
      }),
      menuBtn('Borrar', () => {
        ann.highlights = ann.highlights.filter((x) => x !== h);
        persist();
        hideSelMenu();
      }),
    );
    placeMenu(rect);
  };

  const editNote = (h: Highlight) => {
    hideSelMenu();
    const area = el('textarea', { value: h.note ?? '', placeholder: 'Escribe una nota…', rows: 5 });
    const close = () => (noteEditor.hidden = true);
    const save = () => {
      h.note = area.value.trim() || undefined;
      persist();
      close();
    };
    area.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
      if (e.key === 'Escape') close();
      e.stopPropagation();
    };
    noteEditor.replaceChildren(
      el('blockquote', { textContent: h.text.length > 220 ? h.text.slice(0, 220) + '…' : h.text }),
      area,
      el('div', { className: 'row' }, el('button', { className: 'btn', textContent: 'Cancelar', onclick: close }), el('button', { className: 'btn primary', textContent: 'Guardar', onclick: save })),
    );
    noteEditor.hidden = false;
    area.focus();
  };

  /* ---- Bookmarks */

  const bookmarkHere = () => ann.bookmarks.find((b) => reader?.inView(b.section, b.anchor));
  const updateRibbon = () => {
    const on = !!bookmarkHere();
    reader?.setRibbon(on);
    markBtn.classList.toggle('on', on);
    markBtn.title = on ? 'Quitar marcador' : 'Marcar esta página';
  };
  const toggleBookmark = () => {
    const existing = bookmarkHere();
    if (existing) ann.bookmarks = ann.bookmarks.filter((b) => b !== existing);
    else {
      const here = reader?.currentAnchor();
      if (!here) return;
      ann.bookmarks.push({ id: newId(), ...here, chapter: currentChapter || undefined, createdAt: Date.now() });
    }
    persist();
  };

  /* ---- Notes panel */

  let notesTab: 'highlights' | 'bookmarks' = 'highlights';
  const renderNotes = () => {
    const tab = (id: typeof notesTab, label: string, n: number) =>
      el('button', {
        className: notesTab === id ? 'on' : '',
        textContent: `${label} (${n})`,
        onclick: () => {
          notesTab = id;
          renderNotes();
        },
      });
    const list = el('div', { className: 'list' });
    const item = (onGo: () => void, onDelete: () => void, ...kids: (Node | string)[]) => {
      const del = el('button', { className: 'del', title: 'Borrar', textContent: '×' });
      del.onclick = (e) => {
        e.stopPropagation();
        onDelete();
      };
      const row = el('div', { className: 'item', tabIndex: 0 }, ...kids, del);
      row.onclick = () => {
        onGo();
        setUi(false);
      };
      return row;
    };
    if (notesTab === 'highlights') {
      for (const h of [...ann.highlights].sort(byPosition((x) => x.start))) {
        const quote = el('div', { className: 'quote', textContent: h.text });
        quote.style.setProperty('--c', SWATCHES[h.color]);
        list.append(
          item(
            () => void reader?.goToAnchor(h.section, h.start),
            () => {
              ann.highlights = ann.highlights.filter((x) => x !== h);
              persist();
            },
            el('div', { className: 'meta', textContent: h.chapter ?? '' }),
            quote,
            ...(h.note ? [el('div', { className: 'note', textContent: h.note })] : []),
          ),
        );
      }
      if (!ann.highlights.length) list.append(el('p', { className: 'empty', textContent: 'Mantén presionado el texto para subrayar o añadir una nota.' }));
    } else {
      for (const b of [...ann.bookmarks].sort(byPosition((x) => x.anchor))) {
        list.append(
          item(
            () => void reader?.goToAnchor(b.section, b.anchor),
            () => {
              ann.bookmarks = ann.bookmarks.filter((x) => x !== b);
              persist();
            },
            el('div', { className: 'meta', textContent: b.chapter ?? '' }),
            el('div', { className: 'snippet', textContent: b.snippet }),
          ),
        );
      }
      if (!ann.bookmarks.length) list.append(el('p', { className: 'empty', textContent: 'Pulsa el marcador de la barra superior para guardar una página.' }));
    }
    const exportBtn = el('button', {
      className: 'btn',
      textContent: 'Copiar notas (Markdown)',
      disabled: !ann.highlights.length,
      onclick: () => void copy(toMarkdown(book.metadata.title, book.metadata.creator, ann)),
    });
    notesPanel.replaceChildren(
      el('div', { className: 'tabs' }, tab('highlights', 'Notas', ann.highlights.length), tab('bookmarks', 'Marcadores', ann.bookmarks.length)),
      list,
      el('div', { className: 'foot' }, exportBtn),
    );
  };

  /* ---- Search */

  const searchInput = el('input', { type: 'search', placeholder: 'Buscar en el libro…' });
  const searchInfo = el('div', { className: 'meta' });
  const results = el('div', { className: 'list' });
  searchPanel.append(el('div', { className: 'search-row' }, searchInput), searchInfo, results);
  let searchRun = 0;
  const runSearch = async () => {
    const run = ++searchRun;
    const q = searchInput.value.trim();
    results.replaceChildren();
    if (q.length < 2) {
      searchInfo.textContent = '';
      return;
    }
    searchInfo.textContent = 'Buscando…';
    const hits: SearchHit[] = (await reader?.search(q, () => run !== searchRun)) ?? [];
    if (run !== searchRun) return;
    searchInfo.textContent = hits.length ? `${hits.length}${hits.length >= 300 ? '+' : ''} resultados` : 'Sin resultados';
    for (const hit of hits) {
      const [before, match, after] = hit.context;
      const row = el('div', { className: 'item', tabIndex: 0 }, el('div', { className: 'snippet' }, before, el('mark', { textContent: match }), after));
      row.onclick = () => {
        void reader?.goToAnchor(hit.section, hit.start, hit.end);
        setUi(false);
      };
      results.append(row);
    }
  };
  let searchTimer = 0;
  searchInput.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 350);
  };
  searchInput.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      void runSearch();
    }
    if (e.key === 'Escape') setUi(false);
  };
  const openSearch = (text?: string) => {
    setUi(true);
    closePanels();
    searchPanel.hidden = false;
    searchBtn.classList.add('active');
    if (text !== undefined) {
      searchInput.value = text.replace(/\s+/g, ' ').trim().slice(0, 80);
      void runSearch();
    }
    searchInput.focus();
    searchInput.select();
  };

  /* ---- Status bar */

  let battery: { level: number } | null = null;
  const updateStatus = () => {
    status.hidden = !settings.statusBar;
    if (!lastPos) return;
    const p = lastPos;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const batt = battery ? `  ·  ${Math.round(battery.level * 100)}%` : '';
    const lastShown = Math.min(p.pageCount, p.page + p.pagesPerView);
    status.replaceChildren(
      el('span', { textContent: time + batt }),
      el('span', { className: 'mid', textContent: `${currentChapter}${currentChapter ? ' ' : ''}(${lastShown}/${p.pageCount})` }),
      el('span', { textContent: `${(p.progress * 100).toFixed(1)}%` }),
    );
  };
  const clock = window.setInterval(updateStatus, 20_000);
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener(t: string, f: () => void): void }> };
  nav
    .getBattery?.()
    .then((b) => {
      battery = b;
      b.addEventListener('levelchange', updateStatus);
      updateStatus();
    })
    .catch(() => {});

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
    // The status bar is an overlay: toggling it must not re-paginate the book.
    const layoutChanged = JSON.stringify({ ...s, statusBar: 0 }) !== JSON.stringify({ ...settings, statusBar: 0 });
    settings = s;
    prefs.saveSettings(s);
    applyUiTheme();
    updateStatus();
    if (layoutChanged) reader?.setSettings(s);
  });

  backBtn.onclick = () => void showLibrary();
  tocBtn.onclick = () => togglePanel(toc, tocBtn);
  setBtn.onclick = () => togglePanel(settingsPanel, setBtn);
  searchBtn.onclick = () => (searchPanel.hidden ? openSearch() : togglePanel(searchPanel, searchBtn));
  notesBtn.onclick = () => {
    renderNotes();
    togglePanel(notesPanel, notesBtn);
  };
  markBtn.onclick = toggleBookmark;
  fullBtn.onclick = () => void toggleFullscreen();
  slider.oninput = () => reader?.seekSection(Number(slider.value) / 1000);

  const onKey = (e: KeyboardEvent) => {
    if (!reader) return;
    if (e.key === 'F11') {
      e.preventDefault();
      void toggleFullscreen();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
      return;
    }
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (['ArrowRight', 'PageDown', ' ', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      reader.next();
    } else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      reader.prev();
    } else if (e.key === 'Escape') {
      reader.clearSelection();
      hideSelMenu();
      noteEditor.hidden = true;
      setUi(false);
    }
  };
  window.addEventListener('keydown', onKey);
  const saveNow = () => lastPos && library.put({ ...entry, progress: lastPos.progress, openedAt: Date.now() });

  cleanupReader = () => {
    window.removeEventListener('keydown', onKey);
    clearTimeout(saveTimer);
    clearInterval(clock);
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
  const seg = <T extends string | number | boolean>(label: string, key: keyof ReaderSettings, options: [T, string][]) => {
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
    seg('Barra de estado', 'statusBar', [
      [true, 'Visible'],
      [false, 'Oculta'],
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
