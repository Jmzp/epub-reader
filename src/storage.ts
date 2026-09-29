import type { Anchor } from './reader/section';
import { DEFAULT_SETTINGS, type ReaderSettings } from './reader/layout';

export interface LibraryBook {
  id: string;
  title: string;
  author: string;
  /** ArrayBuffers, not Blobs: WebKit can refuse to store Blobs in IndexedDB. */
  cover?: { bytes: ArrayBuffer; type: string } | Blob;
  data: ArrayBuffer | Blob;
  addedAt: number;
  openedAt: number;
  progress?: number;
}

/** Where the reader was in a book. Anchors survive font/size/window changes. */
export interface SavedLocation {
  section: number;
  anchor: Anchor | null;
  /** Fallback when the anchor can't be resolved (fraction of the section). */
  fraction: number;
  progress: number;
}

/** A font file imported by the reader. */
export interface UserFont {
  id: string;
  name: string;
  type: string;
  data: ArrayBuffer;
}

const DB_NAME = 'epub-reader';
const STORE = 'books';
const FONTS = 'fonts';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(FONTS)) d.createObjectStore(FONTS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = run(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Entries saved by earlier versions hold Blobs; accept both shapes. */
export async function bookBytes(b: LibraryBook): Promise<Uint8Array> {
  return new Uint8Array(b.data instanceof Blob ? await b.data.arrayBuffer() : b.data);
}

export function coverBlob(b: LibraryBook): Blob | undefined {
  if (!b.cover) return undefined;
  return b.cover instanceof Blob ? b.cover : new Blob([b.cover.bytes], { type: b.cover.type });
}

export const library = {
  list: async () => (await tx<LibraryBook[]>('readonly', (s) => s.getAll())).sort((a, b) => b.openedAt - a.openedAt),
  get: (id: string) => tx<LibraryBook | undefined>('readonly', (s) => s.get(id)),
  put: (book: LibraryBook) => tx('readwrite', (s) => s.put(book)),
  remove: (id: string) => tx('readwrite', (s) => s.delete(id)),
};

export const fonts = {
  list: () => tx<UserFont[]>('readonly', (s) => s.getAll(), FONTS),
  put: (f: UserFont) => tx('readwrite', (s) => s.put(f), FONTS),
  remove: (id: string) => tx('readwrite', (s) => s.delete(id), FONTS),
};

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode): positions just won't persist.
  }
}

export const prefs = {
  settings: (): ReaderSettings => ({ ...DEFAULT_SETTINGS, ...readJson<Partial<ReaderSettings>>('settings') }),
  saveSettings: (s: ReaderSettings) => writeJson('settings', s),
  location: (bookId: string) => readJson<SavedLocation>(`loc:${bookId}`),
  saveLocation: (bookId: string, loc: SavedLocation) => writeJson(`loc:${bookId}`, loc),
};
