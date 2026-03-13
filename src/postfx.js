import * as THREE from 'three';

// ─── POST-PROCESSING: THERMAL + NIGHT VISION ─────────────────
// Uses WebGLRenderTarget + fullscreen quad (no EffectComposer dependency).

let _renderer, _scene;
let _renderTarget, _heatTarget;
let _quadScene, _quadCamera, _quadMesh;
let _mode = 'none';   // 'none' | 'thermal' | 'nv'
let _blend = 0;        // 0 = off, 1 = full effect
let _blendTarget = 0;
let _blendSpeed = 4.0; // ramp speed (1/adsTime)
let _time = 0;

// White override material for heat mask pass
const _whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const _blackMat = new THREE.MeshBasicMaterial({ color: 0x000000 });

// ─── SHADER: THERMAL ──────────────────────────────────────────
const thermalVert = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const thermalFrag = `
uniform sampler2D tScene;
uniform sampler2D tHeat;
uniform float blend;

varying vec2 vUv;

// Thermal palette: dark blue → purple → red → orange → yellow → white
vec3 thermalPalette(float t) {
  if (t < 0.2) {
    float f = t / 0.2;
    return mix(vec3(0.0, 0.0, 0.15), vec3(0.2, 0.0, 0.4), f);  // dark blue → purple
  } else if (t < 0.4) {
    float f = (t - 0.2) / 0.2;
    return mix(vec3(0.2, 0.0, 0.4), vec3(0.8, 0.1, 0.1), f);    // purple → red
  } else if (t < 0.6) {
    float f = (t - 0.4) / 0.2;
    return mix(vec3(0.8, 0.1, 0.1), vec3(1.0, 0.5, 0.0), f);    // red → orange
  } else if (t < 0.8) {
    float f = (t - 0.6) / 0.2;
    return mix(vec3(1.0, 0.5, 0.0), vec3(1.0, 1.0, 0.2), f);    // orange → yellow
  } else {
    float f = (t - 0.8) / 0.2;
    return mix(vec3(1.0, 1.0, 0.2), vec3(1.0, 1.0, 1.0), f);    // yellow → white
  }
}

void main() {
  vec4 sceneColor = texture2D(tScene, vUv);
  vec4 heatColor = texture2D(tHeat, vUv);

  // Scene luminance
  float lum = dot(sceneColor.rgb, vec3(0.299, 0.587, 0.114));

  // Heat contribution: boost luminance where heat mask is white
  float heat = dot(heatColor.rgb, vec3(0.333, 0.333, 0.333));
  float thermalLum = clamp(lum * 0.7 + heat * 0.8, 0.0, 1.0);

  vec3 thermalColor = thermalPalette(thermalLum);

  // Blend between normal scene and thermal
  vec3 finalColor = mix(sceneColor.rgb, thermalColor, blend);
  gl_FragColor = vec4(finalColor, 1.0);
}
`;

// ─── SHADER: NIGHT VISION ─────────────────────────────────────
const nvFrag = `
uniform sampler2D tScene;
uniform float blend;
uniform float time;
uniform vec2 resolution;

varying vec2 vUv;

// Simple hash noise
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec4 sceneColor = texture2D(tScene, vUv);

  // Grayscale luminance
  float lum = dot(sceneColor.rgb, vec3(0.299, 0.587, 0.114));

  // Amplify (×3.0, saturate at ~0.33 input)
  float amplified = clamp(lum * 3.0, 0.0, 1.0);

  // Green tint
  vec3 nvColor = amplified * vec3(0.2, 1.0, 0.2);

  // Film grain noise (±5%)
  float noise = hash(vUv * resolution + vec2(time * 137.0, time * 251.0));
  nvColor += (noise - 0.5) * 0.1 * amplified;

  // Simple bloom: sample nearby pixels and add bright areas
  float bloomAccum = 0.0;
  float px = 1.0 / resolution.x;
  float py = 1.0 / resolution.y;
  for (int i = -2; i <= 2; i++) {
    for (int j = -2; j <= 2; j++) {
      if (i == 0 && j == 0) continue;
      vec4 s = texture2D(tScene, vUv + vec2(float(i) * px * 3.0, float(j) * py * 3.0));
      float sLum = dot(s.rgb, vec3(0.299, 0.587, 0.114));
      if (sLum > 0.33) bloomAccum += sLum;
    }
  }
  bloomAccum /= 24.0;
  nvColor += vec3(0.1, 0.5, 0.1) * bloomAccum * 2.0;

  // Vignette (edge darkening)
  vec2 vc = vUv - 0.5;
  float vignette = 1.0 - dot(vc, vc) * 1.5;
  nvColor *= clamp(vignette, 0.3, 1.0);

  // Blend between normal scene and NV
  vec3 finalColor = mix(sceneColor.rgb, nvColor, blend);
  gl_FragColor = vec4(finalColor, 1.0);
}
`;

// ─── INIT ──────────────────────────────────────────────────────
export function initPostFX(renderer, scene) {
  _renderer = renderer;
  _scene = scene;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const pixelRatio = renderer.getPixelRatio();

  _renderTarget = new THREE.WebGLRenderTarget(w * pixelRatio, h * pixelRatio);
  _heatTarget = new THREE.WebGLRenderTarget(
    Math.floor(w * pixelRatio / 2),
    Math.floor(h * pixelRatio / 2)
  );

  // Fullscreen quad
  _quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  _quadScene = new THREE.Scene();

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quadMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: _renderTarget.texture },
      tHeat: { value: _heatTarget.texture },
      blend: { value: 0.0 },
      time: { value: 0.0 },
      resolution: { value: new THREE.Vector2(w * pixelRatio, h * pixelRatio) },
    },
    vertexShader: thermalVert,
    fragmentShader: thermalFrag,
    depthTest: false,
    depthWrite: false,
  });

  _quadMesh = new THREE.Mesh(quadGeo, quadMat);
  _quadScene.add(_quadMesh);
}

// ─── RESIZE HANDLER ───────────────────────────────────────────
export function resizePostFX(w, h) {
  if (!_renderTarget) return;
  const pixelRatio = _renderer.getPixelRatio();
  const pw = w * pixelRatio;
  const ph = h * pixelRatio;

  _renderTarget.setSize(pw, ph);
  _heatTarget.setSize(Math.floor(pw / 2), Math.floor(ph / 2));

  const u = _quadMesh.material.uniforms;
  u.resolution.value.set(pw, ph);
}

// ─── MODE CONTROL ─────────────────────────────────────────────
export function setPostFXMode(mode, rampSpeed) {
  if (mode === _mode && _blendTarget === 1) return;

  if (mode === 'none') {
    _blendTarget = 0;
    // Keep _mode until blend reaches 0 (handled in update)
    return;
  }

  _mode = mode;
  _blendTarget = 1;
  if (rampSpeed !== undefined) _blendSpeed = rampSpeed;

  // Switch shader
  const u = _quadMesh.material.uniforms;
  if (mode === 'thermal') {
    _quadMesh.material.fragmentShader = thermalFrag;
    _quadMesh.material.needsUpdate = true;
    // Ensure tHeat uniform exists
    if (!u.tHeat) u.tHeat = { value: _heatTarget.texture };
  } else if (mode === 'nv') {
    _quadMesh.material.fragmentShader = nvFrag;
    _quadMesh.material.needsUpdate = true;
  }
}

export function getPostFXMode() { return _mode; }
export function postFXActive() { return _blend > 0.001 || _blendTarget > 0; }

// ─── UPDATE BLEND ─────────────────────────────────────────────
export function updatePostFXBlend(dt) {
  if (!_quadMesh) return;

  _time += dt;

  if (_blend < _blendTarget) {
    _blend = Math.min(_blendTarget, _blend + dt * _blendSpeed);
  } else if (_blend > _blendTarget) {
    _blend = Math.max(_blendTarget, _blend - dt * _blendSpeed);
    // When fully faded out, reset mode
    if (_blend <= 0.001) {
      _blend = 0;
      _mode = 'none';
    }
  }

  _quadMesh.material.uniforms.blend.value = _blend;
  _quadMesh.material.uniforms.time.value = _time;
}

// ─── RENDER WITH POST-FX ─────────────────────────────────────
// Legacy path: renders scene itself + applies effect. Still works standalone.
export function renderWithPostFX(scene, camera) {
  if (!_renderer || !_renderTarget) return;

  if (_mode === 'thermal') renderHeatMask(scene, camera);

  _renderer.setRenderTarget(_renderTarget);
  _renderer.render(scene, camera);

  _renderer.setRenderTarget(null);
  _renderer.render(_quadScene, _quadCamera);
}

// ─── SPLIT API (for outline pipeline integration) ────────────
// Returns the render target that postfx reads its input from.
// Outlines render INTO this target, then applyPostFX() composites to screen.
export function getPostFXInputTarget() { return _renderTarget; }

// Apply just the heat mask + fullscreen quad composite (no scene render).
// Expects _renderTarget to already contain the outlined scene.
export function applyPostFX(scene, camera) {
  if (!_renderer || !_renderTarget) return;

  if (_mode === 'thermal') renderHeatMask(scene, camera);

  _renderer.setRenderTarget(null);
  _renderer.render(_quadScene, _quadCamera);
}

// ─── HEAT MASK PASS ───────────────────────────────────────────
// Renders hot objects (enemies, muzzle flash) as white on black.
function renderHeatMask(scene, camera) {
  const savedBackground = scene.background;
  const savedFog = scene.fog;
  const savedOverride = scene.overrideMaterial;

  // Set scene to render black background
  scene.background = new THREE.Color(0x000000);
  scene.fog = null;

  // Hide all objects, show only hot ones
  const visibility = [];
  scene.traverse(obj => {
    if (obj.isMesh) {
      visibility.push({ obj, visible: obj.visible, material: obj.material });
      if (obj.userData.isHot) {
        obj.visible = true;
        obj.material = _whiteMat;
      } else {
        obj.visible = false;
      }
    }
  });

  _renderer.setRenderTarget(_heatTarget);
  _renderer.render(scene, camera);

  // Restore all objects
  for (const entry of visibility) {
    entry.obj.visible = entry.visible;
    entry.obj.material = entry.material;
  }

  scene.background = savedBackground;
  scene.fog = savedFog;
  scene.overrideMaterial = savedOverride;
}
