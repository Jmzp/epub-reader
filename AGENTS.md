# AGENTS.md

Guidance for AI coding agents working in this repository. Human-facing docs live in [README.md](README.md).

## Project

Desktop EPUB reader whose core feature is a realistic, finger-driven 3D page curl. The primary target is **Windows on ARM (Surface)**: a Tauri 2 app on WebView2 (Chromium), shipped as a native `aarch64-pc-windows-msvc` binary. Development happens on macOS, where the webview is **WebKit**, so every rendering change must work in both engines.

The smoothness of the page turn is the product. Never trade frame time during a turn for anything else.

## Commands

```bash
npm install
npm run dev          # Vite on http://localhost:1420 (reader) and /curl-lab.html (curl playground)
npm test             # Vitest: EPUB parser tests (synthetic EPUBs, no fixtures)
npm run build        # tsc --noEmit + vite build
npx tsc --noEmit -p . # typecheck only
npm run tauri dev    # native app

# Windows ARM64 from macOS (needs llvm, lld, nsis, cargo-xwin, rustup target aarch64-pc-windows-msvc)
export PATH="/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
npx tauri build --runner cargo-xwin --target aarch64-pc-windows-msvc
```

CI: `.github/workflows/windows-arm64.yml` builds on the native `windows-11-arm` runner (manual trigger or `v*` tags).

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/epub/book.ts` | EPUB 2/3 parsing (fflate + DOMParser). Paths are zip paths, URL-decoded. |
| `src/epub/resources.ts` | Zip entries → `blob:` URLs (live iframe) or `data:` URLs (SVG rasterization). |
| `src/reader/section.ts` | One spine item in a sandboxed iframe, paginated with CSS multi-column. Anchors, fragment lookup, raster SVG. |
| `src/reader/layout.ts` | Settings → `Layout` (page size, margins, spread) and the injected reader CSS. `Layout.key` invalidates caches. |
| `src/reader/pageCache.ts` | Page textures: SVG `foreignObject` → canvas → WebGL texture. LRU with pinning. |
| `src/reader/curl/physics.ts` | Pure math: curl geometry, hinge constraint, critically damped spring, velocity tracker. |
| `src/reader/curl/shaders.ts` | GLSL for the flat pages and the curling sheet, plus `gutterDarkness()` shared with CSS. |
| `src/reader/curl/CurlRenderer.ts` | WebGL2 renderer. Static mesh; only uniforms change per frame. |
| `src/reader/curl/PageTurner.ts` | Input → state machine (`idle / pressed / dragging / settling / riffle`) → frames. |
| `src/reader/Reader.ts` | Orchestrator: sections, current view, `TurnSource`, prefetch, TOC riffle, persistence callbacks. |
| `src/main.ts`, `src/ui/styles.css` | Library, toolbars, TOC, settings. |
| `src/storage.ts` | IndexedDB library + localStorage settings/positions. |
| `src/dictionary.ts` | Wiktionary REST lookups (CORS-enabled, no key); links open through `tauri-plugin-opener`. |
| `src/annotations.ts` | Highlights, notes, bookmarks (localStorage `notes:<bookId>`), Markdown export. |
| `src-tauri/` | Minimal Rust shell: window, `.epub` file-association commands, NSIS bundle. |

**Rest vs. turn:** at rest the live iframe DOM is shown (crisp, real text). When a turn starts, the WebGL canvas, already holding rasterized textures, covers it in the same frame. When the turn ends, the DOM shows the new page and the canvas hides. Anything visible at rest must look identical in the canvas, and vice versa.

## Invariants and hard-won lessons

- **Rasterize only while idle.** SVG `foreignObject` layout of a long chapter costs tens of milliseconds on the main thread. Rasterization is scheduled by `Reader.prefetch()` and skipped while `turner.busy`.
- **Never use a source rect when drawing an SVG image.** WebKit and Chromium disagree on the units of the `drawImage` source rect for SVG images. On Retina, WebKit drew two pages per texture. Keep the SVG sized in CSS pixels and use the destination-only `drawImage(img, dx, dy, dw, dh)` form (`pageCache.ts`).
- **Don't store Blobs in IndexedDB.** WebKit can reject them. Store `ArrayBuffer`s; `bookBytes()` and `coverBlob()` accept both for legacy entries.
- **Shared visuals must share formulas.** The spine shading exists both in GLSL and as a CSS gradient over the DOM (`Reader.updateGutter`). Both use `gutterDarkness()`; change it in one place only.
- **Clamp pages with the target section.** Use `alignIn(section, page)`, not `align(page)`, when the destination is a different section (`align` uses the current one).
- **Neighbour sections load asynchronously.** Cross-chapter turns must `await ensureSection()` first (see `Reader.turn`), or the first key press after opening is lost.
- **Textures in use must not be evicted.** Long animations (the riffle) `pin()` their pages and call `unpinAll()` when done.
- **The sheet is rendered orthographically.** The shadows the lifted paper casts are computed in flat sheet space (`flippedEdgeShadow`, curl shadow). Adding perspective to the sheet makes paper and shadow drift apart and leaves a bright, unshadowed sliver along the flipped edge.
- **The paper is matte.** Sheet lighting never exceeds the paper color. Anything brighter clips to white and shows up as a white stripe on the roll. The back of the sheet is shaded with one continuous gradient (darkest at the crest of the roll), and `flippedEdgeShadow` fades out when the free edge still rests on the roll. A step in brightness at the axis or at the end of the roll reads as a seam.
- **Never mutate a section's `<body>`.** Anchors are node paths from `<body>`, so highlights, bookmarks and positions break if nodes are wrapped or inserted. Marks are painted as boxes in a layer that is a sibling *before* `<body>` (under the text), and `Section.rasterSvg` injects the same boxes, so highlights look identical at rest and while turning. After changing marks, drop that section's textures (`PageTextures.dropSection`), as `Reader.applyMarks` does.
- **Search parses sections like the live iframe.** `Reader.search` runs `buildSectionXhtml` + an XHTML `DOMParser`, the same pipeline the iframe loads, so node paths from search hits resolve in the live document.
- **Long press selects, movement turns.** `PageTurner` starts a selection after 450 ms without crossing the drag slop; any movement before that is a page turn.
- **Imported fonts are data: URLs.** The reader CSS is shared by the live iframe and the SVG `foreignObject` rasterizer, which cannot fetch blob: or file URLs. Fonts live in IndexedDB (`fonts` store) and are registered with `registerUserFont()` before any reader opens.
- **Wait for fonts before trusting pagination.** `Section.fontsReady()` re-measures after `document.fonts.ready`; `Reader.relayout` then realigns to the saved anchor and clears textures if the page count changed.
- **Positions are anchors, not page numbers.** Save and restore with `Section.anchorAt()` / `pageOfAnchor()` so font, size and rotation changes keep the reader on the same passage.
- **ARM64 performance:** WebGL runs without MSAA at dpr ≥ 1.75, with `desynchronized: true` and `high-performance`. There are no per-frame allocations in the render loop, and the mesh is never rebuilt.

## Verifying changes

- Typecheck and tests must pass: `npx tsc --noEmit -p . && npm test`.
- Curl or visual changes: use `/curl-lab.html?debug` and `pose(x, y)` to freeze and screenshot a pose.
- Layer debugging: `?debug=faces` tints flat pages green, the sheet's front red and its back blue, which shows at a glance which surface produces an artifact.
- Rendering changes: check both **WebKit and Chromium at deviceScaleFactor 2** (Playwright works well). Compare a screenshot at rest with one mid-drag; they must match outside the curl.
- Synthetic pointer events work for driving turns: dispatch `PointerEvent`s on `.reader-input` (`pointerId` of your choice; pointer capture failures are tolerated).
- Background browser tabs pause `requestAnimationFrame`, so animations appear frozen. That is not a bug.

## Conventions

- **Language:** code, comments, docs and commit messages in English. The app UI strings (`src/main.ts`) are intentionally in Spanish.
- **Attribution:** do not add AI co-author trailers (`Co-Authored-By: ...`) or "generated with" lines to commits or PRs. The repository owner is the sole contributor.
- **Style:** match the surrounding code. TypeScript strict mode, no framework in the reader core, small focused modules, comments explaining *why* rather than *what*.
- **Copyrighted content:** never commit third-party EPUBs, covers or book text. Tests build EPUBs in memory (`tests/makeEpub.ts`).
