// All coordinates are CSS pixels, y pointing down. "Sheet-local" space has the hinge
// (spine) on the line x = 0 and the free edge at x = W.

// Spine (gutter) shading, shared by the shader and the CSS overlay shown at rest so
// the fold looks identical whether the page is idle (DOM) or turning (WebGL).
const GUTTER = { near: 0.16, nearWidth: 0.035, far: 0.05, farWidth: 0.25 };

/** Darkness (0..1) at `dist` px from the spine, for a page `pageW` px wide. */
export function gutterDarkness(dist: number, pageW: number): number {
  return GUTTER.near * Math.exp(-dist / (pageW * GUTTER.nearWidth)) + GUTTER.far * Math.exp(-dist / (pageW * GUTTER.farWidth));
}

const COMMON = /* glsl */ `
precision highp float;
#define PI 3.14159265
uniform vec2 uView;        // viewport size
uniform vec2 uSheetOrigin; // screen position of the sheet's top-left (hinge top)
uniform vec2 uSheetSize;
uniform vec2 uAxis;        // a point on the fold axis (sheet-local)
uniform vec2 uDir;         // unit vector perpendicular to the axis, towards the free edge
uniform float uRadius;     // curl cylinder radius
uniform float uShadow;     // 0..1 overall shadow strength
uniform float uGutter;     // spine shading strength (0 in single-page mode)
uniform float uSpineX;     // screen x of the spine

// Darkening of the page right next to the edge of the flipped-over part of the sheet.
// p is sheet-local and on the flat side of the axis (d <= 0): the flipped paper above p
// comes from s; if s is outside the sheet, p is uncovered and near the edge -> shadow.
float flippedEdgeShadow(vec2 p, float d) {
  vec2 s = p + uDir * (PI * uRadius - 2.0 * d);
  vec2 q = max(max(-s, s - uSheetSize), 0.0);
  float dist = length(q);
  if (dist <= 0.0) return 1.0;
  return 1.0 - 0.32 * uShadow * exp(-dist / (5.0 + uRadius * 0.35));
}

float gutterShade(float dist) {
  return 1.0 - uGutter * (${GUTTER.near} * exp(-dist / (uSheetSize.x * ${GUTTER.nearWidth})) + ${GUTTER.far} * exp(-dist / (uSheetSize.x * ${GUTTER.farWidth})));
}
`;

export const FLAT_VS = /* glsl */ `#version 300 es
${COMMON}
in vec2 aPos; // unit quad
uniform vec4 uRect; // x, y, w, h
out vec2 vUV;
out vec2 vScreen;
void main() {
  vUV = aPos;
  vScreen = uRect.xy + aPos * uRect.zw;
  gl_Position = vec4(vScreen.x / uView.x * 2.0 - 1.0, 1.0 - vScreen.y / uView.y * 2.0, 0.999, 1.0);
}`;

export const FLAT_FS = /* glsl */ `#version 300 es
${COMMON}
uniform sampler2D uTex;
uniform bool uHasSheet;
in vec2 vUV;
in vec2 vScreen;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUV).rgb;
  float shade = gutterShade(abs(vScreen.x - uSpineX));
  if (uHasSheet) {
    vec2 p = vScreen - uSheetOrigin;
    float d = dot(p - uAxis, uDir);
    if (d > 0.0) {
      // Soft shadow cast by the curl onto the page being revealed.
      float sd = max(d - uRadius, 0.0);
      float w = uRadius * 0.9 + 10.0;
      shade *= 1.0 - 0.5 * uShadow * exp(-sd / w);
    } else {
      shade *= flippedEdgeShadow(p, d);
    }
  }
  outColor = vec4(c * shade, 1.0);
}`;

export const SHEET_VS = /* glsl */ `#version 300 es
${COMMON}
in vec2 aUV;
out vec2 vUV;
out vec3 vNormal;
out float vD;
out vec2 vLocal;
void main() {
  vec2 p = aUV * uSheetSize;
  float d = dot(p - uAxis, uDir);
  float R = max(uRadius, 0.75);
  vec3 pos;
  vec3 n;
  if (d <= 0.0) {
    pos = vec3(p, 0.0);
    n = vec3(0.0, 0.0, 1.0);
  } else {
    vec2 base = p - uDir * d;
    float th = d / R;
    if (th < PI) {
      pos = vec3(base + uDir * (R * sin(th)), R * (1.0 - cos(th)));
      n = vec3(-uDir * sin(th), cos(th));
    } else {
      // Past the half cylinder the paper lies flat again, upside down, over the page.
      pos = vec3(base - uDir * (d - PI * R), 2.0 * R + 0.75);
      n = vec3(0.0, 0.0, -1.0);
    }
  }
  vUV = aUV;
  vNormal = n;
  vD = d;
  vLocal = p;

  // Orthographic on purpose: the shadows cast by the lifted paper are computed in flat
  // sheet space, so any perspective here makes the paper and its shadow drift apart and
  // leaves an unshadowed sliver along the flipped edge.
  vec2 screen = uSheetOrigin + pos.xy;
  gl_Position = vec4(screen.x / uView.x * 2.0 - 1.0, 1.0 - screen.y / uView.y * 2.0, 0.5 - pos.z / 8000.0, 1.0);
}`;

export const SHEET_FS = /* glsl */ `#version 300 es
${COMMON}
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform bool uMirrorBack;   // single-page mode: back shows the front's text faintly, mirrored
uniform float uShowThrough;
uniform vec3 uPaper;
in vec2 vUV;
in vec3 vNormal;
in float vD;
in vec2 vLocal;
out vec4 outColor;

const vec3 L = normalize(vec3(-0.28, -0.42, 1.0));

void main() {
  vec3 N = normalize(vNormal);
  bool front = N.z >= 0.0;
  vec3 Nv = front ? N : -N;
  vec3 c;
  if (front) {
    c = texture(uFront, vUV).rgb;
  } else if (uMirrorBack) {
    c = mix(uPaper, texture(uFront, vUV).rgb, uShowThrough);
  } else {
    c = texture(uBack, vec2(1.0 - vUV.x, vUV.y)).rgb;
  }

  // Diffuse term normalised so flat paper keeps its exact color.
  float diff = dot(Nv, L) / L.z;
  float light = clamp(0.5 + 0.5 * diff, 0.0, 1.08);
  bool onCurl = vD > 0.0 && vD < PI * max(uRadius, 0.75);
  if (onCurl) {
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float flatSpec = pow(H.z, 60.0);
    light += 0.22 * max(pow(max(dot(Nv, H), 0.0), 60.0) - flatSpec, 0.0);
    // Ambient occlusion inside the roll.
    light *= 1.0 - 0.18 * smoothstep(0.35, 1.0, vD / (PI * max(uRadius, 0.75)));
  }
  if (!front) light *= 0.94;

  float shade = gutterShade(vLocal.x);
  if (vD <= 0.0) shade *= flippedEdgeShadow(vLocal, vD);
  outColor = vec4(c * light * shade, 1.0);
}`;
