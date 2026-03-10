# Player Collision & Interior Navigation — sprawl

## Context

This spec defines player collision with building geometry and interior/exterior AI navigation. The panel-grid building system (see `building-generation-spec.md`) provides a complete discrete representation of all surfaces. This spec derives collision volumes and navigation graphs from that representation.

**Implementation priority:** Player collision first (§1–§3). AI interior nav second (§4–§5). Vertical movement third (§6). Destruction integration last (§7).

Implement in `src/collision.js` (new file), update `src/player.js` (movement physics), `src/nav.js` (interior graph), `src/buildings.js` (emit collision/nav data on generation).

Read `CLAUDE.md`, `building-generation-spec.md`, and `destruction-spec.md` before starting. Obey all hard rules.

---

## 1. Grid Conventions & the 0.1m Rule

All panels sit on integer gridlines and extend **+0.1m in the positive direction** of their normal axis.

### 1.1 Wall Panels

- **V-wall** at grid column `x`: occupies `[x, x+0.1]` in the X axis, spans `[z, z+1]` in Z, `[y, y+1]` in Y.
- **H-wall** at grid row `z`: occupies `[z, z+0.1]` in the Z axis, spans `[x, x+1]` in X, `[y, y+1]` in Y.

"H-wall" and "V-wall" refer to the wall's orientation on the floorplan grid — H-walls run along the X axis (separating Z rows), V-walls run along the Z axis (separating X columns).

### 1.2 Floor/Ceiling Panels

- **Floor** at story `f`: occupies Y range `[f * 3.0, f * 3.0 + 0.1]`.
- **Ceiling** at story `f`: occupies Y range `[(f+1) * 3.0 - 0.1, (f+1) * 3.0]`.

### 1.3 Coordinate Transform

All panel positions are **local** to the building origin `(worldX, terrainY, worldZ)`. Collision queries transform the player's world position into building-local coordinates:

```javascript
localX = playerX - building.worldX
localY = playerY - building.terrainY
localZ = playerZ - building.worldZ
```

---

## 2. Collision Volume Generation

At building instantiation, derive collision volumes from the floorplan. These are **axis-aligned boxes (AABBs)** stored in a spatial lookup structure.

### 2.1 Wall Collision Boxes

For each contiguous run of wall panels along a wall line (no door interruptions), emit one AABB:

**V-wall run** at column `x`, from `z0` to `z1`, floors `f0` to `f1`:
```
AABB {
  minX: x, maxX: x + 0.1,
  minY: f0 * 3.0, maxY: (f1 + 1) * 3.0,
  minZ: z0, maxZ: z1
}
```

**H-wall run** at row `z`, from `x0` to `x1`, floors `f0` to `f1`:
```
AABB {
  minX: x0, maxX: x1,
  minY: f0 * 3.0, maxY: (f1 + 1) * 3.0,
  minZ: z, maxZ: z + 0.1
}
```

Merge vertically too: if wall panels exist on consecutive floors with no gap, combine into a single tall AABB.

**Door openings** break the run. A door at `(x=3, z, axis='v')` splits a V-wall run at column 3 into segments `[z0, 3]` and `[4, z1]` (skipping the 1m door cell).

Doors come in two sizes:
- **Standard door (2 panels high):** Panels at gridY 0 and 1 are absent. Lintel panel at gridY 2 remains. Collision: the lintel AABB spans `[y + 2.0, y + 3.0]` across the door cell. Players walk through standing.
- **Crawl opening (1 panel high):** Only gridY 0 panel is absent. Panels at gridY 1 and 2 remain. Collision: blocking AABB starts at `[y + 1.0]`. Player must crouch (§3.5) to pass through. Useful for damaged walls, vents, service hatches.

Do not modify door generation — this spec only describes how existing door data maps to collision volumes.

**Foundation access:** When a building's floor level is above surrounding terrain (due to terrain slope or raised foundation), the building generator must place entry ramps or steps outside each exterior door. These are collision geometry registered like stair steps:
- If height difference ≤ 0.35m: no ramp needed (auto-step handles it).
- If 0.35m < difference ≤ 1.0m: 2–3 step boxes outside the door, each ≤ 0.3m rise.
- If difference > 1.0m: ramp geometry (sloped collision box, 1m wide, slope ≤ 30°).

Foundation steps/ramps are generated in `buildings.js` during placement, based on the delta between `building.terrainY + floorHeight` and the terrain height at each exterior door position. They register as collision AABBs like stair steps.

**Window openings** are NOT collision gaps. Glass panels are solid for collision purposes (until destroyed). The ballistics system handles bullet penetration separately. A player cannot walk through an intact window. See §3.6 for vaulting through broken windows.

### 2.2 Floor/Ceiling Collision Boxes

Per story, one AABB per contiguous floor region:

```
AABB {
  minX: 0, maxX: footprintW,
  minY: f * 3.0, maxY: f * 3.0 + 0.1,
  minZ: 0, maxZ: footprintD
}
```

In practice, floors have voids (stairwells, destroyed panels). Represent as the full rectangle minus void cells. Two options:

- **Option A (simple):** One big floor AABB + mark void cells in a 2D boolean grid. Collision check: AABB test first, then grid lookup for void. **Use this.**
- **Option B:** Decompose into per-cell AABBs. Too many boxes.

### 2.3 Prop Collision Boxes

Each prop → one AABB from its size and position (see `building-generation-spec.md` §6). Props are building-local. Register on instantiation, remove on destruction.

### 2.4 Spatial Lookup

Store all collision AABBs in a **per-building grid** indexed by floorplan cell `(cx, cz, floor)`. Each cell stores a list of AABBs that overlap it.

Query: given player's building-local position, compute `(cx, cz, floor)` → retrieve candidate AABBs → test against player volume.

Also maintain a **world-level spatial hash** mapping world XZ cells to buildings, so the player collision system can quickly find which building(s) to test against.

---

## 3. Player Movement Physics

The player is a vertical capsule: 0.3m radius, 1.7m tall (eye height 1.6m). For collision purposes, approximate as an AABB: 0.6m × 1.7m × 0.6m centered on the player's XZ position, bottom at foot level.

### 3.1 Swept AABB Collision

Each frame, the player has a desired movement vector `(dx, dy, dz)` from input + gravity. Resolve collisions axis-by-axis to allow wall sliding:

```
function moveAndCollide(pos, velocity, dt, colliders):
    delta = velocity * dt

    // Resolve each axis independently — order matters for corner behavior
    // Resolve Y first (gravity/jumping), then X, then Z
    for axis in [Y, X, Z]:
        candidatePos = pos + delta[axis]
        playerAABB = makeAABB(candidatePos)

        for each collider in getCandidates(candidatePos):
            if overlaps(playerAABB, collider):
                // Push player out along this axis
                if delta[axis] > 0:
                    pos[axis] = collider.min[axis] - playerHalfSize[axis]
                else:
                    pos[axis] = collider.max[axis] + playerHalfSize[axis]
                velocity[axis] = 0
                break
            else:
                pos[axis] = candidatePos[axis]

    return pos, velocity
```

Resolve Y first so ground contact is established before horizontal sliding. This prevents the player from "sticking" to walls when falling.

### 3.2 Ground Detection

After Y-axis resolution, the player is **grounded** if:
- There is a collision surface within 0.05m below the player's feet, OR
- The player is on terrain (existing terrain height check)

If grounded: zero vertical velocity, enable jumping. If not grounded: apply gravity (`-20 m/s²` — slightly higher than real gravity for snappy feel).

### 3.3 Auto-Step

Handles curbs, stair steps, rubble edges, and floor thresholds without requiring a jump.

When horizontal movement is blocked by a collider:
1. Check if the obstacle top is ≤ `stepHeight` (0.35m) above the player's current foot Y.
2. Check if there is clearance (1.7m) above the obstacle top.
3. If both: teleport player up to obstacle top. No velocity change.

```
function tryAutoStep(pos, moveDir, collider):
    obstacleTopY = collider.maxY
    footY = pos.y
    stepUp = obstacleTopY - footY

    if stepUp > 0 and stepUp <= 0.35:
        // Check head clearance at stepped-up position
        testPos = { x: pos.x + moveDir.x, y: obstacleTopY, z: pos.z + moveDir.z }
        testAABB = makeAABB(testPos)
        if no collisions above testAABB within 1.7m:
            pos.y = obstacleTopY
            return true  // step succeeded, continue horizontal move

    return false  // can't step, treat as wall
```

This is what makes stairs work physically: each step is a box ≤ 0.3m tall, and auto-step lifts the player onto each successive step as they walk forward.

### 3.4 Jumping

- Jump impulse: `+8 m/s` vertical (clears ~1.2m with gravity at -20).
- Only when grounded.
- No air control reduction (keep full strafe speed — this is an arcade FPS, not a sim).
- Crouch-jump for extra clearance: not in v1. Add later if needed.

### 3.5 Crouch

- Crouch reduces player AABB height from 1.7m to 1.0m (eye height 0.9m).
- Crouch blocks: if the 1.7m AABB would collide at current position, the player cannot uncrouch. Prevents standing up inside low spaces.
- Movement speed at 60% while crouched.
- Crouch is relevant for cover: a crouched player behind a 1.0m high prop is hidden from direct fire.
- Crouch enables passage through 1-panel-high openings (crawl openings, broken windows at gridY 0 only). The 1.0m crouched AABB fits under the lintel at gridY 1.

### 3.6 Window Vaulting

Broken windows become entry points. When glass panels are destroyed, the bitmask marks them as passable (§7.1). But windows have a sill — the wall below the window — that must be vaulted over.

**Vault conditions (all must be true):**
1. Player is moving toward a wall opening (horizontal velocity component into the wall > 1 m/s).
2. The opening has all panels destroyed in a contiguous column from some height down to the sill.
3. The sill height (lowest intact panel top) is between 0.35m and 1.3m above player's feet. Below 0.35m = auto-step. Above 1.3m = too high to vault.
4. There is clearance above the sill for the player's height (1.7m standing, 1.0m crouched).
5. Player is pressing jump.

**Vault action:**
- If sill ≤ 1.0m and clearance ≥ 1.7m: standing vault. Player hops onto sill, continues forward. Brief animation (0.3s of reduced speed).
- If sill ≤ 1.0m and clearance between 1.0m–1.7m: crouch-vault. Player must be crouching (or auto-crouches). Hops onto sill, continues in crouch.
- If sill between 1.0m–1.3m: high vault, requires jump. Player pulls up, brief 0.4s animation, lands on other side.

**Implementation:** Vault is not a separate movement mode. It is auto-step (§3.3) with an elevated `stepHeight` triggered only when the player presses jump near a wall opening. Effectively: jump near a broken window → temporarily raise stepHeight to 1.3m → auto-step resolves the sill → restore normal stepHeight.

```
function tryVault(pos, moveDir, wall, bitmask):
    // Find lowest destroyed panel column at player's position along wall
    sillY = findSillHeight(wall, bitmask, playerGridPos)
    clearanceY = findClearanceAboveSill(wall, bitmask, playerGridPos)
    
    if sillY == null: return false           // no opening
    if sillY <= 0.35: return false           // auto-step handles this
    if sillY > 1.3: return false             // too high
    if clearanceY < 1.0: return false        // can't fit even crouched
    
    playerHeight = isCrouching ? 1.0 : 1.7
    if clearanceY < playerHeight and not isCrouching:
        forceCrouch()                        // auto-crouch for vault
    
    pos.y = sillY                            // step up to sill
    return true                              // continue horizontal move
```

**Entering a building:** The player walks through a doorway. No special transition — the door gap is a 1m-wide, 2m-tall opening in the collision volumes. The player's AABB fits (0.6m wide < 1.0m opening). For crawl openings (1 panel high), the player must crouch first.

**Terrain-to-floor transition:** Buildings sit on terrain. The ground-floor floor panel is at `terrainY + 0.0` to `terrainY + 0.1`. If the terrain at the door is level with the floor, the player steps up 0.1m (within auto-step range). If terrain slopes away from the building, foundation steps or ramps provide access (see §2.1, Foundation access). The building generator handles this.

**Vaulting in through windows:** Broken windows on the ground floor (or any floor accessible from outside) can be entered via the vault mechanic (§3.6). The player sprints at the window, presses jump, and vaults over the sill.

**Exiting through a destroyed wall:** When wall panels are destroyed, the bitmask marks them passable (§7.1). The player walks through if ground-level panels are gone. If only upper panels are destroyed, the lower intact panels still block — but the gap may be vaultable (§3.6).

### 3.7 Player AABB vs. Building AABB Pipeline

Per frame:

1. Compute player's world-space AABB from position.
2. Query world spatial hash → get candidate buildings.
3. For each candidate building:
   a. Transform player position to building-local coords.
   b. Query building's cell grid → get candidate collision AABBs.
   c. Run swept AABB resolution (§3.1).
   d. Transform resolved position back to world coords.
4. Also resolve against terrain height (existing system).
5. Also resolve against other non-building colliders (future: vehicles, large props).

**Ordering:** Resolve terrain first (establishes base Y), then buildings (walls + floors override terrain inside buildings).

---

## 4. Interior Navigation Graph

For AI pathfinding through building interiors. Separate from player collision — the player uses physics, AI uses graph search.

### 4.1 Node Generation

One nav node per passable floor cell per story.

A cell `(cx, cz)` on floor `f` gets a nav node if:
- `cells[cx][cz] != 0` (not exterior)
- A floor panel exists (not a stairwell void above ground floor)

Node world position: `(building.worldX + cx + 0.5, building.terrainY + f * 3.0 + 0.1, building.worldZ + cz + 0.5)` — center of cell, on top of floor panel.

### 4.2 Horizontal Edges

Two adjacent nodes on the same floor are connected if:
- No wall segment separates them, OR
- A door exists in the wall segment between them.

Edge cost: 1.0 for straight (cardinal), 1.414 for diagonal. Diagonal edges only if both cardinal components are also passable (no corner-cutting through walls).

**Prop blocking:** Cells occupied by props are passable but with elevated cost (2.0). AI will route around props when a clear path exists, but can path through them if necessary (props are destructible, AI can shoot them).

### 4.3 Vertical Edges

Stairwell connections:
- Stair at `(cx, cz)` on floor `f` connecting to floor `f+1`: edge from node `(cx, cz, f)` to node `(cx, cz, f+1)` with cost = 3.0 (penalty for vertical movement).
- Bidirectional (up and down).

Ladder connections:
- Same as stairs but cost = 5.0 (slower traversal).

### 4.4 Portal Nodes — Interior/Exterior Connection

Each ground-floor door connects the interior nav graph to the exterior terrain nav grid.

For each exterior door at building-local `(cx, cz)`:
1. Compute world position of the cell just outside the door.
2. Find the nearest exterior nav grid node.
3. Create a bidirectional edge from the interior door node to the exterior nav node. Cost = 1.5.

**Dynamic portals:** When wall panels are destroyed, check if a ground-level traversable gap exists (≥1m wide, ground to ≥1.8m clear). If so, create a new portal edge. See §7.

### 4.5 Multi-Floor Window Portals

Upper-floor windows overlooking roofs, fire escapes, or adjacent buildings: not in v1. When destruction opens holes in upper exterior walls, those become portals only if there is a surface to stand on outside (adjacent roof, etc.). Complex — defer.

---

## 5. Merged Nav Graph

The game has one unified nav graph combining exterior terrain nodes and interior building nodes.

### 5.1 Structure

```javascript
NavGraph {
  nodes: Map<nodeId, { x, y, z, floor, buildingId, isInterior }>,
  edges: Map<nodeId, [{ target: nodeId, cost: number }]>,
  portalEdges: Set<edgeId>  // track which edges are portals (for dynamic updates)
}
```

### 5.2 Query

A* operates on this unified graph. An enemy outside can path through a door, up stairs, and to a window position on the second floor — all in one pathfinding query.

### 5.3 Building Registration

When `world.js` spawns a building:
1. `buildings.js` generates the building, emits collision + panel data.
2. `collision.js` ingests collision AABBs (§2).
3. `nav.js` calls `registerBuildingInterior(buildingId, floors, worldPos)`:
   - Generate interior nodes and edges (§4.1–§4.3).
   - Create portal edges to exterior grid (§4.4).
   - Merge into the unified graph.

---

## 6. Vertical Movement — Stairs & Ladders

### 6.1 Stair Geometry (Recap)

Per `building-generation-spec.md` §7.1: 2×1 cell footprint, 10 steps per flight, each step ~0.28m rise × 0.5m run. Half-landing with 180° turn.

For collision: each step is a box AABB. Auto-step (§3.3) handles ascent. The player walks into the stairwell and moves upward step-by-step with normal WASD controls. No special mode.

**Descent:** The player walks down stairs using the same physics. Each step edge is a small drop (0.28m). Since `stepHeight` is 0.35m and auto-step only triggers on *blocked* horizontal movement, descending just means the player walks off each step and falls 0.28m — well within the "no fall damage" threshold. Gravity handles it. No special code.

### 6.2 Stair Collision Registration

At building generation, each stair step registers as a collision AABB:

```javascript
// Per step in a flight
{
  minX: stairWorldX,
  maxX: stairWorldX + 1.0,  // 1m wide
  minY: baseY + stepIndex * 0.28,
  maxY: baseY + (stepIndex + 1) * 0.28,
  minZ: stairWorldZ + stepIndex * 0.5,
  maxZ: stairWorldZ + (stepIndex + 1) * 0.5
}
```

The half-landing platform is a single AABB at the turn point.

### 6.3 Ladder Mode

Ladders require a mode switch because the player must move vertically without falling.

**Enter:** Player looks at ladder + presses interact key (E) within 1m. OR: player walks into a trigger volume at ladder base/top.

**While on ladder:**
- W/S = move up/down at 2 m/s.
- A/D = no lateral movement.
- Mouse look: restricted to ±60° yaw (can look around, can't turn away from ladder).
- Gravity disabled.
- Player AABB anchored to ladder X/Z, only Y changes.
- Cannot fire weapons.

**Exit:**
- Reach top → step off onto floor (place player on floor panel at ladder top + 0.5m forward).
- Reach bottom → step off onto ground.
- Press jump → leap backward off ladder (useful for quick dismount). Player gets a -3 m/s Z impulse (away from wall) + gravity resumes.
- Take damage → forced dismount (fall from current height, take fall damage).

### 6.4 Ladder Collision

Ladder itself is not a collision volume for normal movement (thin geometry). Only the trigger volume at base and top matters for interaction.

---

## 7. Destruction Integration

When panels are destroyed, update both collision and nav.

### 7.1 Collision Updates

**Panel destroyed:**
1. Identify which collision AABB(s) the panel belonged to.
2. If the AABB covered only this panel: remove it entirely.
3. If the AABB covered a run of panels: split into two smaller AABBs (before and after the gap). If the gap is at the end of a run, just shrink.

**Optimization:** Rather than splitting AABBs dynamically, use a per-panel collision flag. The AABB stays, but collision queries check the flag. Cheaper than AABB surgery, and destruction is incremental anyway.

Better yet: **the canonical approach.** Store the full wall-run AABBs but overlay a **destruction bitmask** per wall. Collision test: AABB broad phase, then bitmask narrow phase. A bit at `(gridY, gridPosition)` = 0 means the panel is destroyed and the player can pass.

```javascript
WallCollider {
  aabb: AABB,          // full wall run extent
  wallId: number,
  mask: Uint8Array,    // one byte per panel in the run; 0 = destroyed
  gridStart: number,   // starting grid position along wall axis
  gridY0: number,      // lowest grid Y
  panelsWide: number,
  panelsHigh: number
}

function testPlayerVsWall(playerAABB, wall):
    if not overlaps(playerAABB, wall.aabb): return false

    // Find which panels the player AABB overlaps
    px0 = floor(playerAABB.min[wallAxis] - wall.gridStart)
    px1 = floor(playerAABB.max[wallAxis] - wall.gridStart)
    py0 = floor((playerAABB.minY - wall.baseY) / 1.0)
    py1 = floor((playerAABB.maxY - wall.baseY) / 1.0)

    // Player is blocked if ANY overlapped panel is intact
    for py in [py0..py1]:
        for px in [px0..px1]:
            if wall.mask[py * wall.panelsWide + px] != 0:
                return true  // blocked

    return false  // all overlapped panels destroyed — pass through
```

This means the player can walk through a hole blown in a wall, even if the wall AABB still exists. The bitmask tracks which 1×1m panels are intact. No AABB splitting needed.

### 7.2 Nav Updates

**Panel destroyed → check for traversable gap:**
1. On the wall where the panel was destroyed, scan ground-level panels (gridY 0 and 1 — ground to 2m).
2. If a contiguous horizontal gap of ≥1 cell exists with gridY 0 and 1 both destroyed: traversable opening.
3. Create a portal edge connecting the cells on either side of the gap.

**Floor panel destroyed:**
1. Mark the cell as a void in the floor grid.
2. If the void is large enough (≥1 cell), AI treats it as a fall risk. Remove the nav node or mark cost = infinite.
3. If a stairwell void connects to a destroyed floor below: new vertical edge (enemies can drop down — one-way, cost reflects fall).

**Prop destroyed:**
1. Remove prop's nav cost penalty. Cell reverts to base cost.

### 7.3 Structural Collapse → Collision

When the structural integrity system (destruction-spec §6) triggers a collapse:
1. All panels in collapsed section have their mask bits zeroed.
2. Rubble AABB added at ground level (approximate bounding box of rubble pile).
3. Nav nodes in collapse zone: removed (impassable during collapse), then replaced with rubble nodes (passable, high cost) once settled.

---

## 8. Performance Budget

| Operation | Budget |
|-----------|--------|
| Player collision (per frame) | < 0.3ms |
| Collision AABB candidates (spatial query) | < 0.1ms |
| Nav graph node count (per building) | ≤ 200 |
| Nav graph merge (per building spawn) | < 2ms |
| Destruction → collision update | < 0.1ms per panel |
| Destruction → nav update | < 0.2ms per event |

### 8.1 Collision Optimization

- World spatial hash: 4m × 4m cells. Each cell stores building references.
- Per-building: only test if player AABB overlaps building's world AABB.
- Per-wall: broad-phase AABB test is cheap. Bitmask narrow-phase is O(panels overlapped), typically 2–6.
- Expected collision tests per frame: ~10–20 AABBs. Well within budget.

### 8.2 Nav Optimization

- Interior nodes are generated once at building spawn.
- A* pathfinding already budgeted at 2ms/frame total (destruction-spec §11). Interior nodes increase graph size but the heuristic keeps search bounded.
- Portal edges are bidirectional — no asymmetric costs to worry about in search.

---

## 9. Implementation Order

### Phase 1: Player Collision (do this first)

1. **`src/collision.js` — CollisionWorld class.** World spatial hash. `addBuilding(id, aabbs)`, `removeBuilding(id)`, `query(aabb) → candidates`. Also holds terrain reference.
2. **Wall collider generation in `src/buildings.js`.** After panel instantiation, scan floorplan walls → emit `WallCollider` objects (§7.1 format) with bitmask. Emit floor colliders. Register with CollisionWorld.
3. **Swept AABB movement in `src/player.js`.** Replace existing movement code. Y-first resolution, then X, then Z (§3.1). Ground detection (§3.2). Integrate gravity.
4. **Auto-step (§3.3).** Add to horizontal resolution. Test with door thresholds and stair steps.
5. **Jump (§3.4).** Simple vertical impulse when grounded.
6. **Crouch (§3.5).** AABB resize, uncrouch check, speed reduction.

### Phase 2: Vertical Movement

7. **Stair collision registration** in `src/buildings.js`. Each step → AABB → register.
8. **Test stair traversal.** Player should auto-step up/down stairs with WASD. No special code beyond §3.3.
9. **Ladder mode** in `src/player.js`. State machine: normal ↔ ladder. Interaction trigger, vertical movement, exit conditions.

### Phase 3: AI Interior Nav

10. **Interior node generation** in `src/nav.js`. `registerBuildingInterior()` per §4.1.
11. **Horizontal edges** per §4.2. Wall/door checks.
12. **Vertical edges** for stairs/ladders per §4.3.
13. **Portal edges** connecting interior to exterior grid per §4.4.
14. **Test:** enemy pathfinds from exterior through door, up stairs, to window.

### Phase 4: Destruction Updates

15. **Bitmask update** on panel destruction → collision passability changes.
16. **Dynamic portal creation** when walls are destroyed → nav edges added.
17. **Floor void handling** → nav node removal.
18. **Collapse → rubble collision** replacement.

---

## 10. Interface Summary

### buildings.js → collision.js

```javascript
collision.addBuilding(buildingId, {
  worldPos: { x, y, z },
  wallColliders: WallCollider[],    // per-wall bitmask colliders
  floorColliders: FloorCollider[],  // per-story floor with void grid
  propColliders: AABB[],            // per-prop
  stairColliders: AABB[]            // per-step
})
```

### buildings.js → nav.js

```javascript
nav.registerBuildingInterior(buildingId, {
  worldPos: { x, y, z },
  floors: FloorPlan[],              // cell grids, walls, doors
  stairs: StairDef[],               // vertical connections
  ladders: LadderDef[],
  exteriorDoors: DoorDef[]          // for portal edges
})
```

### destruction.js → collision.js

```javascript
collision.destroyPanel(buildingId, wallId, panelGridX, panelGridY)
collision.destroyFloorCell(buildingId, floor, cellX, cellZ)
collision.addRubble(aabb)
collision.removeRubble(rubbleId)
```

### destruction.js → nav.js

```javascript
nav.onPanelDestroyed(buildingId, wallId, panelGridX, panelGridY)
nav.onFloorDestroyed(buildingId, floor, cellX, cellZ)
nav.onCollapseSettled(buildingId, rubbleBounds)
```

---

## 11. Design Notes

**Why swept AABB and not raycasts for player collision?** Raycasting against panel geometry works for bullets but fails for movement. The player is a volume, not a point. A 0.6m-wide player trying to walk through a 1.0m doorway needs volumetric intersection, not a single ray. Swept AABB gives wall-sliding for free and handles corners correctly.

**Why bitmask overlay instead of AABB splitting?** Splitting AABBs on destruction creates fragmentation — a wall that's been shot up produces dozens of tiny AABBs, each needing broad-phase tests. The bitmask keeps one AABB per wall run regardless of damage. The narrow-phase bitmask check is branchless (array lookup) and cache-friendly.

**Why resolve Y before X/Z?** Gravity is the dominant force. If you resolve X first, a player sliding along a wall while falling can "catch" on wall edges at floor transitions. Y-first establishes ground contact, then horizontal resolution slides cleanly along walls at the correct height.

**Stairs are not special.** The auto-step threshold (0.35m) exceeds stair step height (0.28m). The player walks up stairs with normal WASD movement. No ramp collider, no special stair mode. Each step is a box, auto-step handles it. This also means rubble, curbs, and low props get stepped over automatically.

**Vaulting is elevated auto-step.** Rather than a dedicated vault animation system, vaulting reuses auto-step with a temporarily raised threshold. Jump + forward movement near a wall opening = vault. This means the mechanic is emergent: any destruction that creates an opening at vault height becomes vaultable. No need to tag specific geometry as "vaultable."

**Foundation ramps solve the terrain seam.** Buildings on sloped terrain can have their floor well above grade on one side. Without explicit entry geometry, the player hits an impassable step. Foundation steps/ramps are generated once during placement, cost almost nothing, and make every door reachable regardless of terrain slope.