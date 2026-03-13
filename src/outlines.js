import * as THREE from 'three';

// ─── POST-PROCESS OUTLINES: DEPTH-ONLY EDGE DETECTION ──────
// Ink outlines from depth discontinuities. One fullscreen pass.

let _renderer;
let _sceneTarget;
let _quadScene, _quadCamera, _quadMesh;

// ─── PARAMS ──────────────────────────────────────────────────
const _params = {
  outlineThickness: 1.0,
  depthThreshold: 0.002,
  outlineColor: [0.05, 0.05, 0.08],
  depthDependentThickness: true,
};

// ─── SHADER ─────────────────────────────────────────────────
const outlineVert = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const outlineFrag = `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform float cameraNear;
uniform float cameraFar;
uniform float outlineThickness;
uniform float depthThreshold;
uniform vec3 outlineColor;
uniform bool depthDependentThickness;

varying vec2 vUv;

float linearizeDepth(float d) {
  return cameraNear * cameraFar / (cameraFar - d * (cameraFar - cameraNear));
}

void main() {
  float centerDepth = texture2D(tDepth, vUv).r;
  float linDepth = linearizeDepth(centerDepth);

  // Depth-dependent thickness: thicker near, thinner far
  float thickness = outlineThickness;
  if (depthDependentThickness) {
    float depthFactor = smoothstep(0.99, 0.8, centerDepth);
    thickness = outlineThickness * (0.5 + depthFactor);
  }

  vec2 texel = thickness / resolution;

  // Roberts Cross edge detection on linearized depth
  float d00 = linDepth;
  float d11 = linearizeDepth(texture2D(tDepth, vUv + texel).r);
  float d10 = linearizeDepth(texture2D(tDepth, vUv + vec2(texel.x, 0.0)).r);
  float d01 = linearizeDepth(texture2D(tDepth, vUv + vec2(0.0, texel.y)).r);

  // Normalize by distance so far edges aren't over-detected
  float depthEdge = (abs(d00 - d11) + abs(d10 - d01)) / linDepth;

  float edge = depthEdge > depthThreshold ? 1.0 : 0.0;

  vec4 sceneColor = texture2D(tScene, vUv);
  gl_FragColor = mix(sceneColor, vec4(outlineColor, 1.0), edge);
}
`;

// ─── INIT ────────────────────────────────────────────────────
export function initOutlines(renderer) {
  _renderer = renderer;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const pr = renderer.getPixelRatio();
  const pw = w * pr;
  const ph = h * pr;

  const depthTexture = new THREE.DepthTexture(pw, ph, THREE.UnsignedShortType);

  _sceneTarget = new THREE.WebGLRenderTarget(pw, ph, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  _sceneTarget.depthTexture = depthTexture;

  _quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  _quadScene = new THREE.Scene();

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quadMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene:        { value: _sceneTarget.texture },
      tDepth:        { value: _sceneTarget.depthTexture },
      resolution:    { value: new THREE.Vector2(pw, ph) },
      cameraNear:    { value: 0.1 },
      cameraFar:     { value: 400 },
      outlineThickness:      { value: _params.outlineThickness },
      depthThreshold:        { value: _params.depthThreshold },
      outlineColor:          { value: new THREE.Vector3(..._params.outlineColor) },
      depthDependentThickness: { value: _params.depthDependentThickness },
    },
    vertexShader: outlineVert,
    fragmentShader: outlineFrag,
    depthTest: false,
    depthWrite: false,
  });

  _quadMesh = new THREE.Mesh(quadGeo, quadMat);
  _quadScene.add(_quadMesh);
}

// ─── RESIZE ──────────────────────────────────────────────────
export function resizeOutlines(w, h) {
  if (!_sceneTarget) return;
  const pr = _renderer.getPixelRatio();
  const pw = w * pr;
  const ph = h * pr;

  _sceneTarget.setSize(pw, ph);
  _sceneTarget.depthTexture.image.width = pw;
  _sceneTarget.depthTexture.image.height = ph;

  const u = _quadMesh.material.uniforms;
  u.resolution.value.set(pw, ph);
}

// ─── RENDER WITH OUTLINES ────────────────────────────────────
export function renderWithOutlines(scene, camera, outputTarget) {
  if (!_renderer || !_sceneTarget) return;

  const u = _quadMesh.material.uniforms;
  u.cameraNear.value = camera.near;
  u.cameraFar.value = camera.far;

  // 1) Scene render → sceneTarget (with depth)
  _renderer.setRenderTarget(_sceneTarget);
  _renderer.render(scene, camera);

  // 2) Outline composite → outputTarget (or screen)
  _renderer.setRenderTarget(outputTarget);
  _renderer.render(_quadScene, _quadCamera);
}

// ─── PARAMS ──────────────────────────────────────────────────
export function setOutlineParams(params) {
  Object.assign(_params, params);
  if (!_quadMesh) return;

  const u = _quadMesh.material.uniforms;
  if (params.outlineThickness !== undefined) u.outlineThickness.value = params.outlineThickness;
  if (params.depthThreshold !== undefined) u.depthThreshold.value = params.depthThreshold;
  if (params.outlineColor !== undefined) u.outlineColor.value.set(...params.outlineColor);
  if (params.depthDependentThickness !== undefined) u.depthDependentThickness.value = params.depthDependentThickness;
}
