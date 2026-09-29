import { resolvePath, type Book } from './book';

export type UrlMode = 'blob' | 'data';

/**
 * Turns zip entries into URLs the webview can load.
 * - `blob`: cheap object URLs for the live iframe.
 * - `data`: self-contained data URLs, required inside SVG `<foreignObject>` images
 *   (used to rasterize pages into textures), which cannot fetch external resources.
 */
export class Resources {
  private blobs = new Map<string, string>();
  private datas = new Map<string, string>();

  constructor(private book: Book) {}

  url(path: string, mode: UrlMode): string {
    if (!this.book.has(path)) return '';
    const cache = mode === 'blob' ? this.blobs : this.datas;
    let url = cache.get(path);
    if (url) return url;
    const type = this.book.mediaType(path);
    const bytes = type === 'text/css' ? new TextEncoder().encode(this.css(path, mode)) : this.book.bytes(path);
    url =
      mode === 'blob'
        ? URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
        : `data:${type};base64,${toBase64(bytes)}`;
    cache.set(path, url);
    return url;
  }

  /** Stylesheet text with every `url()` / `@import` rewritten to loadable URLs. */
  css(path: string, mode: UrlMode): string {
    return this.rewriteCss(this.book.text(path), path, mode);
  }

  rewriteCss(css: string, basePath: string, mode: UrlMode): string {
    return css
      .replace(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/g, (_, href: string) => {
        const target = resolvePath(basePath, href);
        return this.book.has(target) ? this.css(target, mode) : '';
      })
      .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _q, href: string) => {
        if (/^(data|blob|https?):/i.test(href)) return whole;
        const url = this.url(resolvePath(basePath, href), mode);
        return url ? `url("${url}")` : whole;
      });
  }

  dispose() {
    for (const url of this.blobs.values()) URL.revokeObjectURL(url);
    this.blobs.clear();
    this.datas.clear();
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
