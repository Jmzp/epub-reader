import { unzipSync, strFromU8 } from 'fflate';

export interface TocEntry {
  label: string;
  /** Full path inside the zip, optionally with `#fragment`. */
  href: string;
  children: TocEntry[];
}

export interface SpineItem {
  id: string;
  /** Full path inside the zip. */
  href: string;
  mediaType: string;
  linear: boolean;
}

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
}

export interface BookMetadata {
  title: string;
  creator: string;
  language: string;
  identifier: string;
}

export interface Book {
  metadata: BookMetadata;
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[];
  toc: TocEntry[];
  coverHref?: string;
  has(path: string): boolean;
  bytes(path: string): Uint8Array;
  text(path: string): string;
  mediaType(path: string): string;
}

const MIME_BY_EXT: Record<string, string> = {
  xhtml: 'application/xhtml+xml',
  html: 'application/xhtml+xml',
  htm: 'application/xhtml+xml',
  css: 'text/css',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ncx: 'application/x-dtbncx+xml',
};

/** Resolves `rel` against the directory of `base` (both zip paths). Drops the fragment. */
export function resolvePath(base: string, rel: string): string {
  const [pathPart] = rel.split('#');
  if (!pathPart) return base;
  if (/^[a-z]+:/i.test(pathPart)) return pathPart;
  const decoded = safeDecode(pathPart);
  const parts = decoded.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const seg of decoded.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Like resolvePath but keeps the `#fragment`. */
export function resolveHref(base: string, rel: string): string {
  const hash = rel.indexOf('#');
  const frag = hash >= 0 ? rel.slice(hash) : '';
  const path = hash === 0 ? base : resolvePath(base, rel);
  return path + frag;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    // Some EPUBs ship slightly broken XML; the HTML parser is forgiving enough for metadata.
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

/** Namespace-agnostic element lookup (OPF/NCX mix prefixes freely). */
function byLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter(
    (el) => (el.localName || el.nodeName).toLowerCase() === name.toLowerCase(),
  );
}

function childrenByLocalName(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName.toLowerCase() === name.toLowerCase());
}

function firstText(root: Document | Element, name: string): string {
  return byLocalName(root, name)[0]?.textContent?.trim() ?? '';
}

export function parseEpub(data: Uint8Array): Book {
  const files = unzipSync(data);
  // Some zips use case-inconsistent paths in hrefs; keep a lowercase index as fallback.
  const lower = new Map<string, string>();
  for (const k of Object.keys(files)) lower.set(k.toLowerCase(), k);
  const key = (path: string) => (path in files ? path : lower.get(path.toLowerCase()));

  const has = (path: string) => key(path) !== undefined;
  const bytes = (path: string) => {
    const k = key(path);
    if (!k) throw new Error(`Missing file in EPUB: ${path}`);
    return files[k];
  };
  const text = (path: string) => strFromU8(bytes(path));

  const container = parseXml(text('META-INF/container.xml'));
  const opfPath = byLocalName(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('Invalid EPUB: no rootfile in container.xml');
  const opf = parseXml(text(opfPath));

  const manifest = new Map<string, ManifestItem>();
  const mediaTypes = new Map<string, string>();
  for (const item of byLocalName(opf, 'item')) {
    const id = item.getAttribute('id') ?? '';
    const href = resolvePath(opfPath, item.getAttribute('href') ?? '');
    const mediaType = item.getAttribute('media-type') ?? '';
    const properties = (item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean);
    manifest.set(id, { id, href, mediaType, properties });
    mediaTypes.set(href, mediaType);
  }

  const spineEl = byLocalName(opf, 'spine')[0];
  const spine: SpineItem[] = [];
  for (const ref of spineEl ? childrenByLocalName(spineEl, 'itemref') : []) {
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    if (!item || !has(item.href)) continue;
    spine.push({
      id: item.id,
      href: item.href,
      mediaType: item.mediaType,
      linear: ref.getAttribute('linear') !== 'no',
    });
  }

  const metadata: BookMetadata = {
    title: firstText(opf, 'title') || 'Untitled',
    creator: firstText(opf, 'creator'),
    language: firstText(opf, 'language'),
    identifier: firstText(opf, 'identifier'),
  };

  const items = [...manifest.values()];
  let coverHref = items.find((i) => i.properties.includes('cover-image'))?.href;
  if (!coverHref) {
    const coverId = byLocalName(opf, 'meta')
      .find((m) => m.getAttribute('name') === 'cover')
      ?.getAttribute('content');
    const item = coverId ? manifest.get(coverId) : undefined;
    if (item?.mediaType.startsWith('image/')) coverHref = item.href;
  }

  let toc: TocEntry[] = [];
  const nav = items.find((i) => i.properties.includes('nav'));
  if (nav && has(nav.href)) toc = parseNav(text(nav.href), nav.href);
  if (!toc.length) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncx =
      (ncxId && manifest.get(ncxId)) || items.find((i) => i.mediaType === 'application/x-dtbncx+xml');
    if (ncx && has(ncx.href)) toc = parseNcx(text(ncx.href), ncx.href);
  }

  return {
    metadata,
    manifest,
    spine,
    toc,
    coverHref,
    has,
    bytes,
    text,
    mediaType: (path) =>
      mediaTypes.get(path) || MIME_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream',
  };
}

function parseNcx(xml: string, ncxPath: string): TocEntry[] {
  const doc = parseXml(xml);
  const navMap = byLocalName(doc, 'navMap')[0];
  const walk = (el: Element): TocEntry[] =>
    childrenByLocalName(el, 'navPoint').map((np) => {
      const label = byLocalName(np, 'text')[0]?.textContent?.trim() ?? '';
      const src = byLocalName(np, 'content')[0]?.getAttribute('src') ?? '';
      return { label, href: resolveHref(ncxPath, src), children: walk(np) };
    });
  return navMap ? walk(navMap) : [];
}

function parseNav(xhtml: string, navPath: string): TocEntry[] {
  const doc = parseXml(xhtml);
  const navs = byLocalName(doc, 'nav');
  const tocNav =
    navs.find((n) => (n.getAttribute('epub:type') ?? n.getAttributeNS('http://www.idpf.org/2007/ops', 'type')) === 'toc') ??
    navs[0];
  const ol = tocNav && childrenByLocalName(tocNav, 'ol')[0];
  const walk = (list: Element): TocEntry[] =>
    childrenByLocalName(list, 'li').map((li) => {
      const a = childrenByLocalName(li, 'a')[0] ?? childrenByLocalName(li, 'span')[0];
      const sub = childrenByLocalName(li, 'ol')[0];
      const href = a?.getAttribute('href');
      return {
        label: a?.textContent?.trim().replace(/\s+/g, ' ') ?? '',
        href: href ? resolveHref(navPath, href) : '',
        children: sub ? walk(sub) : [],
      };
    });
  return ol ? walk(ol) : [];
}
