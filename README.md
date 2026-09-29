# EPUB Reader

A desktop EPUB reader with **realistic page turning**: grab the page with a finger, pen or mouse and it curls in 3D under your gesture, then settles with spring physics. Built for **Windows on ARM (Surface)** as a native `aarch64` binary on WebView2, and it runs on macOS too.

![Two-page spread mid-turn](docs/curl-spread.png)

<table>
  <tr>
    <td width="42%"><img src="docs/curl-single.png" alt="Single page in sepia theme, turned from the top corner" /></td>
    <td><img src="docs/night-toc.png" alt="Night theme with the table of contents open" /></td>
  </tr>
</table>

## Features

- **3D page curl in WebGL2.** The page wraps around a cylinder, with lighting, a visible back side, a cast shadow and spine shading. You can grab any corner or edge; on release, the page completes or falls back depending on position and flick velocity.
- **Two-page spread or single page.** Landscape shows an open book with the spine in the middle; portrait or narrow windows show one page.
- **Riffle when jumping.** Picking a chapter from the table of contents flips through real pages until it lands there.
- **Highlights and notes.** Long-press a word, drag to extend the selection, then pick one of four highlight colors, add a note, copy, or search for it. Highlights are painted into the page textures too, so they curl with the page.
- **Bookmarks** with a ribbon on the page, and a panel listing every note and bookmark. Notes can be copied as Markdown.
- **Full-text search** across the whole book, ignoring case and accents, with the hit highlighted on arrival.
- **Status bar** like a phone reader: clock, battery, chapter with page, and percentage of the book.
- **Picks up where you left off.** The reading position is stored as a text anchor, so it survives font, window-size and rotation changes.
- **Library** with covers and progress. Open books from a file dialog or by dropping them on the window; with the installer, also by double-clicking an `.epub`.
- **Typography:** font size, built-in faces or your own imported fonts (TTF, OTF, WOFF), alignment (original, justified, left), hyphenation on/off, paragraph style (original, indented, spaced), line height and margins. Imported fonts show up on the turning page too.
- **Dictionary.** Select a word and tap *Definir* to see its definitions from Wiktionary, matched to the book's language, with a link to the full entry.
- **Reading settings:** paper/sepia/night themes, two-page or single-page mode, and an optional status bar.
- **Full input support:** touch, pen, mouse, wheel and keyboard (`←` `→` `PgUp` `PgDn` `Space` `F11`, `Ctrl+F` to search).
- **EPUB 2 and EPUB 3:** OPF, spine, NCX or nav document, cover, and the book's own CSS and images.

The interface is in English by default, with Spanish available under **Reading settings → Language**.

## Trying it on a Surface

The installer and the portable build come from the ARM64 build (see below):

| File | Use |
| --- | --- |
| `EPUB Reader_<version>_arm64-setup.exe` | Per-user installer, no admin needed. Associates `.epub` files and installs WebView2 if missing. |
| `epub-reader.exe` | Portable. Requires WebView2, which ships with Windows 11. |

> The app is not code-signed, so SmartScreen will warn about it. Click **More info → Run anyway**.

## Development

Requirements: Node 22+ and Rust (only for the native app).

```bash
npm install
npm run dev          # reader at http://localhost:1420
npm test             # EPUB parser tests
npm run tauri dev    # native app (macOS / Windows)
```

`http://localhost:1420/curl-lab.html` is an isolated playground for the page curl, with synthetic pages and an fps HUD. With `?debug`, `pose(x, y)` in the console freezes a curl pose.

## Building for Windows ARM64

**From macOS** (cross-compiling with [cargo-xwin](https://github.com/rust-cross/cargo-xwin)):

```bash
brew install llvm lld nsis
cargo install --locked cargo-xwin
rustup target add aarch64-pc-windows-msvc
export PATH="/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
npx tauri build --runner cargo-xwin --target aarch64-pc-windows-msvc
```

cargo-xwin downloads Microsoft's CRT and Windows SDK, which means accepting Microsoft's license. The output goes to `src-tauri/target/aarch64-pc-windows-msvc/release/`: the portable `epub-reader.exe`, plus the installer under `bundle/nsis/`.

**On GitHub Actions:** the [`windows-arm64.yml`](.github/workflows/windows-arm64.yml) workflow builds on the native `windows-11-arm` runner. Trigger it manually (*Run workflow*) or by pushing a `v*` tag; both executables are uploaded as an artifact.

## How it works

```
EPUB (zip) ──► parser (fflate + DOMParser) ──► one iframe per chapter, paginated with CSS multi-column
                                                    │
                           at rest: live DOM        │   when a gesture starts:
                           (crisp text)             ▼   pages → SVG foreignObject → canvas → GPU texture
                                                        │
                                   PageTurner (gestures + spring) ──► CurlRenderer (WebGL2, 64×80 mesh)
```

- **Pagination.** Each chapter lives in a sandboxed iframe (no scripts) laid out with CSS multi-column. One page is one column, and changing pages is a `translate3d`.
- **Textures.** Pages are rasterized in batches through an SVG `<foreignObject>` at the display's real resolution, then uploaded to the GPU once. This only happens while the reader is idle, never during a turn, and neighbouring pages are prefetched.
- **Curl.** The mesh is static; each frame only updates a few uniforms (fold axis, direction and radius), so the per-frame CPU cost is close to zero. The axis comes from the perpendicular bisector between the grabbed corner and the finger, corrected for the cylinder radius: `d = (L + πR) / 2`. The corner stays attached to the spine, so the page can't be "torn off".
- **Smoothness.** Pointer Events with `getCoalescedEvents` and `getPredictedEvents`. Drawing happens only inside `requestAnimationFrame`, and only while something is animating. The spring is critically damped and inherits the finger's velocity on release.
- **Windows ARM64.** Native `aarch64-pc-windows-msvc` binary (never emulated x64). WebGL uses `powerPreference: high-performance`, skips MSAA at 2× pixel density or above (it's expensive on Adreno GPUs), and sets `desynchronized: true` to cut pen latency.

## Project layout

| Path | Contents |
| --- | --- |
| `src/epub/book.ts` | EPUB 2/3 parser: metadata, spine, table of contents, cover |
| `src/epub/resources.ts` | Zip resources as `blob:` or `data:` URLs, with CSS rewriting |
| `src/reader/section.ts` | Chapter iframe, pagination, anchors and SVG rasterization |
| `src/reader/pageCache.ts` | LRU cache of GPU textures |
| `src/reader/curl/` | Shaders, curl physics, gestures (`PageTurner`) and the WebGL2 renderer |
| `src/reader/Reader.ts` | Orchestration: navigation, prefetching, riffle and persistence |
| `src/main.ts`, `src/ui/` | Library, toolbars, table of contents and settings |
| `src/storage.ts` | Library (IndexedDB), reading position and settings (localStorage) |
| `src/annotations.ts` | Highlights, notes and bookmarks: types, storage and Markdown export |
| `src/i18n.ts` | UI strings (English and Spanish) and the `t()` helper |
| `src/dictionary.ts` | Wiktionary lookups for the *Definir* action |
| `src-tauri/` | Native shell: window, `.epub` file association and NSIS bundle |

## Known limitations

- The dictionary needs an internet connection, and its definitions are in English (Wiktionary groups them by the language of the word).

- Selection works by long press only (the gesture layer covers the page, so there is no native text selection).
- Web fonts embedded in an EPUB may render with a fallback font during a turn.
