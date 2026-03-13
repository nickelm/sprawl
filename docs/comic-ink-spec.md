# Comic Ink Outline — Post-Processing Spec — sprawl

## Context

This spec adds comic-style ink outlines to SPRAWL via a screen-space post-processing pipeline. The effect renders black contour lines around silhouettes and object boundaries — the "inked" look — without hatching flat surfaces or terrain.

Read `CLAUDE.md`, `destruction-spec.md`, and `weapons-spec.md` before starting. Obey all hard rules. This system lives in `src/renderer.js` and a new `src/inkpass.js`.

---

## 1. Why Not Other Approaches

- **`OutlineEffect` (inverted hull):** Extrudes vertices along normals to render back-face silhouette. Fails on flat-shaded non-indexed `BufferGeometry` — corner gaps appear because normals diverge at hard edges (Three.js #19096). Also applies globally with no selective control.
- **Depth + Normal edge detection:** Normal buffer on flat-shaded geometry produces per-triangle discontinuities. Every triangle edge becomes an ink line. The terrain and flat walls get hatched. Unusable.
- **Chosen: Depth + Object ID edge detection.** Depth catches silhouette edges and occlusion boundaries. Object ID catches boundaries between objects at similar depths. Neither produces false edges on co-planar flat-shaded faces.

---

## 2. Pipeline Overview

Three buffers, one composite shader.

```
Frame render:
  1. Normal scene render → colorBuffer (existing)
  2. Depth buffer → depthBuffer (already produced by WebGLRenderer, extract via DepthTexture)
  3. Object ID pass → idBuffer (one extra render pass, overrideMaterial)
  4. Ink composite shader → final output (fullscreen quad)
```

### 2.1 Render Targets

```javascript
// Color + depth (shared target)
const colorTarget = new THREE.WebGLRenderTarget(w, h, {
  depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType),
  // Existing target if already used for thermal/NV; otherwise create
});

// Object ID target
const idTarget = new THREE.WebGLRenderTarget(w, h, {
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  format: THREE.RGBAFormat,
  type: THREE.UnsignedByteType,
  // No depth texture needed — use same depth test, just different colors
});
```

### 2.2 Depth Availability

Three.js r128 supports `DepthTexture` on `WebGLRenderTarget`. Attach a `DepthTexture` to the color render target. The depth buffer is then available as a texture in the composite shader without an extra render pass. Cost: zero additional draw calls for depth.

---

## 3. Object ID Pass

### 3.1 ID Assignment

Every object category gets a unique flat color. The ID pass renders the scene with `scene.overrideMaterial` set to a special material that outputs per-object colors.

**Problem:** `overrideMaterial` applies one material to everything. We need per-object colors.

**Solution:** Use `onBeforeRender` callbacks to set a uniform per mesh, OR use vertex colors set on a per-mesh basis. The cleanest approach for SPRAWL: assign each mesh a `.userData.inkId` value, then use a custom `ShaderMaterial` as override that reads a uniform.

Actually, `overrideMaterial` can't vary per object. Better approach: **do NOT use overrideMaterial.** Instead, before the ID pass, swap each mesh's material to a cached flat-color `MeshBasicMaterial` keyed by category. After the ID pass, restore originals.

```javascript
// ID color assignments (R, G, B — A=255 always)
const INK_IDS = {
  terrain:    [1, 0, 0],    // red channel
  building:   null,          // per-building unique — see §3.2
  enemy:      [0, 1, 0],    // green channel
  weapon:     [0, 0, 1],    // blue channel
  debris:     [1, 1, 0],    // yellow
  prop:       [1, 0, 1],    // magenta
  sky:        [0, 0, 0],    // black (clear color of idTarget)
};
```

### 3.2 Per-Building Unique IDs

Each building gets a unique ID color so adjacent buildings produce ink edges between them. With 24 bits of color (RGB, 8 bits each), we can address 16M unique buildings. In practice, only loaded chunks matter — ~50–200 buildings at a time.

```javascript
// Assign on building creation
let buildingIdCounter = 1;
function assignBuildingInkId(buildingGroup) {
  const id = buildingIdCounter++;
  const r = (id & 0xFF) / 255;
  const g = ((id >> 8) & 0xFF) / 255;
  const b = ((id >> 16) & 0xFF) / 255;
  // Store on all child meshes
  buildingGroup.traverse(child => {
    if (child.isMesh) {
      child.userData.inkId = [r, g, b];
    }
  });
}
```

When a chunk unloads, its building IDs can be recycled (but with 16M IDs, no urgency).

### 3.3 ID Pass Execution

```javascript
function renderIdPass(renderer, scene, camera) {
  // 1. Swap materials
  scene.traverse(obj => {
    if (obj.isMesh && obj.userData.inkId) {
      obj._savedMaterial = obj.material;
      obj.material = getIdMaterial(obj.userData.inkId);
    }
  });

  // 2. Set background to black (sky = no object)
  const savedBg = scene.background;
  scene.background = null;
  renderer.setClearColor(0x000000, 1);

  // 3. Render
  renderer.setRenderTarget(idTarget);
  renderer.clear();
  renderer.render(scene, camera);

  // 4. Restore materials
  scene.traverse(obj => {
    if (obj._savedMaterial) {
      obj.material = obj._savedMaterial;
      delete obj._savedMaterial;
    }
  });
  scene.background = savedBg;
}
```

**Material cache:** Pre-create and cache `MeshBasicMaterial({ color })` per ID. Don't allocate per frame.

```javascript
const idMaterialCache = new Map();
function getIdMaterial(rgb) {
  const key = `${rgb[0]},${rgb[1]},${rgb[2]}`;
  if (!idMaterialCache.has(key)) {
    idMaterialCache.set(key, new THREE.MeshBasicMaterial({
      color: new THREE.Color(rgb[0], rgb[1], rgb[2]),
      flatShading: false,
      fog: false,
    }));
  }
  return idMaterialCache.get(key);
}
```

### 3.4 Viewmodel Exclusion

The player's weapon viewmodel should NOT participate in the ID pass. It occupies the foreground and would produce distracting edges against everything. Skip meshes tagged `userData.isViewmodel = true` during material swap (leave them invisible in the ID pass by setting `visible = false`, then restore).

Weapon outlines are handled separately — see §6.

---

## 4. Ink Composite Shader

Fullscreen quad `ShaderMaterial`. Takes three inputs: color, depth, object ID.

### 4.1 Uniforms

```javascript
uniforms: {
  tColor:      { value: colorTarget.texture },
  tDepth:      { value: colorTarget.depthTexture },
  tId:         { value: idTarget.texture },
  resolution:  { value: new THREE.Vector2(w, h) },
  inkColor:    { value: new THREE.Vector3(0.05, 0.05, 0.08) }, // near-black, slight blue
  inkWidth:    { value: 1.0 },  // pixel width multiplier
  depthThreshold:  { value: 0.002 },  // sensitivity for depth edges
  idThreshold:     { value: 0.01 },   // sensitivity for ID edges (any difference = edge)
  cameraNear:  { value: camera.near },
  cameraFar:   { value: camera.far },
  enabled:     { value: 1 },  // toggle on/off
  // Line boil (hand-drawn wobble)
  time:        { value: 0.0 },  // incremented per frame
  boilAmount:  { value: 0.5 },  // 0 = clean lines, 1 = full wobble
  boilSpeed:   { value: 8.0 },  // Hz — how fast lines shift
}
```

### 4.2 Fragment Shader

```glsl
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tId;
uniform vec2 resolution;
uniform vec3 inkColor;
uniform float inkWidth;
uniform float depthThreshold;
uniform float idThreshold;
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
  // Quantize time to discrete steps (3–4 fps for hand-drawn feel)
  float boilFrame = floor(time * boilSpeed);
  // Per-pixel random offset that changes each boil frame
  vec2 wobble = vec2(
    hash(gl_FragCoord.xy + boilFrame) - 0.5,
    hash(gl_FragCoord.xy * 1.7 + boilFrame) - 0.5
  ) * texel * boilAmount;

  // Sample depth at 4 neighbors (Roberts Cross for speed, Sobel for quality)
  // Using Roberts Cross: compare diagonal pairs
  // wobble offsets each sample position for line boil
  float d00 = linearizeDepth(texture2D(tDepth, vUv + wobble).r);
  float d10 = linearizeDepth(texture2D(tDepth, vUv + vec2(texel.x, 0.0) + wobble).r);
  float d01 = linearizeDepth(texture2D(tDepth, vUv + vec2(0.0, texel.y) + wobble).r);
  float d11 = linearizeDepth(texture2D(tDepth, vUv + vec2(texel.x, texel.y) + wobble).r);

  // Roberts Cross gradient magnitude
  float depthEdge = sqrt(
    pow(d00 - d11, 2.0) +
    pow(d10 - d01, 2.0)
  );

  // Depth-adaptive threshold: far objects need smaller threshold
  // because depth values compress at distance
  float adaptiveThreshold = depthThreshold * d00;
  float depthInk = step(adaptiveThreshold, depthEdge);

  // Object ID edges: any color difference = boundary
  vec3 id00 = texture2D(tId, vUv + wobble).rgb;
  vec3 id10 = texture2D(tId, vUv + vec2(texel.x, 0.0) + wobble).rgb;
  vec3 id01 = texture2D(tId, vUv + vec2(0.0, texel.y) + wobble).rgb;
  vec3 id11 = texture2D(tId, vUv + vec2(texel.x, texel.y) + wobble).rgb;

  float idEdge = length(id00 - id11) + length(id10 - id01);
  float idInk = step(idThreshold, idEdge);

  // Combine: either edge type triggers ink
  float ink = max(depthInk, idInk);

  // Blend: ink darkens the color
  gl_FragColor = vec4(mix(color.rgb, inkColor, ink), 1.0);
}
```

### 4.3 Vertex Shader

Standard fullscreen quad:

```glsl
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
```

### 4.4 Fullscreen Quad Setup

```javascript
const inkQuad = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  inkShaderMaterial
);
const inkScene = new THREE.Scene();
inkScene.add(inkQuad);
const inkCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
```

---

## 5. Integration with Existing Post-Processing

The weapons spec defines thermal and NV as post-processing effects on the color buffer. The ink pass must compose correctly with both.

### 5.1 Pass Order

```
1. Render scene → colorTarget (+ depthTexture)
2. Render ID pass → idTarget
3. Ink composite → inkTarget (or screen if no further passes)
4. Thermal / NV / Scope → final screen output (if active)
```

Ink runs BEFORE thermal/NV. Rationale: the ink lines should be visible through thermal and NV modes. In thermal, ink lines appear as the coldest color (dark blue/purple). In NV, they appear as dark green. This preserves the comic look under all vision modes.

If thermal/NV are NOT active, ink composites directly to screen (skip the intermediate target).

### 5.2 Shared Render Target

If thermal/NV already render the scene to an offscreen target, reuse that same target for step 1. Don't render the scene twice. The `depthTexture` attachment is new — add it to the existing color target.

### 5.3 Frame Update

Each frame, update the `time` uniform for line boil:

```javascript
inkMaterial.uniforms.time.value = performance.now() / 1000.0;
```

---

## 6. Weapon Viewmodel Outlines

The viewmodel is excluded from the world ink pass (§3.4) because it would produce edges against every background pixel. Instead, the weapon gets its own dedicated outline treatment.

### 6.1 Approach: Inverted Hull on Viewmodel Only

The inverted hull method works well on weapon geometry because weapons are smooth convex-ish shapes (boxes, cylinders) where corner gaps are minimal and tolerable at viewmodel scale. Apply to the weapon viewmodel only.

```javascript
function createWeaponOutline(weaponMesh) {
  const outlineMesh = weaponMesh.clone();
  outlineMesh.material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.BackSide,
  });
  // Extrude along normals via onBeforeCompile
  outlineMesh.material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      'vec3 transformed = position + normal * 0.008;' // 8mm extrusion
    );
  };
  outlineMesh.renderOrder = -1; // Render before the weapon itself
  return outlineMesh;
}
```

### 6.2 Viewmodel Rendering

The weapon viewmodel already renders with a separate camera (or clearDepth before render). The outline mesh is added as a child of the weapon group. It renders with the weapon, using back-face culling to show only the silhouette edge.

Extrusion distance: `0.008` (8mm in world units). Tune visually — should produce ~2px outline at typical viewmodel distance.

---

## 7. Performance

### 7.1 Cost Breakdown

| Pass | Draw Calls | GPU Cost |
|------|-----------|----------|
| Scene render (existing) | N | baseline |
| ID pass | N (same scene, flat materials) | ~40% of scene render (no lighting calc) |
| Ink composite | 1 (fullscreen quad) | ~0.3ms |
| Weapon outline | +1 mesh per weapon part | negligible |

Total additional cost: ~40% of one scene render + 0.3ms. On a scene that renders in 4ms, the ID pass adds ~1.6ms. Total ink overhead: ~2ms. Within the existing 2ms post-processing budget from the weapons spec.

### 7.2 Optimizations

- **Half-resolution ID buffer:** Render the ID pass at 50% resolution. Edge detection still works — ink lines become 2px instead of 1px, which actually looks better (thicker ink). Cuts ID pass cost by 75%.
- **Skip ID pass for distant chunks:** Only render buildings within 100m into the ID buffer. Distant buildings get depth-only outlines (still visible, just no inter-building edges at long range). This is barely noticeable.
- **Material swap cost:** The traverse + swap is O(meshes). With ~200 buildings × ~6 meshes each = ~1200 swaps. Each swap is a pointer assignment. Total: <0.1ms.

### 7.3 Toggle

The ink effect has a master toggle (`enabled` uniform). When disabled, the ID pass is skipped entirely (not just the composite). No GPU cost when off.

---

## 8. Line Boil (Hand-Drawn Wobble)

Traditional animation "line boil" makes inked outlines feel hand-drawn by subtly shifting line positions frame to frame. In screen space, this is achieved by wobbling the UV coordinates used for edge detection sampling.

### 8.1 Technique

The wobble is NOT per-frame smooth motion. It uses quantized time steps (`floor(time * boilSpeed)`) so the lines jump between discrete positions at 3–8 Hz — matching the frame rate of hand-drawn animation (2s, 3s, or 4s on 24fps film). The hash function gives each pixel a different random offset per boil frame, so the entire line shifts and warps slightly, not just translates.

### 8.2 Subtlety Control

`boilAmount` at 0.5 means the wobble displaces sampling by half a texel in each axis. This is subtle — lines shift by sub-pixel to 1px amounts. At 1.0, the wobble is a full texel, producing a visible hand-drawn jitter. At 0.0, lines are perfectly stable (clean digital look).

### 8.3 Boil Speed

`boilSpeed` at 8.0 Hz means lines change position 8 times per second. This is roughly "animating on 3s" at 24fps — a common cadence for hand-drawn ink. Lower values (3–4 Hz) feel more deliberate/cinematic. Higher values (12+) start to feel like noise/vibration rather than hand-drawn.

### 8.4 Interaction with Weapon Viewmodel

The inverted hull weapon outline (§6) does NOT boil — it's geometry-based, not screen-space. This is actually correct: in comics, foreground objects (the thing you're holding) have stable clean lines, while the environment behind has the hand-drawn wobble. If weapon boil is desired later, add a small sine-based vertex offset in the outline material's vertex shader, keyed to the same quantized time step.

---

## 9. Tuning Parameters

Expose these in a debug panel (and eventually a settings menu):

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `inkWidth` | 1.0 | 0.5–3.0 | Line thickness in pixels |
| `depthThreshold` | 0.002 | 0.0005–0.01 | Lower = more depth edges |
| `idThreshold` | 0.01 | 0.001–0.05 | Lower = more sensitive ID edges |
| `inkColor` | (0.05, 0.05, 0.08) | any RGB | Ink tint. Near-black with slight blue reads as comic ink |
| `boilAmount` | 0.5 | 0.0–1.5 | Line wobble intensity. 0 = clean, 0.5 = subtle, 1.0+ = heavy |
| `boilSpeed` | 8.0 | 0.0–16.0 | Wobble rate in Hz. 0 = frozen, 8 = hand-drawn, 16 = nervous |
| `enabled` | true | bool | Master toggle |
| `halfResId` | true | bool | Half-resolution ID buffer |
| `weaponOutline` | true | bool | Viewmodel inverted hull on/off |
| `weaponOutlineWidth` | 0.008 | 0.002–0.02 | Viewmodel outline extrusion |

---

## 10. Edge Cases

- **Destroyed panels (zeroed vertices):** Degenerate triangles in the ID pass render nothing — correct. The gap left by destruction will produce depth edges against whatever is behind it.
- **Glass panels (transparent):** In the ID pass, glass renders as its building's solid ID color. This means glass produces an edge against exterior objects. Correct — you see the window frame outlined.
- **Fog:** The scene render includes fog. The ID pass should NOT include fog (materials have `fog: false`). Fog doesn't affect edge detection.
- **Muzzle flash / particles:** Exclude from ID pass (`userData.inkExclude = true`). Muzzle flashes are transient — outlining them would look wrong.
- **Dust / debris particles:** Exclude from ID pass. Small, transient, numerous. Outlining them wastes GPU and looks cluttered.
- **Rubble mounds:** Include in ID pass with a shared `rubble` ID. Adjacent rubble won't outline against itself, but rubble will outline against terrain and buildings.

---

## 11. Implementation Order

1. **Render targets** — Add `DepthTexture` to existing color target. Create ID target.
2. **Ink composite shader** — Fullscreen quad, depth-only edge detection first. Get silhouette outlines working.
3. **ID pass infrastructure** — `userData.inkId` assignment, material swap, ID render.
4. **ID edge detection** — Add ID sampling to composite shader. Tune thresholds.
5. **Weapon viewmodel outline** — Inverted hull on weapon mesh.
6. **Integration with thermal/NV** — Verify pass ordering. Ink lines visible through vision modes.
7. **Half-res optimization** — Render ID at 50% resolution.
8. **Debug panel** — Expose tuning parameters.

Steps 1–2 are a visible milestone (silhouette outlines). Steps 3–4 complete the system. Steps 5–8 are polish.

---

## 12. File Changes

| File | Changes |
|------|---------|
| `src/inkpass.js` | **New.** Ink composite shader, ID pass logic, fullscreen quad, material cache |
| `src/renderer.js` | Add render targets, integrate ink pass into render loop, pass ordering |
| `src/buildings.js` | Assign `userData.inkId` on building creation |
| `src/enemies.js` | Assign `userData.inkId` on enemy spawn |
| `src/terrain.js` | Assign `userData.inkId` on terrain chunk creation |
| `src/weapons.js` | Assign `userData.isViewmodel`, create inverted hull outline mesh |
| `src/destruction.js` | Exclude debris/particles from ID pass (`userData.inkExclude`) |