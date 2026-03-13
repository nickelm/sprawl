# Model Decomposition & Editor Tools — sprawl

## Context

This spec defines two tools for producing procedural 3D models for `sprawl`. The primary use case is weapons (10 archetypes + attachments), but the pipeline is general-purpose — any 3D model (props, vehicles, furniture, street objects) can be decomposed into a primitive recipe and edited.

1. **Decomposer** — Node.js CLI that takes a 3D model file (GLB/glTF or OBJ), uses V-HACD to oversegment it into convex hulls, fits a box or cylinder primitive to each hull, merges adjacent similar primitives down to a budget, and outputs a JSON recipe.
2. **Editor** — Browser-based Three.js tool that loads recipes, lets the user tag part groups, define attachment points, adjust/delete/add primitives, set colors, and export final recipes. Also supports authoring simple models from scratch (attachments, small props) without a source model.

The JSON recipe is the interface between both tools and the game runtime. The game's `buildModelFromRecipe(json)` constructs a `THREE.Group` from the recipe at load time — no external model files shipped.

The decomposition is a lossy geometric approximation. The output is original authored geometry (primitive placements), not a derivative of the source mesh topology. Source models are reference-only and are not distributed.

---

## 1. JSON Recipe Format

```json
{
  "name": "MK14",
  "category": "weapon",
  "archetype": "dmr",
  "version": 1,
  "units": "cm",
  "origin": "receiver_center",
  "primitives": [
    {
      "id": "receiver_main",
      "group": "receiver",
      "type": "box",
      "pos": [0, 0, 0],
      "rot": [0, 0, 0],
      "scale": [3.2, 4.5, 18.0],
      "color": "#3a3a3a"
    },
    {
      "id": "barrel",
      "group": "barrel",
      "type": "cylinder",
      "pos": [0, 1.2, 14.0],
      "rot": [90, 0, 0],
      "scale": [0.6, 0.6, 22.0],
      "color": "#2a2a2a"
    }
  ],
  "attachmentPoints": {
    "muzzle":     { "pos": [0, 1.2, 36.0], "dir": [0, 0, 1] },
    "optic_rail": { "pos": [0, 3.0, 2.0],  "dir": [0, 1, 0] },
    "underbarrel": { "pos": [0, -1.0, 8.0], "dir": [0, -1, 0] },
    "magazine":   { "pos": [0, -2.5, -1.0], "dir": [0, -1, 0] },
    "stock":      { "pos": [0, 0, -9.0],    "dir": [0, 0, -1] }
  },
  "viewmodel": {
    "scale": 1.0,
    "pos": [12, -10, -15],
    "rot": [0, 0, 0]
  },
  "worldmodel": {
    "scale": 0.4
  }
}
```

### 1.1 Fields

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `category` | `"weapon"`, `"attachment"`, `"prop"`, `"vehicle"`, `"furniture"` |
| `archetype` | Weapon-specific. One of: `pistol`, `revolver`, `smg`, `carbine`, `ar`, `battle_rifle`, `lmg`, `dmr`, `sniper`, `shotgun`. Omit for non-weapons. |
| `version` | Schema version (integer) |
| `units` | Always `"cm"` — all dimensions in centimeters |
| `origin` | Semantic label for the recipe's local origin |
| `primitives[]` | Array of primitive definitions (see §1.2) |
| `attachmentPoints` | Named positions + directions where child models mount (see §1.3). Weapons use these for attachments; props can use them for placement anchors (e.g., a table's "surface" point). Optional. |
| `viewmodel` | First-person display offset/scale. Weapon-specific. Optional. |
| `worldmodel` | Third-person scale factor. Optional (default: use recipe scale as-is). |

### 1.2 Primitive Definition

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique within recipe. Human-readable (`barrel_main`, `stock_upper`). |
| `group` | string | One of: `receiver`, `barrel`, `stock`, `magazine`, `muzzle`, `underbarrel`, `optic_rail`, `grip`, `trigger_guard`, `cosmetic`. Attachments replace or extend a group. |
| `type` | string | `"box"` or `"cylinder"`. Wedge support optional (§3.7). |
| `pos` | [x,y,z] | Center position in recipe-local coords (cm). |
| `rot` | [rx,ry,rz] | Euler rotation in degrees (XYZ order). |
| `scale` | [sx,sy,sz] | Full extents for box (width, height, depth); for cylinder: [radiusX, radiusZ, height]. |
| `color` | hex string | Material color. Editor sets this; decomposer assigns defaults by group. |

### 1.3 Attachment Points

Each named point has a position (`pos`) and a direction vector (`dir`) indicating the mounting axis. The game runtime uses these to position attachment geometry:

- `muzzle` — tip of barrel, +Z. Suppressors, compensators, flash hiders attach here.
- `optic_rail` — top of receiver, +Y. Optics mount here.
- `underbarrel` — bottom of forend, -Y. Grips, bipods, launchers.
- `magazine` — magazine well, -Y. Magazine geometry anchors here.
- `stock` — rear of receiver, -Z. Stocks attach here.

Attachment points are set manually in the editor, not by the decomposer.

---

## 2. Stage 1: Decomposer (Node CLI)

### 2.1 Usage

```bash
node tools/decompose.js input.glb --output recipes/mk14.json \
  --budget 25 --max-hulls 80 --category weapon --archetype dmr

node tools/decompose.js chair.obj --output recipes/office_chair.json \
  --budget 15 --max-hulls 60 --category furniture

node tools/decompose.js car.glb --output recipes/sedan.json \
  --budget 40 --max-hulls 120 --category vehicle
```

| Flag | Default | Description |
|------|---------|-------------|
| `--output` | stdout | Output JSON path |
| `--budget` | 25 | Target number of primitives in final output |
| `--max-hulls` | 80 | Number of convex hulls V-HACD produces (oversegmentation count). Should be 2-4× budget. |
| `--category` | `"prop"` | Recipe category: `weapon`, `attachment`, `prop`, `vehicle`, `furniture` |
| `--archetype` | none | Weapon archetype (optional, sets default group heuristics + colors) |
| `--circularity` | 0.80 | Min circularity for cylinder detection (lower = more cylinders) |
| `--min-volume` | 0.5 | Min primitive volume as % of total mesh volume (filters noise) |
| `--normalize-size` | 50 | Target size in cm for longest axis |
| `--diagnostic` | false | Write an HTML visualization alongside the JSON output |
| `--vhacd-resolution` | 100000 | V-HACD voxel resolution (higher = more detail, slower) |
| `--vhacd-concavity` | 0.001 | V-HACD max concavity per hull (lower = tighter hulls) |

### 2.2 Supported Formats

| Format | Extensions | Parser | Notes |
|--------|-----------|--------|-------|
| glTF Binary | `.glb` | `@gltf-transform/core` | Primary format. What Sketchfab exports. |
| glTF | `.gltf` + `.bin` | `@gltf-transform/core` | Same parser, separate files. |
| Wavefront OBJ | `.obj` (+ optional `.mtl`) | Custom parser (~80 lines) | Text format, trivial to parse. Just `v` and `f` lines. MTL ignored — we only need geometry. |

Both paths produce the same intermediate representation: a flat `Float32Array` of vertex positions + a `Uint32Array` of triangle indices. Format differences vanish before V-HACD.

### 2.3 Pipeline

```
Load (GLB/OBJ) → Normalize → V-HACD Oversegment → Fit Primitive per Hull → Merge → Filter → Output
```

#### 2.3.1 Load & Normalize

**OBJ parser:** Read the file line by line. Lines starting with `v ` are vertices (3 floats). Lines starting with `f ` are faces (triangle or quad indices, 1-indexed — convert to 0-indexed). Quads get split into two triangles. Skip everything else (normals, UVs, materials, comments). ~80 lines of code.

**glTF parser:** Use `@gltf-transform/core` to read the document, iterate all meshes/primitives, extract position attributes and index buffers. Merge into one triangle soup.

**Normalize the mesh:**
1. Merge all mesh geometries into a single triangle soup.
2. Compute bounding box.
3. Translate so centroid is at origin.
4. Uniform scale so the longest axis spans `--normalize-size` cm. Record the original dimensions for reference metadata.

The normalization means every model starts at a consistent scale and centering. The editor adjusts final dimensions.

#### 2.3.2 V-HACD Oversegmentation

Use the `vhacd-js` npm package, which wraps V-HACD as WASM:

```javascript
import { ConvexMeshDecomposition } from 'vhacd-js';

const decomposer = await ConvexMeshDecomposition.create();

const hulls = decomposer.computeConvexHulls(
  { positions, indices },  // Float32Array, Uint32Array from §2.3.1
  {
    maxHulls: maxHulls,              // --max-hulls (default 80)
    resolution: vhacdResolution,     // --vhacd-resolution (default 100000)
    maximumConcavity: vhacdConcavity // --vhacd-concavity (default 0.001)
  }
);

// hulls: array of { positions: Float32Array, indices: Uint32Array }
// Each hull is a small convex mesh.
```

**Why oversegment:** Request 2-4× more hulls than the final primitive budget. V-HACD at high hull counts produces small, tightly-fitting convex pieces that naturally correspond to structural features. A barrel becomes 3-5 small cylindrical hulls. A receiver becomes 2-3 blocky hulls. A magazine is 1-2 hulls. The merge pass (§2.3.4) combines them back down to budget.

V-HACD uses proper volumetric concavity analysis to find segmentation boundaries. It handles arbitrary shapes — no assumptions about necks, elongation, or axis alignment.

**Tuning `--max-hulls`:** If the result has too few distinct parts (barrel and receiver merged), increase `--max-hulls`. If it's too fragmented, decrease it. 2-4× budget is the starting point.

#### 2.3.3 Primitive Fitting per Hull

For each convex hull from V-HACD, fit a single box or cylinder. Since each hull is already convex and compact, PCA-OBB fitting is stable — the problems that plagued PCA on full meshes (elongation, eigenvalue instability) don't apply.

**Step 1: Hull statistics**

For each hull:
1. Compute vertex centroid → primitive center.
2. Compute the 3×3 covariance matrix of vertex positions.
3. Eigendecomposition → 3 eigenvectors (principal axes) + 3 eigenvalues.

**Step 2: Oriented Bounding Box (OBB)**

1. Project all hull vertices onto the 3 eigenvector axes.
2. Per axis: min and max projection → half-extents.
3. Result: center, 3 axis vectors, 3 full extents.
4. Convert rotation matrix (from eigenvectors) to Euler angles (XYZ order, degrees).

**Step 3: Cylinder test**

1. Eigenvector with the **largest** eigenvalue = candidate cylinder axis.
2. Project all hull vertices onto the plane perpendicular to this axis.
3. Compute **circularity** of the 2D convex hull of the projection: `4π × area / perimeter²`. Circle = 1.0; square ≈ 0.785.
4. Compute **aspect ratio**: extent along cylinder axis / diameter of cross-section.

A hull becomes a cylinder when:
- `circularity > --circularity` (default 0.80), AND
- `aspectRatio > 1.5`

```
function fitPrimitive(hull):
    { center, eigenvectors, eigenvalues, extents } = analyzeHull(hull)
    rotationEuler = matrixToEuler(eigenvectors)

    longestAxis = argmax(eigenvalues)
    crossSection = projectToPlane(hull.positions, eigenvectors[longestAxis])
    circ = circularity(convexHull2D(crossSection))
    aspect = extents[longestAxis] / max(other extents)

    if circ > circularityThreshold and aspect > 1.5:
        radius = avgDistFromAxis(hull.positions, eigenvectors[longestAxis], center)
        height = extents[longestAxis]
        return {
            type: "cylinder",
            pos: center,
            rot: cylinderAlignmentEuler(eigenvectors[longestAxis]),
            scale: [radius, radius, height],
            _volume: PI * radius * radius * height,
            _vertices: hull.positions  // retained for merge refitting
        }
    else:
        return {
            type: "box",
            pos: center,
            rot: rotationEuler,
            scale: extents,
            _volume: extents[0] * extents[1] * extents[2],
            _vertices: hull.positions
        }
```

Fields prefixed with `_` are internal (used during merging, stripped before output).

#### 2.3.4 Adjacency Graph and Iterative Merging

After fitting a primitive to each hull, we typically have ~80 primitives for a 25-primitive budget. The merge pass reduces this to the target count by iteratively combining the most compatible adjacent pair.

**Step 1: Build adjacency graph**

Two hulls are adjacent if any vertex in hull A is within `adjacencyThreshold` distance of any vertex in hull B. Use a spatial hash (grid cells sized to the threshold) for efficient lookup.

`adjacencyThreshold` = a small fixed value, e.g. 0.5cm after normalization. V-HACD hulls that were adjacent in the original mesh will have vertices very close to each other. This value isn't sensitive — just needs to bridge the tiny gaps between hull boundaries.

**Step 2: Iterative greedy merge**

```
function mergeDown(primitives, adjacency, budget):
    while primitives.length > budget:
        bestPair = null
        bestCost = Infinity

        for each adjacent pair (A, B) in adjacency:
            merged = fitPrimitive(combineVertices(A, B))
            cost = mergeCost(A, B, merged)

            if cost < bestCost:
                bestCost = cost
                bestPair = (A, B)
                bestMerged = merged

        if bestPair == null:
            break  // no more adjacent pairs

        // Replace A and B with merged primitive
        remove A and B from primitives
        add bestMerged
        // bestMerged inherits all neighbors of A and B
        update adjacency graph

    return primitives
```

**Merge cost function:**

```
mergeCost(A, B, merged) =
    volumeIncrease + typePenalty + rotationPenalty

where:
    volumeIncrease = merged._volume / (A._volume + B._volume) - 1.0
        // 0.0 = perfect; 0.5 = 50% overshoot. This is the dominant term.

    typePenalty = (A.type != B.type) ? 0.3 : 0.0
        // Discourage merging a box with a cylinder

    rotationPenalty = angleBetweenPrincipalAxes(A, B) / 180.0 * 0.2
        // Discourage merging primitives at very different orientations
```

Volume increase dominates. Two adjacent barrel hulls (thin cylinders along the same axis) merge with near-zero volume increase — they become one longer cylinder. A barrel hull next to a receiver hull produces a bloated box with high volume increase — the algorithm avoids this merger until forced to by the budget.

**`combineVertices`:** Concatenate the `_vertices` arrays from both primitives. Run `fitPrimitive()` on the combined point cloud. This naturally produces the tightest primitive for the union.

**Step 3: Post-merge cleanup**

After reaching budget:
1. Re-run `fitPrimitive` on each surviving primitive's vertex set for tight fits.
2. **Snap rotations:** if any Euler angle is within 3° of a multiple of 90°, snap it to that multiple. Produces cleaner axis-aligned results for the low-poly aesthetic.

#### 2.3.5 Filtering

After merging:
1. Remove primitives smaller than `--min-volume` percent of total mesh volume. These capture noise from thin features (trigger guards, sling mounts, tiny protrusions).
2. Sort by group assignment (see §2.3.6).

#### 2.3.6 Auto-Group Assignment

The decomposer assigns a best-effort group based on category and spatial heuristics.

**Weapons** (`--category weapon` with `--archetype`): assign by position along the Z axis (longest axis = barrel direction after normalization):

| Z range (normalized) | Group |
|-----------------------|-------|
| > 60% forward | `barrel` |
| 20–60% forward | `receiver` |
| 0–20% (center area), below midline Y | `magazine` or `grip` |
| < 0% (rear) | `stock` |
| Small primitives on top of receiver | `optic_rail` |
| Small primitives below forend | `underbarrel` |

**Non-weapons** (`prop`, `furniture`, `vehicle`): all primitives get group `"body"`. The user assigns meaningful groups in the editor. Group tags are freeform strings (e.g., `"leg"`, `"seat"`, `"wheel"`, `"hood"`).

This is heuristic and approximate. The editor is where the user corrects group assignments.

### 2.4 Dependencies

```json
{
  "dependencies": {
    "vhacd-js": "^0.0.1",
    "@gltf-transform/core": "^4.0.0",
    "@gltf-transform/extensions": "^4.0.0"
  }
}
```

- **`vhacd-js`** — WASM build of V-HACD. Provides `ConvexMeshDecomposition` API. ~42MB package (WASM binary); irrelevant for an offline tool.
- **`@gltf-transform/core`** — glTF/GLB parsing. Extracts mesh geometry.
- **OBJ parsing** — custom (~80 lines), no dependency.
- **Linear algebra** — 3×3 eigendecomposition for PCA-OBB per hull (~60 lines inline) or use `ml-matrix`. Only applied to small compact hulls, not the full mesh — so PCA is stable.

### 2.5 Output

The decomposer writes a JSON recipe per §1. Group assignments are best-effort (weapons) or default `"body"` (everything else). Colors are defaults from the category/archetype palette. Attachment points are not set (editor responsibility).

**Diagnostic mode** (`--diagnostic`): additionally writes an HTML file next to the output JSON that renders the source mesh as a wireframe overlaid with the fitted primitives and V-HACD hull boundaries. Uses a self-contained inline Three.js script. Useful for evaluating decomposition quality before opening the editor.

---

## 3. Stage 2: Model Editor (Browser Tool)

### 3.1 Overview

Standalone HTML file at `tools/model-editor.html`. No build step. Imports Three.js from CDN (same r128 as the game). Single file, self-contained.

**Layout:** Three.js viewport (80% width) + sidebar panel (20% width) with controls.

### 3.2 Viewport

- `OrbitControls` for camera (rotate, pan, zoom).
- Grid floor (1cm spacing, extent adapts to model size) for scale reference.
- Axis indicator at origin (RGB = XYZ).
- Primitives rendered with `MeshLambertMaterial({ flatShading: true })` — WYSIWYG with the game.
- Selected primitive highlighted with wireframe overlay.

### 3.3 Sidebar Controls

**File operations:**
- Import recipe JSON (file picker or drag-drop)
- Export recipe JSON (download)
- Import reference model — GLB or OBJ (renders as translucent ghost at opacity 0.15 — for visual comparison, not exported)
- New empty recipe (starts blank for hand-authoring small models)

**Primitive list:**
- Scrollable list of all primitives by `id`
- Click to select (highlights in viewport + shows properties)
- Drag to reorder (cosmetic — render order)
- Delete button per primitive
- "Add Box" / "Add Cylinder" buttons (spawns at origin)

**Selected primitive properties:**
- `id` (text input)
- `group` (editable combo box: dropdown with presets + freeform text entry. Weapon presets: receiver, barrel, stock, magazine, muzzle, underbarrel, optic_rail, grip, trigger_guard, cosmetic. For non-weapons: body, leg, seat, wheel, hood, etc. — any string.)
- `type` (box / cylinder — changing type re-fits the primitive)
- `pos` [x, y, z] (number inputs, drag-adjustable)
- `rot` [rx, ry, rz] (degrees)
- `scale` [sx, sy, sz] (cm)
- `color` (color picker)

**Transform gizmo:**
- `TransformControls` from Three.js examples
- Mode toggle: Translate (W) / Rotate (E) / Scale (R)
- Snapping: hold Shift for 0.5cm translate snap, 5° rotate snap, 0.5cm scale snap

**Attachment points:**
- Editable list of named points (user adds/removes freely)
- Weapon defaults: muzzle, optic_rail, underbarrel, magazine, stock
- Each has: name (string), pos [x,y,z], dir [x,y,z]
- Click to select → shows a small cone gizmo in viewport at the point position, oriented along `dir`
- Draggable via TransformControls
- "Add Point" button creates a new named point at origin

**Viewmodel preview** (weapons only):
- Toggle button: switches camera to a first-person preview position
- Shows the weapon at `viewmodel.pos` / `viewmodel.scale` relative to a camera stand-in
- Lets the user adjust viewmodel offset and see how it looks in-game

**Metadata:**
- `name` (text)
- `category` (dropdown)
- `archetype` (dropdown, visible only when category = weapon)

### 3.4 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| W | Translate mode |
| E | Rotate mode |
| R | Scale mode |
| Delete | Delete selected primitive |
| D | Duplicate selected primitive (offset +2cm X) |
| G | Toggle grid visibility |
| F | Focus camera on selected primitive |
| H | Toggle reference model visibility |
| 1 | Front view (look along -Z) |
| 2 | Side view (look along -X) |
| 3 | Top view (look along -Y) |
| Ctrl+S | Export JSON |
| Ctrl+Z | Undo (keep 50 states) |
| Ctrl+Shift+Z | Redo |

### 3.5 Undo System

Snapshot-based. Each mutation (move, rotate, scale, delete, add, property change) pushes a full copy of the primitives array + attachment points. Cap at 50 states. Simple and robust — the data is small.

### 3.6 Color Palette

The editor preloads the SPRAWL weapon palette as swatches:

| Name | Hex | Use |
|------|-----|-----|
| Receiver | `#3a3a3a` | Main body |
| Metal Dark | `#2a2a2a` | Barrel, bolt, small parts |
| Stock | `#3d3530` | Stock, grip (subtle warm) |
| Accent | `#5a5a5a` | Safety, bolt handle, pins |
| Magazine | `#3a3a3a` | Matches receiver by default |
| Optic Body | `#2e2e2e` | Scope housing |
| Optic Lens | `#1a3a4a` | Lens tint (slightly blue) |

User can pick any color, but the palette provides quick access to canonical colors.

### 3.7 Wedge Support (Optional)

A wedge is a box with one edge collapsed — a triangular prism. Useful for angled stocks, trigger guards, dust covers. If implemented:

- `type: "wedge"`
- `scale` = [width, height, depth] of the enclosing box
- Additional field: `collapse` = `"+x"`, `"-x"`, `"+y"`, `"-y"` — which edge collapses to zero

Low priority. Boxes and cylinders cover 90% of weapon silhouettes.

---

## 4. Game Runtime Loader

In `src/models.js` (new file):

```javascript
function buildModelFromRecipe(recipe) {
  const group = new THREE.Group();
  group.name = recipe.name;

  for (const prim of recipe.primitives) {
    let geometry;
    if (prim.type === 'box') {
      geometry = new THREE.BoxGeometry(
        prim.scale[0], prim.scale[1], prim.scale[2]
      );
    } else if (prim.type === 'cylinder') {
      geometry = new THREE.CylinderGeometry(
        prim.scale[0], prim.scale[0], prim.scale[2], 8
      );
    }

    const material = new THREE.MeshLambertMaterial({
      color: prim.color,
      flatShading: true
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...prim.pos);
    mesh.rotation.set(
      prim.rot[0] * DEG2RAD,
      prim.rot[1] * DEG2RAD,
      prim.rot[2] * DEG2RAD
    );
    mesh.userData.group = prim.group;
    mesh.userData.id = prim.id;
    group.add(mesh);
  }

  // Scale for viewmodel or worldmodel
  return group;
}
```

Cylinder segment count is 8 — enough for a readable low-poly cylinder, matches the game's aesthetic. No need for smooth.

**Attachment application** (weapons): When an attachment is equipped, the runtime:
1. Looks up the attachment point by name.
2. Optionally removes primitives in the target group (e.g., equipping a suppressor may hide the default muzzle geometry).
3. Adds attachment primitives at the attachment point position, oriented along `dir`.

Attachment recipes are separate JSON files with the same primitive format, just smaller (2-5 primitives each). Simple attachments (suppressor = 1 cylinder, vertical grip = 2 boxes) can be hand-authored directly in the editor without running the decomposer.

**Props and furniture:** Same loader, no attachment logic. The recipe is the final model. Place in the world at the desired position and scale.

---

## 5. Workflow Summary

**Complex models (weapons, vehicles, detailed props):**
```
Source model (.glb / .obj)
    ↓
decompose.js (Node CLI) — V-HACD → fit → merge
    ↓
Raw recipe (.json) — primitives with best-guess groups
    ↓
model-editor.html (browser)
    ↓  manual: tag groups, set colors, define attachment points,
    ↓  delete/add/adjust primitives, set viewmodel position
    ↓
Final recipe (.json)
    ↓
buildModelFromRecipe() in game runtime
    ↓
THREE.Group with MeshLambertMaterial flatShading
```

**Simple models (attachments, small props):**
```
model-editor.html (browser)
    ↓  hand-author from scratch: add primitives, position, color, export
    ↓
Recipe (.json)
    ↓
buildModelFromRecipe() in game runtime
```

Source .glb files are never shipped. Only the recipes. The recipes are original authored geometry — arrays of positioned primitives.

---

## 6. Implementation Order

1. **Recipe JSON schema** — define and validate the format.
2. **Runtime loader** — `buildModelFromRecipe()` in the game. Test with a hand-written recipe for one weapon.
3. **Decomposer CLI** — V-HACD oversegment, PCA-OBB/cylinder fit per hull, adjacency merge. Test against 2-3 Sketchfab models.
4. **Editor: viewport + primitive rendering** — load recipe, render with proper materials, orbit camera.
5. **Editor: selection + transform** — click to select, TransformControls, property panel.
6. **Editor: groups + colors** — group combo box, color picker, palette swatches.
7. **Editor: attachment points** — point gizmos, draggable, dir arrows.
8. **Editor: import/export** — JSON file I/O, reference model ghost overlay.
9. **Editor: undo, shortcuts, viewmodel preview.**
10. **Attachment recipe format** — small recipe files for suppressors, grips, optics, etc.

Steps 1-3 produce usable recipes. Steps 4-8 make editing comfortable. Steps 9-10 complete the weapon pipeline.

---

## 7. Performance Notes

- Decomposer runs offline; performance is not critical. V-HACD at 100k resolution + 80 hulls typically runs in 2-10 seconds depending on mesh complexity. The merge pass is fast (greedy O(n²) on ~80 primitives).
- Editor is a lightweight Three.js scene with < 50 meshes. No performance concerns.
- Runtime: `buildModelFromRecipe()` creates 15-40 meshes per model. For weapon viewmodels (1 visible at a time), this is trivial. For world models (dropped weapons, props, furniture), merge the group into a single `BufferGeometry` at load time to reduce draw calls. A building with 10 furniture pieces × 20 primitives each = 200 meshes without merging — merge is mandatory for props.
- Recipe JSON files are < 5KB each (weapons), < 3KB (attachments/small props), < 10KB (vehicles). Full asset set for the game < 500KB total.