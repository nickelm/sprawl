# Procedural Building Generation — sprawl

## Context

This spec defines the procedural building generation system for `sprawl`. Every surface is a 1×1×0.1m destructible panel (see `destruction-spec.md`). Buildings are panel-grid shells: thin-walled enclosures on a discrete 3D grid. The generator produces floorplans, converts them to panel grids, and instantiates Three.js geometry.

Read `CLAUDE.md` and `docs/design.md` before starting. Obey all hard rules (no textures, no build tools, `MeshLambertMaterial` with `flatShading: true`).

Implement primarily in `src/buildings.js`. Update `src/world.js` (building placement), `src/nav.js` (footprint registration), and `src/biomes.js` (archetype selection).

---

## 1. Core Abstraction: Buildings as Stacked Floorplans

A building is a vertical stack of 2D floorplans plus vertical connectors and a roof.

### 1.1 Coordinate System

- Each cell is 1×1m in the XZ plane
- Floor-to-floor height: 3m (2.8m clear + 0.2m floor/ceiling slab)
- Panel thickness: 0.1m
- Origin: building's southwest ground-level corner at `(worldX, terrainY, worldZ)`

### 1.2 Data Structures

```javascript
// 2D floorplan for a single story
FloorPlan {
  width: int,              // cells in x
  depth: int,              // cells in z
  cells: uint8[w][d],      // 0=exterior, 1=interior, 2=corridor, 3=stairwell
  walls: {
    h: bool[w][d+1],       // horizontal walls along x-axis (between z and z+1)
    v: bool[w+1][d]        // vertical walls along z-axis (between x and x+1)
  },
  wallMaterials: {
    h: uint8[w][d+1],      // material type per wall segment (see §4 panel types)
    v: uint8[w+1][d]
  },
  doors: Set<{x, z, axis}>,      // wall openings (no panel placed)
  windows: Set<{x, z, axis}>,    // exterior walls using glass panels
  stairs: [{x, z, dir}],         // stairwell cells + climb direction
  ladders: [{x, z, face}],       // ladder positions on walls
  props: [{x, z, type, rotation}] // interior furniture/props
}

// Complete building definition
BuildingDef {
  archetype: string,         // 'warehouse' | 'dwelling' | 'apartment' | 'office' | 'strip_mall'
  style: StylePalette,       // material colors + window density
  floors: FloorPlan[],       // one per story, index 0 = ground floor
  heightPerFloor: number,    // default 3.0
  roofStyle: 'flat' | 'peaked',
  footprintW: int,
  footprintD: int
}

// Style controls materials, not layout
StylePalette {
  wallMaterial: string,      // default panel type for walls
  wallColor: hex,            // base color
  accentColor: hex,          // trim, frames
  windowDensity: float,      // 0.0–1.0, fraction of eligible exterior walls that become windows
  interiorWallMaterial: string,
  floorColor: hex,
  roofColor: hex
}
```

---

## 2. Generation Pipeline

Six sequential stages. Each is a pure function taking the output of the previous stage plus an RNG seed.

```
Footprint → Rooms → Doors → Windows → Stairs → Props → Panel Instantiation
```

### 2.1 `generateFootprint(archetype, rng) → 2D bool grid`

Produces the building outline. Shape depends on archetype.

**Rectangle:** Most buildings. Random width/depth within archetype range.

**L-shape:** Start with rectangle, subtract a rectangular corner. Used for dwellings, some apartments.

**T-shape:** Rectangle with a perpendicular extension. Used for some office buildings.

**U-shape:** Rectangle with a rectangular courtyard cut from one side. Used for apartments.

Footprint is a 2D boolean grid: `true` = interior cell, `false` = exterior.

### 2.2 `partitionRooms(footprint, archetype, rng) → walls + room tags`

Subdivide interior space into rooms using **recursive BSP**:

1. Pick the longer axis of the current region
2. Choose a split position (random within constraints per archetype)
3. Place a wall along the split
4. Recurse on both halves
5. Stop when a region is smaller than the minimum room size for the archetype

**Split constraints per archetype:**

| Archetype | Min Room | Max Room | Notes |
|-----------|----------|----------|-------|
| Warehouse | 8×8 | — | 1–2 splits max (mostly open) |
| Dwelling | 2×2 | 5×6 | 3–6 rooms per floor |
| Apartment | 2×2 | 4×5 | Units along central corridor |
| Office | 3×3 | 6×8 | Open plan or grid of offices |
| Strip Mall | 4×3 | — | Front/back split only |

**Corridor generation (apartment, office):** Before BSP, carve a corridor strip (1–2 cells wide) along the long axis. Mark cells as type `2`. Then BSP each side of the corridor independently.

**Room tagging:** After BSP, tag each room based on archetype + floor + size. Tags drive prop placement (§2.6).

### 2.3 `placeDoors(floorplan, rng) → door openings`

**Connectivity guarantee:** Every room must be reachable from every other room on the same floor.

Algorithm:
1. Build room adjacency graph (rooms sharing a wall segment)
2. Compute minimum spanning tree of adjacency graph
3. Place one door on each MST edge (random position along shared wall)
4. With 30% probability, add one extra door per non-MST edge (creates loops, good for gameplay)
5. Place exterior doors: at least one on ground floor, one per stairwell on upper floors

Doors are 1-cell-wide openings (no panel placed). Door frames are cosmetic geometry (thin boxes around the opening, same material as wall, not destructible separately).

### 2.4 `placeWindows(floorplan, archetype, style) → window markings`

Iterate all exterior wall segments. For each eligible segment (not a door, not ground-level on some archetypes):

- Roll against `style.windowDensity`
- If placed: mark as window (glass panel instead of wall panel)

**Window placement rules per archetype:**

| Archetype | Pattern |
|-----------|---------|
| Warehouse | High windows only (y ≥ 2 on tall walls), sparse |
| Dwelling | Regular spacing, skip bathrooms, cluster on front face |
| Apartment | Regular grid, every unit gets 1–2 windows |
| Office | Most exterior walls are windows (density 0.7–0.9) |
| Strip Mall | Front wall mostly glass, sides/back minimal |

### 2.5 `placeStairs(building, rng) → stairwell positions`

Stairwells span all floors. Position chosen once, consistent across all floorplans.

**Stair geometry:** 2×1 cell footprint. Stepped ramp: 8–10 step meshes per flight (each step is a box, ~0.3m rise, ~0.5m run). Steps are individual meshes grouped under the building — destructible as props (see §6).

**Stair placement rules:**
1. Find a 2×1 region in the ground floor floorplan adjacent to a corridor or large room
2. Mark those cells as type `3` (stairwell) on all floors
3. Remove floor panels above stairwell cells to create the vertical shaft
4. Place stair geometry connecting each floor

**Ladders:** 1-cell footprint, placed on a wall face. Simpler than stairs — just a thin box geometry for rungs. Used for roof access and external fire escapes. Player interaction: walk into ladder → vertical movement at reduced speed.

### 2.6 `placeProps(floorplan, roomTags, rng) → prop list`

Each room tag has a prop table. Props are placed after room subdivision.

**Room types and prop tables:**

| Room Tag | Props |
|----------|-------|
| `living_room` | Couch (2×1), table (1×1), shelf (2×1 against wall) |
| `kitchen` | Counter (L-shape along walls), table (1×1) |
| `bedroom` | Bed (2×1), desk (1×1), shelf (1×1) |
| `bathroom` | — (too small for gameplay-relevant props) |
| `office_room` | Desk (1×1), chair (0.5×0.5), shelf (2×1) |
| `open_office` | Desk clusters (2×1 each), spaced 2m apart |
| `retail` | Counter near back, shelf rows |
| `warehouse_floor` | Crate clusters, shelving rows along walls |
| `corridor` | — (keep clear for movement) |
| `stairwell` | — (stairs only) |

**Placement algorithm:**
1. For each room, get eligible props from tag table
2. Place largest props first (against walls when specified)
3. Maintain 1-cell clearance from doors
4. Skip prop if it doesn't fit remaining space

---

## 3. Panel Instantiation

Convert a `BuildingDef` into Three.js geometry. This is where the abstract floorplan becomes panels in the scene.

### 3.1 Panel Placement Rules

For each cell `(x, z)` on floor `f`:

**Floor panels:** If `cells[x][z] != 0` (interior), place horizontal panel at `y = f * heightPerFloor`. Material: floor type.

**Ceiling panels:** If `cells[x][z] != 0` AND (top floor OR cell above is exterior), place horizontal panel at `y = (f+1) * heightPerFloor - 0.1`. Material: floor type.

**Wall panels:** For each wall segment flagged in `walls.h` or `walls.v`, place vertical panels from floor to ceiling (typically 3 panels high at 1m each, minus door/window openings). Use material from `wallMaterials`. Skip positions marked as doors. Use glass material for positions marked as windows.

**Stairwell voids:** If `cells[x][z] == 3`, omit floor panel on floors above ground to create the vertical shaft.

**Roof:** For `flat` roof: floor panels on top of the highest story. For `peaked` roof: add non-panel cosmetic triangular prism geometry centered on the building's long axis. Peaked roof geometry is a single `THREE.BufferGeometry` (not destructible).

### 3.2 Mesh Strategy

Per the destruction spec (§7): each wall is one merged `THREE.Mesh` with `BufferGeometry`. Panels within a wall share a buffer. Each panel = 12 triangles = 36 vertices (non-indexed).

**Per-wall mesh:** Group panels by wall (each cardinal face of the building + each interior partition wall = one mesh).

**Floor/ceiling meshes:** One merged mesh per floor per story. Horizontal panels.

**Building group:** `THREE.Group` containing all wall meshes, floor meshes, roof mesh, stair meshes, prop meshes.

### 3.3 Panel Data Registration

On instantiation, register each panel with the destruction system:

```javascript
{
  id: unique,
  type: 'concrete' | 'brick' | 'wood' | 'glass' | 'metal' | 'chainlink',
  hp: Number,          // from panel type table
  maxHp: Number,
  gridX: Number,       // position in wall grid
  gridY: Number,
  wallId: Number,      // which wall mesh
  buildingId: Number,
  vertexStart: Number, // index into wall mesh buffer
  vertexCount: 36,
  penetrationCost: Number,
  isSupported: true    // initial state; destruction system manages this
}
```

---

## 4. Panel Types

From `destruction-spec.md` §4.1, restated for reference:

| Type | HP | Penetration Cost | Color | Use |
|------|-----|-----------------|-------|-----|
| Concrete | 5 | 1.0 | `#6b6b6b` | Structural walls, floors, ceilings |
| Brick | 3 | 0.8 | `#8b4513` | Residential exterior walls |
| Wood | 2 | 0.5 | `#c4a86b` | Interior partitions, residential |
| Glass | 1 | 0.1 | `#aad4e6` (opacity 0.3) | Windows, storefronts |
| Metal | 4 | 0.9 | `#4a4a4a` | Industrial walls, doors |
| Chain-link | 2 | 0.1 | wireframe gray | Fences, industrial partitions |

---

## 5. Archetype Specifications

### 5.1 Warehouse

- **Footprint:** 10–20 × 15–30, rectangle
- **Floors:** 1 (double height: `heightPerFloor = 6`)
- **Interior:** Mostly open. 0–2 BSP splits creating a small office in one corner.
- **Walls:** Metal exterior, wood interior partitions
- **Entries:** 1–2 large doors (2–3 cells wide) on long sides, 1 personnel door on short side
- **Windows:** Sparse, high placement (y ≥ 4m), glass
- **Roof:** Flat, accessible via ladder (1 exterior ladder)
- **Props:** Crate clusters, shelving rows along walls
- **Features:** Catwalk — elevated walkway at y=3m, made of floor panels on metal column props. 1 cell wide, runs partial length of building. Accessible via ladder.
- **Gameplay:** Long interior sightlines, catwalk provides mid-height cover, large doors mean easy enemy entry

### 5.2 Dwelling (Suburban House)

- **Footprint:** 6–10 × 8–12, rectangle or L-shape (30% chance)
- **Floors:** 1–2
- **Interior:** BSP into 3–6 rooms per floor
- **Ground floor rooms:** living room, kitchen, hallway, bathroom
- **Upper floor rooms:** 2–3 bedrooms, bathroom
- **Walls:** Brick exterior, wood interior
- **Entries:** Front door (center of one long side), back door (opposite side or perpendicular)
- **Windows:** Medium density (0.4–0.6), front-facing bias
- **Roof:** Peaked (cosmetic)
- **Stairs:** 1 stairwell if 2-story, placed adjacent to hallway
- **Props:** Per room tag (§2.6)
- **Gameplay:** Close quarters, multiple entry points, upper floor gives slight elevation advantage

### 5.3 Apartment Building

- **Footprint:** 10–15 × 15–25, rectangle or U-shape (20% chance)
- **Floors:** 3–6
- **Interior:** Central corridor (1–2 cells wide, long axis). Units on both sides, each 4–8 cells. Each unit subdivided into 2–4 rooms.
- **Walls:** Concrete exterior, wood interior within units, concrete between units and corridor
- **Entries:** Main entrance (ground floor, 2 cells wide), fire exit (back)
- **Windows:** Regular grid (density 0.5–0.7), one per room on exterior walls
- **Roof:** Flat, accessible via stairwell
- **Stairs:** 1–2 stairwells at building ends, opening to corridor
- **Ladders:** 1 exterior fire escape ladder on one side
- **Props:** Per room tag within each unit
- **Gameplay:** Many rooms for CQB, corridors become kill zones, roof is a strong overwatch position, fire escape enables flanking

### 5.4 Office Building

- **Footprint:** 12–20 × 12–20, rectangle or T-shape (20% chance)
- **Floors:** 3–8
- **Interior:** Ground floor: lobby (open, double height if floors ≥ 4). Upper floors: either open-plan (2–3 BSP splits) or office grid (corridor + small rooms). Mix: 50% chance each floor is open-plan vs. grid.
- **Walls:** Concrete structure, glass exterior (density 0.7–0.9), wood or glass interior partitions
- **Entries:** Main entrance (ground floor, 2–3 cells wide, glass), service entrance (back, metal door)
- **Windows:** Dominant. Most exterior walls are glass panels.
- **Roof:** Flat, accessible. Small rooftop mechanical room (3×3, concrete, one metal door).
- **Stairs:** 1–2 stairwells. Elevator shaft: vertical void (2×2) with concrete walls, no floor panels — impassable, but destructible walls mean it could be opened.
- **Props:** Desk clusters, conference tables (2×2), shelf units
- **Gameplay:** Glass exterior means enemies see in and player sees out. Glass breaks fast under fire, making cover temporary. Height advantage is significant. Lobby is a dangerous open space.

### 5.5 Strip Mall Unit

- **Footprint:** 8–15 × 6–10, rectangle. One long side is "front."
- **Floors:** 1
- **Interior:** Front 2/3 is open retail. Back 1/3 is storage, separated by partition wall with one door.
- **Walls:** Concrete sides/back, glass front
- **Entries:** Front door (glass, 1–2 cells wide in glass front wall), back service door (metal)
- **Windows:** Front wall is mostly glass. Sides/back: 0–1 small windows.
- **Roof:** Flat, accessible via ladder (exterior, back wall)
- **Props:** Counter near back partition, shelf rows in retail area, crates in storage
- **Features:** Awning — cosmetic geometry extending 1m from front wall, 0.3m thick. Not destructible.
- **Gameplay:** Glass front shatters immediately, exposing interior. Back room is the fallback. Roof gives elevation over parking lot.

---

## 6. Interior Props

Props are destructible cover objects placed inside rooms. Simpler than panels — no structural integrity graph.

### 6.1 Prop Types

| Prop | Size (cells) | HP | Material | Cover Height |
|------|-------------|-----|----------|-------------|
| Table | 1×1 | 3 | Wood | 0.8m (crouch cover) |
| Desk | 1×1 | 4 | Wood | 0.8m |
| Counter | 1×0.5 | 4 | Wood/Metal | 1.0m |
| Shelf | 2×0.5 | 3 | Wood | 1.8m (full cover) |
| Couch | 2×1 | 3 | Wood | 0.7m (crouch cover) |
| Bed | 2×1 | 2 | Wood | 0.5m (prone cover) |
| Crate | 1×1 | 5 | Wood | 1.0m |
| Filing cabinet | 0.5×0.5 | 4 | Metal | 1.2m |
| Conference table | 2×1 | 5 | Wood | 0.8m |

### 6.2 Prop Geometry

Each prop is a simple `THREE.BoxGeometry` (or 2–3 merged boxes for L-shapes like counters). `MeshLambertMaterial`, `flatShading: true`, color from style palette.

### 6.3 Prop Destruction

- On HP reaching 0: remove mesh, spawn 2–4 debris pieces (smaller boxes), update nav grid cell (passable)
- Props do NOT participate in structural integrity. Breaking a shelf doesn't collapse anything.
- AI treats props as cover based on cover height vs. stance

### 6.4 Prop Collision

Props register with the nav grid as obstacles. Movement blocked by props. Bullets interact with props via the ballistics pipeline (same as panels — raycast hit, apply damage, penetration check).

---

## 7. Vertical Connectors

### 7.1 Stairs

**Geometry:** Fit within a 2×1 cell footprint per flight (one floor). Each flight has 10 steps. Each step is a box: 1m wide × 0.28m rise × 0.5m run. Steps are individual meshes grouped in the building group.

**Construction:**
1. Clear floor panels above stairwell cells on all floors except ground
2. Place step geometry ascending from floor `f` to floor `f+1`
3. Half-landing: 5 steps up, 1×1 platform, turn 180°, 5 steps up. Total footprint: 2×1 per flight.
4. Railing: thin box geometry on open sides, cosmetic

**Player interaction:** Player walks onto steps like ramps. Each step has collision. Movement speed reduced to 70% on stairs.

**Destructibility:** Steps are props (HP 3, wood or concrete depending on building). Destroying steps creates gaps — player and AI must jump or find alternate route.

### 7.2 Ladders

**Geometry:** 0.5m wide × 0.1m deep, placed flush against a wall face. Rungs are thin horizontal boxes every 0.3m.

**Player interaction:** Enter ladder trigger volume → switch to ladder movement mode (vertical only, speed 2m/s). Exit at top/bottom.

**Destructibility:** Ladder is a single prop (HP 3, metal). On destruction: removed, vertical route broken.

### 7.3 Nav Grid Registration

Stairs and ladders are registered as **vertical nav links** — connections between nav grid nodes on different floors. The AI pathfinder treats them as traversable edges with a movement cost penalty (stairs: 1.5× distance, ladders: 2× distance).

---

## 8. Biome Integration

Each biome specifies a weighted distribution of archetypes and styles.

```javascript
BiomeBuildingConfig {
  archetypeWeights: { [archetype]: float },  // probability weights
  styleOverrides: Partial<StylePalette>,      // biome-specific colors
  densityRange: [min, max],                   // buildings per chunk
  heightRange: [minFloors, maxFloors],         // floor count override
  spacingMin: float                            // minimum gap between buildings in meters
}
```

| Biome | Archetypes (weight) | Density | Floors |
|-------|-------------------|---------|--------|
| Suburbs | dwelling (0.8), strip_mall (0.2) | 2–4 | 1–2 |
| Strip Mall | strip_mall (0.7), warehouse (0.2), office (0.1) | 3–5 | 1 |
| Industrial | warehouse (0.6), office (0.2), strip_mall (0.2) | 1–3 | 1–2 |
| Downtown | office (0.5), apartment (0.4), strip_mall (0.1) | 4–6 | 3–8 |

---

## 9. Implementation Order

1. **Data structures** — `FloorPlan`, `BuildingDef`, `StylePalette`. No geometry yet.
2. **Footprint generation** — Rectangle, L-shape, T-shape, U-shape generators.
3. **BSP room partitioning** — Recursive splits with archetype constraints.
4. **Door placement** — MST connectivity, exterior doors.
5. **Window placement** — Density-based, archetype rules.
6. **Panel instantiation** — Convert floorplan to merged `BufferGeometry` per wall. Register panels with destruction system.
7. **Stair/ladder geometry** — Step meshes, ladder meshes, nav links.
8. **Prop placement** — Room-tag-driven placement, collision registration.
9. **Archetype-specific logic** — Warehouse catwalks, office lobbies, apartment corridors.
10. **Biome wiring** — Hook archetype selection into `world.js` chunk generation.

Steps 1–6 are the minimum viable building. Steps 7–10 add gameplay depth.

---

## 10. Performance Notes

- Panel instantiation happens at chunk generation time (not per frame)
- Merge aggressively: one buffer per wall, one per floor slab
- Building complexity caps: max 500 panels per building, max 4 buildings per chunk
- LOD: buildings beyond 100m render as single simplified box meshes (no panel grid)
- Props use object pooling shared with the debris system

---

## 11. Interface with Destruction System

The building generator produces panels. The destruction system consumes them. Interface:

**Generator → Destruction:**
- `registerPanel(panelData)` — called per panel during instantiation
- `registerProp(propData)` — called per prop
- Panel data includes: id, type, hp, grid position, wall/building id, vertex buffer location

**Destruction → Generator:**
- None. Generation is a one-time event per building. Destruction operates on the instantiated panels independently.

**Generator → Nav:**
- `registerBuildingFootprint(buildingId, cells, worldPos)` — marks cells as impassable
- `registerVerticalLink(fromNode, toNode, cost)` — stair/ladder connections
- `registerProp(propId, cells, worldPos)` — marks cells as blocked

**Generator → World:**
- `spawnBuilding(buildingDef, worldPos)` → returns `THREE.Group` to add to scene