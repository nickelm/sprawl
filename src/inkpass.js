import * as THREE from 'three';

// ─── COMIC INK OUTLINES: DEPTH EDGE DETECTION + LINE BOIL ───
// Screen-space ink outlines from depth discontinuities.
// Step 1-2: depth-only silhouette edges. ID pass added later (steps 3-4).

let _renderer;
let _colorTarget;   // scene renders here (color + depth)
let _quadScene, _quadCamera, _quadMesh;
let _enabled = true;

// ─── SHADER ──────────────────────────────────────────────────
const inkVert = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const inkFrag = `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform vec3 inkColor;
uniform float inkWidth;
uniform float depthThreshold;
uniform float cameraNear;
uniform float cameraFar;
uniform int enabled;
uniform float time;
uniform float boilAmount;
uniform float boilSpeed;

varying vec2 vUv;

// Simple hash for per-pixel wobble
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float linearizeDepth(float d) {
  return cameraNear * cameraFar / (cameraFar - d * (cameraFar - cameraNear));
}

void main() {
  vec4 color = texture2D(tColor, vUv);

  if (enabled == 0) {
    gl_FragColor = color;
    return;
  }

  vec2 texel = inkWidth / resolution;

  // Line boil: wobble the sampling offsets per pixel, per frame
  // Quantize time to discrete steps (3-8 fps for hand-drawn feel)
  float boilFrame = floor(time * boilSpeed);
  // Per-pixel random offset that changes each boil frame
  vec2 wobble = vec2(
    hash(gl_FragCoord.xy + boilFrame) - 0.5,
    hash(gl_FragCoord.xy * 1.7 + boilFrame) - 0.5
  ) * texel * boilAmount;

  // Roberts Cross edge detection on linearized depth
  float d00 = linearizeDepth(texture2D(tDepth, vUv + wobble).r);
  float d10 = linearizeDepth(texture2D(tDepth, vUv + vec2(texel.x, 0.0) + wobble).r);
  float d01 = linearizeDepth(texture2D(tDepth, vUv + vec2(0.0, texel.y) + wobble).r);
  float d11 = linearizeDepth(texture2D(tDepth, vUv + vec2(texel.x, texel.y) + wobble).r);

  // Roberts Cross gradient magnitude, normalized by distance
  // so far edges aren't over-detected
  float depthEdge = (abs(d00 - d11) + abs(d10 - d01)) / max(d00, 0.001);

  float depthInk = smoothstep(depthThreshold * 0.5, depthThreshold, depthEdge);

  // Blend: ink darkens the color
  gl_FragColor = vec4(mix(color.rgb, inkColor, depthInk), 1.0);
}
`;

// ─── INIT ────────────────────────────────────────────────────
export function initInkPass(renderer) {
  _renderer = renderer;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const pr = renderer.getPixelRatio();
  const pw = w * pr;
  const ph = h * pr;

  // Color + depth render target (scene renders here)
  const depthTexture = new THREE.DepthTexture(pw, ph, THREE.UnsignedShortType);

  _colorTarget = new THREE.WebGLRenderTarget(pw, ph, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  _colorTarget.depthTexture = depthTexture;

  // Fullscreen quad
  _quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  _quadScene = new THREE.Scene();

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quadMat = new THREE.ShaderMaterial({
    uniforms: {
      tColor:          { value: _colorTarget.texture },
      tDepth:          { value: _colorTarget.depthTexture },
      resolution:      { value: new THREE.Vector2(pw, ph) },
      inkColor:        { value: new THREE.Vector3(0.05, 0.05, 0.08) },
      inkWidth:        { value: 1.0 },
      depthThreshold:  { value: 0.02 },
      cameraNear:      { value: 0.1 },
      cameraFar:       { value: 400 },
      enabled:         { value: 1 },
      time:            { value: 0.0 },
      boilAmount:      { value: 0.5 },
      boilSpeed:       { value: 8.0 },
    },
    vertexShader: inkVert,
    fragmentShader: inkFrag,
    depthTest: false,
    depthWrite: false,
  });

  _quadMesh = new THREE.Mesh(quadGeo, quadMat);
  _quadScene.add(_quadMesh);
}

// ─── RESIZE ──────────────────────────────────────────────────
export function resizeInkPass(w, h) {
  if (!_colorTarget) return;
  const pr = _renderer.getPixelRatio();
  const pw = w * pr;
  const ph = h * pr;

  _colorTarget.setSize(pw, ph);
  _colorTarget.depthTexture.image.width = pw;
  _colorTarget.depthTexture.image.height = ph;

  _quadMesh.material.uniforms.resolution.value.set(pw, ph);
}

// ─── RENDER ──────────────────────────────────────────────────
// Returns the render target the scene should be rendered into.
export function getInkInputTarget() {
  return _colorTarget;
}

// Composites ink outlines. Reads from _colorTarget, writes to outputTarget (null = screen).
export function renderInkPass(camera, outputTarget) {
  if (!_renderer || !_colorTarget) return;

  const u = _quadMesh.material.uniforms;
  u.cameraNear.value = camera.near;
  u.cameraFar.value = camera.far;
  u.time.value = performance.now() / 1000.0;
  u.enabled.value = _enabled ? 1 : 0;

  _renderer.setRenderTarget(outputTarget);
  _renderer.render(_quadScene, _quadCamera);
}

// ─── TOGGLE / PARAMS ─────────────────────────────────────────
export function inkEnabled() { return _enabled; }

export function setInkEnabled(on) {
  _enabled = on;
}

export function setInkParams(params) {
  if (!_quadMesh) return;
  const u = _quadMesh.material.uniforms;
  if (params.inkWidth !== undefined) u.inkWidth.value = params.inkWidth;
  if (params.depthThreshold !== undefined) u.depthThreshold.value = params.depthThreshold;
  if (params.inkColor !== undefined) u.inkColor.value.set(...params.inkColor);
  if (params.boilAmount !== undefined) u.boilAmount.value = params.boilAmount;
  if (params.boilSpeed !== undefined) u.boilSpeed.value = params.boilSpeed;
}
