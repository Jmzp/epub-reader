import { FLAT_FS, FLAT_VS, SHEET_FS, SHEET_VS } from './shaders';
import type { CurlGeometry, Vec2 } from './physics';

export interface FlatPage {
  tex: WebGLTexture;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sheet {
  front: WebGLTexture;
  /** Texture for the back side; null mirrors the front faintly (single-page mode). */
  back: WebGLTexture | null;
  origin: Vec2;
  width: number;
  height: number;
  geometry: CurlGeometry;
}

export interface Frame {
  pages: FlatPage[];
  sheet: Sheet | null;
  /** Screen x of the spine; gutter shading is applied around it when `gutter` > 0. */
  spineX: number;
  gutter: number;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

const GRID_X = 64;
const GRID_Y = 80;

/**
 * WebGL2 renderer for the page turn. Geometry is uploaded once; each frame only
 * updates a handful of uniforms, so the per-frame CPU cost is negligible.
 */
export class CurlRenderer {
  readonly gl: WebGL2RenderingContext;
  private flat: { prog: WebGLProgram; u: Uniforms; vao: WebGLVertexArrayObject };
  private sheet: { prog: WebGLProgram; u: Uniforms; vao: WebGLVertexArrayObject; count: number };
  private cssW = 1;
  private cssH = 1;
  private clear: [number, number, number] = [0.85, 0.83, 0.78];
  paper: [number, number, number] = [1, 1, 1];
  showThrough = 0.16;

  constructor(readonly canvas: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      depth: true,
      stencil: false,
      // MSAA is expensive on mobile GPUs (Adreno); at dpr >= 2 edges are already fine.
      antialias: dpr < 1.75,
      premultipliedAlpha: false,
      preserveDrawingBuffer: new URLSearchParams(location.search).has("debug"),
      powerPreference: 'high-performance',
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const flatProg = program(gl, FLAT_VS, FLAT_FS);
    const flatVao = gl.createVertexArray()!;
    gl.bindVertexArray(flatVao);
    buffer(gl, flatProg, 'aPos', new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
    this.flat = { prog: flatProg, u: uniforms(gl, flatProg), vao: flatVao };

    const sheetProg = program(gl, SHEET_VS, SHEET_FS);
    const sheetVao = gl.createVertexArray()!;
    gl.bindVertexArray(sheetVao);
    const uv = new Float32Array((GRID_X + 1) * (GRID_Y + 1) * 2);
    let i = 0;
    for (let y = 0; y <= GRID_Y; y++) {
      for (let x = 0; x <= GRID_X; x++) {
        uv[i++] = x / GRID_X;
        uv[i++] = y / GRID_Y;
      }
    }
    buffer(gl, sheetProg, 'aUV', uv);
    const idx = new Uint16Array(GRID_X * GRID_Y * 6);
    i = 0;
    for (let y = 0; y < GRID_Y; y++) {
      for (let x = 0; x < GRID_X; x++) {
        const a = y * (GRID_X + 1) + x;
        const b = a + 1;
        const c = a + GRID_X + 1;
        const d = c + 1;
        idx.set([a, c, b, b, c, d], i);
        i += 6;
      }
    }
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.sheet = { prog: sheetProg, u: uniforms(gl, sheetProg), vao: sheetVao, count: idx.length };
    gl.bindVertexArray(null);
  }

  setTheme(desk: string, paper: [number, number, number], showThrough: number) {
    this.clear = [1, 3, 5].map((i) => parseInt(desk.slice(i, i + 2), 16) / 255) as [number, number, number];
    this.paper = paper;
    this.showThrough = showThrough;
  }

  resize(cssW: number, cssH: number) {
    const dpr = window.devicePixelRatio || 1;
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  createTexture(source: TexImageSource): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  deleteTexture(tex: WebGLTexture) {
    this.gl.deleteTexture(tex);
  }

  render(frame: Frame) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(...this.clear, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const s = frame.sheet;
    const g = s?.geometry;
    const setCommon = (u: Uniforms) => {
      gl.uniform2f(u.uView, this.cssW, this.cssH);
      gl.uniform1f(u.uGutter, frame.gutter);
      gl.uniform1f(u.uSpineX, frame.spineX);
      if (s && g) {
        gl.uniform2f(u.uSheetOrigin, s.origin.x, s.origin.y);
        gl.uniform2f(u.uSheetSize, s.width, s.height);
        gl.uniform2f(u.uAxis, g.axis.x, g.axis.y);
        gl.uniform2f(u.uDir, g.dir.x, g.dir.y);
        gl.uniform1f(u.uRadius, g.radius);
        // Shadows fade in as the sheet lifts and out as it lands.
        gl.uniform1f(u.uShadow, Math.min(1, g.progress * 8) * (1 - Math.max(0, g.progress - 0.85) / 0.15));
      } else {
        gl.uniform2f(u.uSheetSize, frame.pages[0]?.w ?? 1, frame.pages[0]?.h ?? 1);
      }
    };

    // 1) Static pages (what lies beneath / beside the turning sheet).
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.flat.prog);
    gl.bindVertexArray(this.flat.vao);
    setCommon(this.flat.u);
    gl.uniform1i(this.flat.u.uHasSheet, s ? 1 : 0);
    gl.uniform1i(this.flat.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const p of frame.pages) {
      gl.bindTexture(gl.TEXTURE_2D, p.tex);
      gl.uniform4f(this.flat.u.uRect, p.x, p.y, p.w, p.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 2) The curling sheet.
    if (s) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.useProgram(this.sheet.prog);
      gl.bindVertexArray(this.sheet.vao);
      const u = this.sheet.u;
      setCommon(u);
      gl.uniform1f(u.uFocal, Math.max(this.cssW, this.cssH) * 3);
      gl.uniform3f(u.uPaper, ...this.paper);
      gl.uniform1f(u.uShowThrough, this.showThrough);
      gl.uniform1i(u.uMirrorBack, s.back ? 0 : 1);
      gl.uniform1i(u.uFront, 0);
      gl.uniform1i(u.uBack, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, s.front);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, s.back ?? s.front);
      gl.drawElements(gl.TRIANGLES, this.sheet.count, gl.UNSIGNED_SHORT, 0);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.bindVertexArray(null);
  }
}

function shader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`Shader compile error: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link error: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram): Uniforms {
  const out: Uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i)!;
    out[info.name] = gl.getUniformLocation(p, info.name);
  }
  // Unused uniforms are optimised away; make lookups of them harmless no-ops.
  return new Proxy(out, { get: (t, k: string) => t[k] ?? null });
}

function buffer(gl: WebGL2RenderingContext, p: WebGLProgram, name: string, data: Float32Array) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(p, name);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
}
