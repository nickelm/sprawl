# Destruction Addendum — Structural Classes, Floor/Ceiling Damage, Tiered Debris

## Status

This document **supplements** `destruction-spec.md`. It does not replace it. All rules in the base spec remain in effect unless explicitly overridden here.

**What already works** (implemented):
- Wall panels can be shot out via the ballistics pipeline
- Panel HP, damage visualization, and vertex zeroing on destruction
- Basic debris spawning on panel break
- Merged BufferGeometry per wall with faceIndex → panelID lookup

**What this addendum adds:**
1. Structural class system (§1) — differentiates light-frame from heavy-frame buildings
2. Floor/ceiling panel ballistics (§2) — horizontal panels participate in the damage pipeline
3. Floor support and collapse (§3) — structural rules for horizontal panels
4. Panel gravity cascade (§4) — unsupported panels fall as physics objects
5. Three-tier debris system (§5) — replaces the single debris tier from the base spec
6. Rubble accumulation rework (§6) — heightfield-based rubble layer

---

## 1. Structural Classes

The base spec treats all buildings identically: every panel is both structure and skin. This addendum introduces a per-archetype **structural class** that determines how load is carried and what it takes to collapse a building.

### 1.1 Two Classes

**Light-frame:** Panels are the structure. The existing BFS support rules (base spec §6) apply unchanged. Destroying enough ground-floor panels causes upper floors to lose support and collapse. Small arms fire can level the building over the course of a firefight.

Archetypes: `dwelling`, `strip_mall`.

**Heavy-frame:** The building has an implicit structural grid of **column cells** at regular intervals. Column cells are panels with a `structural: true` flag and elevated HP. Wall panels between columns are **infill** — destroying them opens holes but does not compromise the frame. The building collapses only when enough columns on a single floor are destroyed.

Archetypes: `apartment`, `office`, `warehouse`.

### 1.2 Column Placement Rules

At building generation time, mark certain panel cells as `structural: true`:

- **Corners:** Every building corner gets a column. The column occupies the full height of the wall at that position (all gridY values for that gridX).
- **Exterior interval:** Along exterior walls, one column every 4m (i.e., every 4th gridX position). If the wall is shorter than 8m, corners suffice.
- **Interior wall intersections:** Where two interior walls meet, the intersection cell is a column.
- **Stairwell edges:** Cells adjacent to stairwell voids on all floors.

Column panels use the same panel type as the wall they belong to, but with modified stats:

| Base Type | Column HP | Column Penetration Cost |
|-----------|-----------|------------------------|
| Concrete  | 20        | 2.0                    |
| Brick     | 12        | 1.6                    |
| Metal     | 16        | 1.8                    |
| Wood      | 8         | 1.0                    |

Column panels are visually identical to neighboring panels at full HP. As they take damage, they darken like any panel. They do not get a special appearance — the player discovers columns by noticing that some sections of wall take more punishment. This rewards tactical awareness.

### 1.3 Heavy-Frame Collapse Rules

Replace base spec §6.1–§6.2 for heavy-frame buildings with:

**Column support chain:** A column cell on floor `f` is **rooted** if:
- `f == 0` (ground floor), OR
- The column cell directly below it on floor `f-1` is intact and rooted.

**Infill support:** An infill (non-structural) panel is supported if it can trace a path through intact neighbors (left, right, below within the same wall) to a column cell that is rooted. This is the same BFS as the base spec, but the "root" set is column cells rather than all ground-floor panels.

**Floor section collapse:** Divide each floor into **bays** — rectangular regions bounded by columns. A bay's floor panels are supported if at least 3 of its 4 corner columns are intact and rooted. If fewer than 3 corner columns remain, the bay collapses:
- All floor/ceiling panels in that bay are destroyed.
- All wall infill panels in that bay's stories lose support (BFS from columns no longer reaches them).
- Anything above the bay (upper bays in the same column grid) cascades if their support columns were on the collapsed floor.

**Result:** Small arms strip a heavy-frame building to a skeleton — you see through the floors, infill is gone, but the columns and the floor slabs they support remain. RPG fire or sustained heavy MG fire on columns causes sectional collapse. Partial buildings stand.

### 1.4 Data Changes

Add to each panel's data:
```javascript
{
  structural: Boolean,  // true for column cells in heavy-frame buildings
  // ... existing fields unchanged
}
```

Add to `BuildingDef`:
```javascript
{
  structuralClass: 'light' | 'heavy',
  columns: [{gridX, wallId}],  // column positions for heavy-frame
  bays: [{x0, z0, x1, z1}],   // rectangular bays bounded by columns, per floor
  // ... existing fields unchanged
}
```

### 1.5 Implementation Notes

- Column marking happens in `buildings.js` during `generateBuilding()`, after wall panels are placed but before mesh merging.
- The BFS in `destruction.js` needs a one-line change: the "is rooted?" check tests `panel.structural && isGroundFloor` for heavy-frame buildings instead of `isGroundFloor` for all panels.
- Bay collapse is a new function triggered when a column is destroyed. It iterates bays that referenced that column, checks the 3-of-4 rule, and bulk-destroys panels in failed bays.
- Column placement adds zero new geometry. It is metadata only.

---

## 2. Floor/Ceiling Panel Ballistics

The base spec's ballistics pipeline (§1, §5.1) currently handles wall panels. Floor and ceiling panels must participate identically.

### 2.1 Registering Horizontal Panels

Floor and ceiling meshes are already merged `BufferGeometry` (base spec §7.3). They need the same infrastructure as wall meshes:

- **Panel data registration:** Each floor/ceiling panel cell gets a `panelId` entry with type, HP, grid position, vertexStart, vertexCount. Register with `destruction.js` the same way wall panels are.
- **faceIndex → panelID lookup:** Build the same reverse map for floor/ceiling meshes. `faceIndex / 12` → panel index within that floor slab.
- **Raycaster inclusion:** Floor/ceiling meshes must be in the set of objects passed to `THREE.Raycaster.intersectObjects()`. They likely already are if they're children of the building group, but verify.

### 2.2 Hit Resolution

When a bullet hits a floor or ceiling panel, the same logic as base spec §5.1 applies:
1. Look up panel from faceIndex.
2. Subtract damage.
3. Spawn impact debris + dust.
4. If destroyed: zero vertices, structural check (§3), break debris, nav update.
5. Deduct penetration cost, continue ray if budget remains.

Shooting through a floor or ceiling consumes penetration budget based on the panel's material, same as walls. A sniper round (budget 1.5) can punch through a wood floor (cost 0.5) and hit someone on the floor below.

### 2.3 Floor Panel Types

Floor and ceiling panels use the same type table as walls. Default assignments per archetype:

| Archetype   | Floor Type | Ceiling Type |
|-------------|-----------|-------------|
| Dwelling    | Wood      | Wood        |
| Strip Mall  | Concrete  | Concrete    |
| Apartment   | Concrete  | Concrete    |
| Office      | Concrete  | Concrete    |
| Warehouse   | Concrete  | Metal       |

These are the defaults. The building generator may override per-room (e.g., bathroom floors might be concrete in a dwelling).

---

## 3. Floor Panel Support and Collapse

This section **replaces** the vague rules in base spec §6.3 with precise mechanics.

### 3.1 Floor Panel Support (Light-Frame)

A floor panel at cell `(x, z)` on floor `f` is supported if ANY of:
- A wall panel exists at the edge of cell `(x, z)` on floor `f` at gridY 0 (i.e., a wall sits on or adjacent to this floor cell's edge), AND that wall panel is itself supported.
- An adjacent floor panel (±1 in x or z) is supported AND the distance to the nearest supported edge (wall or column) is ≤ `maxSpan`.

**maxSpan** for light-frame: 3 cells. A wood floor can cantilever 3m from its last wall support before it falls. This means destroying a 3m section of wall causes the floor above to sag and drop along that section.

### 3.2 Floor Panel Support (Heavy-Frame)

Floor panels in heavy-frame buildings are supported by bays (§1.3). A floor panel is supported if the bay it belongs to has ≥ 3 of 4 corner columns intact. Individual floor panel destruction (shooting holes) does not cascade to neighbors — the panel is just gone, leaving a hole. Bay-level collapse handles the large-scale events.

**maxSpan** for heavy-frame: 6 cells. Concrete floors span further between supports.

### 3.3 Floor Collapse Cascade

When a floor panel loses support:
1. Zero its vertices in the floor mesh buffer.
2. Spawn it as a falling chunk (§4).
3. Check panels directly above on the next floor — if they were supported only through this floor (stairwell-adjacent situations), re-evaluate their support.
4. Anything standing on the destroyed floor panel (enemies, player, props) begins to fall.

### 3.4 Threshold Collapse

If >50% of a floor's panels within a single bay (heavy-frame) or a single room (light-frame) are destroyed, collapse the remainder of that section. This prevents weird floating panel islands.

---

## 4. Panel Gravity Cascade

This section **implements** the falling behavior described in base spec §6.2 step 5 and §8.3, which is not yet in the code.

### 4.1 Trigger

Any panel (wall, floor, or ceiling) that the BFS marks as unsupported becomes a **falling panel**.

### 4.2 Falling Panel Lifecycle

1. **Detach:** Zero the panel's vertices in its parent mesh buffer. Record the panel's world-space position, type, and color.
2. **Spawn debris:** Immediately break the panel into 2–4 extruded-triangle chunks (base spec §8.1). Each chunk gets:
   - Position: panel's world position ± random offset within 0.5m
   - Velocity: slight outward drift (0.5–2 m/s horizontal, -1 m/s initial vertical)
   - Angular velocity: random axis, 1–4 rad/s
   - Gravity: -9.8 m/s²
3. **Fall:** Chunks simulate per frame (position += velocity * dt, velocity.y += gravity * dt, apply angular velocity).
4. **Ground contact:** When a chunk's Y position ≤ terrain height (or floor height of story below):
   - Spawn secondary shatter: 2–3 smaller tier-2 chips (§5.2) + 10–20 tier-1 dust particles (§5.1).
   - Play impact sound (dull thud, pitch varies with chunk size).
   - Mark chunk as settled.
5. **Damage on impact:** Anything under a falling chunk when it contacts ground takes damage: `damage = 15 * chunkCount` (a full panel's 3 chunks ≈ 45 damage). Apply to player, enemies, and panels below.

### 4.3 Cascade Timing

Process unsupported panels **top-to-bottom** within each wall/floor. Insert a 50–100ms stagger between each row of panels falling. This creates a visible cascading collapse instead of everything vanishing simultaneously.

Implementation: queue unsupported panels sorted by gridY (highest first for walls) or by floor (highest first for floors). Process one row per frame at 60fps, or use a timer if frame-independent timing is needed.

### 4.4 Collapse Dust Cloud

When ≥5 panels fall within a 1-second window (a significant collapse event):
- Spawn a **dust cloud**: 50–100 tier-1 particles (§5.1) with high initial outward velocity (3–8 m/s), slow fade (2–4 seconds), large size (0.3–0.8m).
- The cloud should billow outward from the collapse center, creating a brief visibility obstruction.
- Camera shake if player is within 15m. Intensity proportional to number of panels collapsed.

---

## 5. Three-Tier Debris System

This section **replaces** the single-tier debris system in base spec §8. The goal: Tarantino-scale environmental scarring. Every firefight leaves the area looking like a warzone.

### 5.1 Tier 1: Particle Dust (Cheapest, Most Numerous)

Dust clouds, plaster haze, smoke wisps. Not individual meshes — instanced billboards.

**Implementation:** Single `THREE.InstancedMesh` with a small `PlaneGeometry` (0.1–0.5m, varies per instance). `MeshBasicMaterial({ transparent: true, depthWrite: false, color: tinted per source })`. Each instance has position, scale, opacity, velocity stored in parallel typed arrays.

**Spawn triggers:**
| Event | Count | Size Range | Lifetime | Color |
|-------|-------|-----------|----------|-------|
| Bullet impact (any surface) | 5–15 | 0.05–0.15m | 0.3–0.8s | Surface material color, lightened 30% |
| Panel destruction | 20–40 | 0.1–0.3m | 0.5–1.5s | Material color |
| Floor/wall collapse (per panel) | 10–20 | 0.2–0.5m | 1.0–3.0s | Material color, gray bias |
| Collapse event (≥5 panels) | 50–100 | 0.3–0.8m | 2.0–4.0s | Gray (#888) |
| Debris ground impact | 5–10 | 0.05–0.2m | 0.3–0.6s | Surface color |

**Physics:** Each particle has velocity (initial outward burst + random), gravity at -2 m/s² (slow fall — dust hangs in air), and linear opacity fade to 0. No collision.

**Budget:** 2000 active instances max. Pool: overwrite oldest when full. One draw call for the entire tier.

**Update cost:** One loop over active particles per frame, updating instance matrix + custom attribute for opacity. Batch upload to GPU once.

### 5.2 Tier 2: Chips and Shards (Medium)

Small fragments that scatter on the ground. The visual evidence of a fight — shell casings, plaster bits, wood splinters, glass shards littering the floor.

**Implementation:** Single `THREE.InstancedMesh` per material type (up to 6 instanced meshes total — concrete, brick, wood, glass, metal, generic). Geometry: small extruded triangle (base spec §8.1 but scaled down — 5–15cm across, 2–5cm extrusion).

**Spawn triggers:**
| Event | Count | Size Range |
|-------|-------|-----------|
| Bullet impact (non-destroying) | 2–4 | 3–8cm |
| Panel destruction | 8–15 | 5–15cm |
| Falling chunk ground impact | 3–6 | 5–10cm |

**Physics:** Initial velocity: outward burst (2–5 m/s) + upward (1–3 m/s). Gravity at -9.8 m/s². One bounce (velocity *= -0.3 on ground contact), then settle. Angular velocity for tumbling while airborne.

**Settled behavior:** Once settled, chips become static. Position is final. They persist for 60 seconds, then fade (opacity 1→0 over 2 seconds) and recycle.

**Budget:** 1000 active instances per material type (6000 total across all types). Six draw calls total. Pool: overwrite oldest settled when full.

### 5.3 Tier 3: Chunks (Heaviest, Structural)

The big pieces. Falling panel fragments, collapse debris. These have collision, deal damage, and form rubble.

**Implementation:** Individual `THREE.Mesh` objects (not instanced — they need per-object raycasting for damage-on-impact). Geometry: extruded triangle per base spec §8.1, full size (15–40cm across, 3–10cm extrusion).

**Spawn triggers:**
| Event | Count per panel |
|-------|----------------|
| Panel destruction (shooting) | 4–8 |
| Panel destruction (collapse/falling) | 2–4 |

**Physics:** Full ballistic simulation per base spec §8.2. Gravity, velocity, angular velocity. Ground contact: settle, spawn tier-1 dust + tier-2 chips on impact.

**Damage on contact:** Moving chunks that hit player or enemies deal `mass * speed * 0.5` damage (base spec §3.3).

**Settled behavior:** Settled chunks persist 30 seconds, then are absorbed into the rubble heightfield (§6). On absorption: remove mesh, increment rubble height at that grid cell.

**Budget:** 300 active chunk meshes. Pool: recycle oldest settled.

### 5.4 Performance Summary

| Tier | Max Active | Draw Calls | Per-Frame Cost |
|------|-----------|------------|----------------|
| Dust (instanced) | 2000 | 1 | ~0.3ms (array update + upload) |
| Chips (instanced × 6) | 6000 | 6 | ~0.5ms (array updates + uploads) |
| Chunks (individual) | 300 | 300 | ~0.8ms (transform + collision) |
| **Total** | **8300** | **307** | **~1.6ms** |

The chunk draw call count is high. Mitigation: chunks beyond 30m from camera skip rendering (`.visible = false`). Typical visible count: 50–100.

---

## 6. Rubble Accumulation (Reworked)

This section **replaces** base spec §8.5.

### 6.1 Rubble Heightfield

Maintain a 2D grid at 0.5m resolution covering each building's footprint (plus 2m margin for scattered debris). Each cell stores:

```javascript
{
  height: Number,       // rubble height above terrain/floor, in meters
  color: {r, g, b},     // weighted average of debris that contributed
  materialType: String   // dominant material for penetration cost
}
```

### 6.2 Accumulation

When a tier-3 chunk settles or a tier-2 chip settles:
- Find the rubble grid cell at the settle position.
- Increment `height` by the chunk's volume contribution (chunk: +0.05m, chip: +0.005m).
- Blend color toward the new debris color.
- Cap height at 1.5m per cell (rubble piles don't grow to the sky).

### 6.3 Rubble Mesh

Per building, one `THREE.Mesh` for the rubble layer. Geometry: a subdivided plane matching the rubble grid resolution. Vertex Y positions driven by the heightfield. Vertex colors driven by the color field. Recalculate every 2 seconds (not every frame).

Material: `MeshLambertMaterial({ flatShading: true, vertexColors: true })`.

The rubble mesh sits at ground level. Where height > 0, vertices rise, creating an uneven bumpy surface of accumulated debris. Where height == 0, vertices stay at ground level (invisible — the floor panel or terrain shows through).

### 6.4 Rubble Interaction

- **Collision:** Player collision treats rubble height as added terrain height. Walking on rubble = walking on uneven ground. Movement speed reduced by 40% when on rubble cells with height > 0.1m.
- **Nav grid:** Rubble cells with height > 0.3m register as elevated-cost terrain. AI avoids rubble but can traverse it.
- **Cover:** Rubble cells with height > 0.5m provide crouch cover (AI treats as low cover). Height > 1.0m provides standing cover.
- **Ballistics:** Bullets hitting rubble mesh use the cell's `materialType` for penetration cost.
- **Audio:** Footsteps on rubble play a crunch sound (gritty noise burst, 50ms, frequency 200–600Hz).

### 6.5 Dust on Traversal

When the player or an enemy moves through rubble cells with height > 0.1m, spawn 1–3 tier-1 dust particles per step at foot position. The aftermath of a firefight isn't just visual — moving through the wreckage kicks up dust.

---

## 7. Implementation Order

This addendum has dependencies on existing systems. Implement in this order:

### Session A: Structural Classes + Column Marking
**Files:** `src/buildings.js`
**Task:** Add `structuralClass` and `structural` flag to building/panel data. Mark column cells during generation. No behavior change yet — just metadata.
**Test:** Log column positions. Verify columns appear at corners, intervals, and intersections for heavy-frame archetypes.

### Session B: Floor/Ceiling Ballistics
**Files:** `src/destruction.js`, `src/buildings.js`
**Task:** Register floor/ceiling panels with the destruction system (panelId, faceIndex lookup). Ensure raycaster hits floor/ceiling meshes. Wire hit resolution to the existing damage pipeline.
**Test:** Shoot the floor. Shoot the ceiling. Panels take damage and break. Verify penetration continues through the floor.

### Session C: Tiered Debris — Tier 1 (Dust)
**Files:** `src/destruction.js` (or new `src/debris.js`)
**Task:** Implement the instanced particle dust system. Hook into bullet impact and panel destruction events. Pool management.
**Test:** Shoot a wall. Observe dust puff at impact. Destroy a panel. Observe dust cloud. Verify 60fps with sustained fire.

### Session D: Tiered Debris — Tier 2 (Chips) + Tier 3 (Chunks Rework)
**Files:** `src/debris.js`
**Task:** Implement instanced chips. Rework existing chunk debris to match tier-3 spec (if the current system differs). Bounce physics for chips. Settle + persist behavior.
**Test:** Destroy several panels. Floor should accumulate visible chip debris. Chunks should fall, bounce, settle.

### Session E: Structural Integrity — Panel Gravity Cascade
**Files:** `src/destruction.js`
**Task:** Implement the BFS support check for wall panels (may partially exist). Add cascade timing (top-to-bottom stagger). Falling panels spawn tier-3 chunks. Collapse dust cloud.
**Test:** Shoot out a column of ground-floor panels on a light-frame house. Upper panels should cascade downward with visible delay. Dust cloud on collapse.

### Session F: Floor Support + Bay Collapse
**Files:** `src/destruction.js`, `src/buildings.js`
**Task:** Implement floor panel support rules (§3). Bay collapse for heavy-frame buildings. Threshold collapse for rooms.
**Test (light-frame):** Destroy a section of ground-floor wall. Floor above should sag and drop along that section. Things on the floor fall.
**Test (heavy-frame):** Strip infill from an office building with sustained fire — skeleton remains. Destroy a column with RPG — bay collapses, cascade above.

### Session G: Rubble Heightfield
**Files:** `src/debris.js`, `src/collision.js`, `src/nav.js`
**Task:** Implement rubble grid, accumulation from settled debris, rubble mesh, collision integration, nav cost update, dust-on-traversal.
**Test:** After a firefight, the area should have visible rubble accumulation. Player movement slows on rubble. AI avoids heavy rubble. Footstep audio changes.

---

## 8. Design Notes

**Why not render columns differently?** Because discovering structural elements through gameplay is more interesting than reading them visually. The player learns that certain wall sections absorb more punishment. The sniper learns to target the columns. The RPG soldier targets the base of the building where columns are load-bearing. This is emergent tactical depth.

**Why a heightfield for rubble instead of convex hull merging?** The convex hull approach from the base spec is expensive (computing hulls), complex (registering new collision geometry), and produces lumpy results. A heightfield is a single subdivided plane with vertex displacements — one mesh, trivial collision (just a height lookup), and it naturally produces the "layer of rubble on the floor" look. It also handles the case where rubble accumulates across a wide area evenly, which convex hulls do poorly.

**Why 3 tiers instead of 1?** The current debris pool of 500 individual meshes means 500 draw calls for debris alone. The tiered system moves 8000 of the 8300 particles into instanced meshes (7 draw calls). The remaining 300 individual meshes are only the largest, most important chunks. Net result: more debris, fewer draw calls, better performance.

**The Tarantino test:** After a 60-second firefight against 10 enemies at a residential house: the front wall should be mostly gone. The floor inside should be littered with brick chips and plaster dust. A haze should hang in the air for a few seconds after the last shot. The rubble heightfield should show visible mounding where the wall fell. Glass from the windows should glitter on the ground (glass chips catch the directional light). Walking through the rubble should crunch. This is the target.