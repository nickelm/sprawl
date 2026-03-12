# Weapon Model Tools — sprawl

## Context

This spec defines two tools for producing procedural weapon models for `sprawl`:

1. **Decomposer** — Node.js CLI that takes a glTF/GLB file, voxelizes it, fits a small set of geometric primitives (boxes, cylinders) to approximate the silhouette, and outputs a JSON recipe.
2. **Editor** — Browser-based Three.js tool that loads recipes, lets the user tag part groups, define attachment points, adjust/delete/add primitives, set colors, and export final weapon recipes.

The JSON recipe is the interface between both tools and the game runtime. The game's `buildWeaponFromRecipe(json)` constructs a `THREE.Group` from the recipe at load time — no external model files shipped.

The decomposition is a lossy geometric approximation. The output is original authored geometry (primitive placements), not a derivative of the source mesh topology. Source models are reference-only and are not distributed.

---

## 1. JSON Recipe Format

```json
{
  "name": "MK14",
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
| `archetype` | One of: `pistol`, `revolver`, `smg`, `carbine`, `ar`, `battle_rifle`, `lmg`, `dmr`, `sniper`, `shotgun` |
| `version` | Schema version (integer) |
| `units` | Always `"cm"` — all dimensions in centimeters |
| `origin` | Semantic label for the recipe's local origin. Conventionally the center of the receiver. |
| `primitives[]` | Array of primitive definitions (see §1.2) |
| `attachmentPoints` | Named positions + directions where attachments mount (see §1.3) |
| `viewmodel` | First-person display: scale, offset from camera, rotation |
| `worldmodel` | Third-person / dropped: scale factor relative to viewmodel |

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
  --budget 25 --resolution 128 --archetype dmr
```

| Flag | Default | Description |
|------|---------|-------------|
| `--output` | stdout | Output JSON path |
| `--budget` | 25 | Max number of primitives |
| `--resolution` | 128 | Voxel grid resolution along longest axis |
| `--archetype` | required | Weapon archetype (sets default group colors) |
| `--cylinder-bias` | 0.15 | Cylinder fit must beat box fit by this fraction to be chosen (avoids spurious cylinders) |
| `--min-volume` | 0.5 | Min primitive volume as % of total mesh volume (filters dust) |

### 2.2 Pipeline

```
Load glTF → Normalize → Voxelize → Decompose → Fit Primitives → Filter → Output
```

#### 2.2.1 Load & Normalize

Use a Node glTF parser (e.g. `@gltf-transform/core` or parse the binary manually — the mesh geometry is all we need: vertex positions and triangle indices).

**Normalize the mesh:**
1. Merge all mesh geometries into a single triangle soup.
2. Compute bounding box.
3. Translate so centroid is at origin.
4. Uniform scale so the longest axis spans exactly 50cm (reasonable weapon scale). Record the scale factor for reference but the recipe will be edited to final dimensions in the editor.

The normalization means every weapon starts at the same scale and centering. The editor adjusts final dimensions.

#### 2.2.2 Voxelize

Rasterize the triangle mesh into a 3D binary grid.

**Method:** For each triangle, rasterize it into the voxel grid using a triangle-box intersection test per voxel. Then flood-fill the exterior and invert to get a solid voxelization (surface rasterization alone leaves the interior empty).

Concrete steps:
1. Allocate `Uint8Array` of size `resX * resY * resZ`.
2. For each triangle in the mesh, compute its AABB in voxel coords, then for each voxel in that AABB, run a triangle-box overlap test. Mark hit voxels as `SURFACE`.
3. Flood-fill from a corner voxel (guaranteed exterior if the grid has 1-voxel padding) marking all reachable non-SURFACE voxels as `EXTERIOR`.
4. Everything not `EXTERIOR` and not `SURFACE` is `INTERIOR`.
5. Final solid = `SURFACE ∪ INTERIOR`.

At resolution 128, the grid is at most 128³ = ~2M voxels. Fits in ~2MB. Runs in under a second.

#### 2.2.3 Recursive Primitive Decomposition

This is the core algorithm. Goal: cover the solid voxel volume with N primitives minimizing uncovered volume (undershoot) and excess volume (overshoot).

```
function decompose(voxels, budget, results):
    if budget == 0 or countSolid(voxels) < minVolume:
        return

    // Fit best box
    box = fitOBB(voxels)
    boxScore = score(voxels, box)

    // Fit best cylinder
    cyl = fitCylinder(voxels)
    cylScore = score(voxels, cyl)

    // Pick winner (cylinder must beat box by bias margin)
    if cylScore > boxScore * (1 + cylinderBias):
        best = cyl
    else:
        best = box

    results.push(best)

    // Subtract best primitive's voxels from the volume
    remaining = subtract(voxels, best)

    // Find connected components in remaining
    components = connectedComponents(remaining)

    // Sort components by volume, descending
    components.sort(byVolume, descending)

    // Distribute remaining budget across components proportional to volume
    for comp in components:
        share = max(1, round(budget_remaining * comp.volume / total_remaining))
        decompose(comp, share, results)
```

**Score function:**

```
score(voxels, primitive) = coveredVoxels / (totalSolidVoxels + overshootVoxels * overshootPenalty)
```

Where:
- `coveredVoxels` = solid voxels inside the primitive
- `overshootVoxels` = non-solid voxels inside the primitive (primitive extends beyond mesh)
- `overshootPenalty` = 0.5 (overshoot is bad but undershoot is worse — we'd rather be slightly bigger than leave gaps)

#### 2.2.4 OBB Fitting (Oriented Bounding Box)

For a set of solid voxel positions:

1. Compute the 3×3 covariance matrix of voxel center positions.
2. Eigendecomposition → 3 eigenvectors = principal axes, 3 eigenvalues = variance along each axis.
3. Project all voxel centers onto the eigenvector axes.
4. Per axis: min and max projection = box extents along that axis.
5. Result: center position, 3 axis vectors, 3 half-extents.

Convert to recipe format: `pos` = center, `rot` = Euler angles from the eigenvector rotation matrix, `scale` = full extents (2 × half-extents).

PCA-OBB is not the tightest possible OBB, but it's fast (O(n) in voxel count) and gives good results for near-prismatic shapes. Weapons are mostly near-prismatic.

#### 2.2.5 Cylinder Fitting

1. Use PCA as above. The eigenvector with the largest eigenvalue is the cylinder axis candidate (longest dimension).
2. Project all voxel centers onto the plane perpendicular to this axis.
3. Compute the bounding circle of the 2D projection: center + radius. (Use the average distance to centroid as radius — more robust than max distance for noisy voxels.)
4. Cylinder height = extent along the axis.
5. Result: center position, axis direction, radius, height.

A cylinder fits better than a box when the cross-section is roughly circular — barrels, scopes, grips. The `cylinderBias` threshold prevents marginal cases from becoming cylinders (a slightly rounded box should stay a box for the low-poly look).

#### 2.2.6 Filtering

After decomposition:
1. Remove primitives smaller than `minVolume` percent of total mesh volume. These are noise from thin features.
2. Merge primitives that overlap > 80% and have similar orientation (< 10° rotation difference). Replace with the larger one.
3. Sort by group assignment (see §2.3).

#### 2.2.7 Auto-Group Assignment

The decomposer makes a best-effort group assignment based on position along the Z axis (barrel direction, longest axis after normalization):

| Z range (normalized) | Group |
|-----------------------|-------|
| > 60% forward | `barrel` |
| 20–60% forward | `receiver` |
vele| 0–20% (center area), below midline Y | `magazine` or `grip` |
| < 0% (rear) | `stock` |
| Small primitives on top of receiver | `optic_rail` |
| Small primitives below forend | `underbarrel` |

This is heuristic and approximate. The editor is where the user corrects group assignments.

### 2.3 Dependencies

Minimal Node dependencies:
- glTF parsing: `@gltf-transform/core` + `@gltf-transform/extensions` (reads GLB/glTF, extracts mesh data)
- Linear algebra: write the PCA/eigen inline (3×3 symmetric matrix eigendecomposition is ~60 lines) or use a small lib like `ml-matrix`
- No Three.js dependency in the CLI tool

### 2.4 Output

The decomposer writes a JSON recipe per §1. Group assignments are best-effort. Colors are defaults from archetype palette. Attachment points are not set (editor responsibility). The `viewmodel` and `worldmodel` fields get sensible defaults.

---

## 3. Stage 2: Weapon Editor (Browser Tool)

### 3.1 Overview

Standalone HTML file at `tools/weapon-editor.html`. No build step. Imports Three.js from CDN (same r128 as the game). Single file, self-contained.

**Layout:** Three.js viewport (80% width) + sidebar panel (20% width) with controls.

### 3.2 Viewport

- `OrbitControls` for camera (rotate, pan, zoom).
- Grid floor (1cm spacing, 50cm extent) for scale reference.
- Axis indicator at origin (RGB = XYZ).
- Weapon primitives rendered with `MeshLambertMaterial({ flatShading: true })` — WYSIWYG with the game.
- Selected primitive highlighted with wireframe overlay.

### 3.3 Sidebar Controls

**File operations:**
- Import recipe JSON (file picker or drag-drop)
- Export recipe JSON (download)
- Import reference glTF (renders as translucent ghost at opacity 0.15 — for visual comparison, not exported)

**Primitive list:**
- Scrollable list of all primitives by `id`
- Click to select (highlights in viewport + shows properties)
- Drag to reorder (cosmetic — render order)
- Delete button per primitive
- "Add Box" / "Add Cylinder" buttons (spawns at origin)

**Selected primitive properties:**
- `id` (text input)
- `group` (dropdown: receiver, barrel, stock, magazine, muzzle, underbarrel, optic_rail, grip, trigger_guard, cosmetic)
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
- List of named points (muzzle, optic_rail, underbarrel, magazine, stock)
- Each has pos [x,y,z] and dir [x,y,z]
- Click to select → shows a small cone gizmo in viewport at the point position, oriented along `dir`
- Draggable via TransformControls

**Viewmodel preview:**
- Toggle button: switches camera to a first-person preview position
- Shows the weapon at `viewmodel.pos` / `viewmodel.scale` relative to a camera stand-in
- Lets the user adjust viewmodel offset and see how it looks in-game

**Metadata:**
- `name` (text)
- `archetype` (dropdown)

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

In `src/weapons.js` (or a new `src/weapon-models.js`):

```javascript
function buildWeaponFromRecipe(recipe) {
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

**Attachment application:** When an attachment is equipped, the runtime:
1. Looks up the attachment point by name.
2. Optionally removes primitives in the target group (e.g., equipping a suppressor may hide the default muzzle geometry).
3. Adds attachment primitives at the attachment point position, oriented along `dir`.

Attachment recipes are separate JSON files with the same primitive format, just smaller (2-5 primitives each).

---

## 5. Workflow Summary

```
Sketchfab model (.glb)
    ↓
decompose.js (Node CLI)
    ↓
Raw recipe (.json) — primitives with best-guess groups
    ↓
weapon-editor.html (browser)
    ↓  manual: tag groups, set colors, define attachment points,
    ↓  delete/add/adjust primitives, set viewmodel position
    ↓
Final recipe (.json)
    ↓
buildWeaponFromRecipe() in game runtime
    ↓
THREE.Group with MeshLambertMaterial flatShading
```

Source .glb files are never shipped. Only the recipes. The recipes are original authored geometry — arrays of positioned primitives.

---

## 6. Implementation Order

1. **Recipe JSON schema** — define and validate the format.
2. **Runtime loader** — `buildWeaponFromRecipe()` in the game. Test with a hand-written recipe for one weapon.
3. **Decomposer CLI** — voxelizer, PCA-OBB, cylinder fit, recursive decomposition. Test against 2-3 Sketchfab models.
4. **Editor: viewport + primitive rendering** — load recipe, render with proper materials, orbit camera.
5. **Editor: selection + transform** — click to select, TransformControls, property panel.
6. **Editor: groups + colors** — group dropdown, color picker, palette swatches.
7. **Editor: attachment points** — point gizmos, draggable, dir arrows.
8. **Editor: import/export** — JSON file I/O, reference model ghost overlay.
9. **Editor: undo, shortcuts, viewmodel preview.**
10. **Attachment recipe format** — small recipe files for suppressors, grips, optics, etc.

Steps 1-3 produce usable weapon recipes. Steps 4-8 make editing comfortable. Step 9-10 complete the pipeline.

---

## 7. Performance Notes

- Decomposer runs offline; performance is not critical. A 128³ voxel grid with 25-primitive budget should finish in < 2 seconds.
- Editor is a lightweight Three.js scene with < 50 meshes. No performance concerns.
- Runtime: `buildWeaponFromRecipe()` creates 15-30 meshes per weapon. For the viewmodel (1 weapon visible), this is trivial. For world models (dropped weapons), consider merging the group into a single BufferGeometry at load time to reduce draw calls.
- Weapon recipe JSON files are < 5KB each. All 10 archetypes + 20 attachments < 100KB total.