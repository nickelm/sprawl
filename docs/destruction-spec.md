# Destruction & Combat System Specification — sprawl

## Context

This spec defines the destruction system and the combat damage model for `sprawl`. Both systems are tightly coupled: every bullet is a raycast that can hit panels, enemies, or the player. Destruction and damage share a single ballistics pipeline.

Implement in `src/destruction.js` (panel system, debris, structural integrity), `src/ballistics.js` (new file — unified bullet simulation), and update `src/player.js` (health model, fall damage), `src/buildings.js` (panel-grid construction), `src/enemies.js` (firing actual rays), `src/weapons.js` (bullet properties), `src/nav.js` (destruction updates), and `src/hud.js` (damage feedback).

Read `CLAUDE.md` and `docs/design.md` before starting. Obey all hard rules (no textures, no build tools, MeshLambertMaterial with flatShading, etc.).

---

## 1. Unified Ballistics Pipeline

Every bullet in the game — player-fired or enemy-fired — goes through the same system. One raycast per bullet. The ray can hit panels, enemies, props, terrain, or the player. This means destruction and combat damage are the same code path.

### 1.1 Bullet Lifecycle

```
Fire → Raycast → Hit Resolution → Penetration Check → Continue or Stop
```

1. **Fire**: origin point + direction vector + weapon properties (damage, penetration power, spread)
2. **Raycast**: `THREE.Raycaster` against all collidable geometry
3. **Hit resolution**: identify what was hit, apply damage
4. **Penetration check**: if the bullet has remaining penetration power after hitting, continue the ray from the exit point with reduced damage
5. **Repeat** until penetration power is exhausted or ray hits nothing

### 1.2 Bullet Properties (per weapon)

```javascript
{
  damage: Number,          // base damage per hit
  penetration: Number,     // penetration budget (see §1.3)
  spread: Number,          // accuracy cone half-angle in radians
  rateOfFire: Number,      // rounds per second
  range: Number,           // max raycast distance
  tracerColor: Number,     // hex color for tracer line
  isExplosive: false       // true for RPG/grenade
}
```

### 1.3 Penetration Model

Each material has a **penetration cost**. A bullet has a **penetration budget** that depletes as it passes through materials. When budget reaches 0, the bullet stops.

| Material | Penetration Cost | Notes |
|----------|-----------------|-------|
| Glass | 0.1 | Bullets pass through almost freely |
| Chain-link | 0.1 | Same as glass |
| Wood | 0.5 | Light cover, penetrable by rifles |
| Brick | 0.8 | Stops most pistol rounds |
| Metal | 0.9 | Nearly impenetrable |
| Concrete | 1.0 | Full stop for most weapons |
| Destroyed panel (gap) | 0.0 | Free passage |

Example penetration budgets by weapon:
- Pistol: 0.4 (penetrates glass/chain-link, not wood)
- Assault rifle: 0.8 (penetrates wood, not concrete)
- Sniper: 1.5 (penetrates wood + brick, or one concrete panel)
- Heavy MG: 1.0 (penetrates wood + metal)

**Damage reduction on penetration**: after passing through a material, remaining damage = `damage * (remainingBudget / originalBudget)`. Bullets get weaker as they punch through stuff.

### 1.4 Enemy Firing: Actual Rays with Spread

Enemies fire real raycasts, not probability rolls. Each enemy shot:

1. Compute aim direction: vector from enemy muzzle to player center mass
2. Apply accuracy spread: perturb direction by a random angle within the enemy's spread cone
3. Fire through the ballistics pipeline (§1.1)

Enemy accuracy parameters:

| Enemy Type | Spread (degrees) | Rate of Fire | Notes |
|------------|-----------------|--------------|-------|
| Rifleman | 3–5° | 2–3 rps | Tightens after 1s of sustained aim |
| Flanker | 5–8° | 3–4 rps | Fires while moving, less accurate |
| Heavy | 6–10° | 8–12 rps | Volume of fire compensates for spread |
| RPG | 1–2° | 0.2 rps | Slow but devastating; explosive (§5.2) |

This means missed shots hit the environment. Every firefight chews up the scenery. The player *sees and hears* bullets impacting around them — dust puffs, debris chips, panel damage — before one actually connects. This is suppression through physics, not a suppression stat.

### 1.5 Tracer Visualization

Every Nth bullet (configurable per weapon, e.g. every 3rd for rifles, every 1st for heavy MG) renders a tracer:
- Thin `THREE.Line` or elongated box from origin to hit point
- Weapon-specific color (orange-yellow for standard, green for enemy, red for heavy)
- Fades over 0.1–0.2 seconds
- Tracers help the player read where fire is coming from

---

## 2. Player Health Model

No health bar. CoD-style screen feedback with a simulation backbone.

### 2.1 Health State

```javascript
{
  hp: 100,               // current health (hidden from player — no numeric display)
  maxHp: 100,
  regenDelay: 3.0,       // seconds after last damage before regen starts
  regenRate: 15,          // HP per second during regen
  timeSinceLastDamage: 0,
  isRegenerating: false,
  damageDirection: null   // vector toward last damage source (for directional indicator)
}
```

### 2.2 Damage Application

When a bullet (enemy-fired) hits the player via the ballistics pipeline:
1. Apply damage (reduced by penetration losses if bullet passed through materials first)
2. Reset `timeSinceLastDamage` to 0
3. Record `damageDirection` (vector from player to enemy who fired)
4. Trigger screen effects (§2.3)

### 2.3 Screen Feedback (No Health Bar)

Communicate damage entirely through screen effects. Implement in `hud.js`:

| HP Range | Visual | Audio |
|----------|--------|-------|
| 100–70 | Clean screen | Normal |
| 70–40 | Red vignette at screen edges, subtle | Heartbeat begins (slow) |
| 40–20 | Heavy red vignette, desaturation begins, slight blur | Heartbeat faster, muffled audio |
| 20–0 | Extreme vignette, heavy desaturation, screen shake | Loud heartbeat, tinnitus whine |
| Regen active | Effects fade smoothly over 2s | Audio normalizes |

**Directional damage indicator**: brief red arc on screen edge in the direction damage came from. Fades over 0.5s. Multiple simultaneous arcs if taking fire from multiple directions.

### 2.4 Regeneration

When `timeSinceLastDamage >= regenDelay`:
- Regenerate at `regenRate` HP/second
- Screen effects fade proportionally
- Regen pauses immediately on any new damage
- Regen is **not** faster in cover — being in cover just means you stop getting hit, which lets the timer start

This is the repositioning incentive: cover is being destroyed → bullets start reaching you → you take damage → move to intact cover → regen kicks in.

### 2.5 Death

On death (hp <= 0):
- Camera drops to ground (lerp down over 0.5s)
- Slow fade to black over 1.5s
- Death screen: wave number, kills, time survived
- Implement as game-over (not respawn). Single life per run.

---

## 3. Fall Damage

### 3.1 Calculation

Track player vertical velocity. On landing (airborne → grounded transition):

```
fallSpeed = abs(velocity.y)  // at moment of ground contact
if fallSpeed > 8:            // ~3.3m fall
    damage = (fallSpeed - 8) * 10
if fallSpeed > 20:           // ~20m fall
    damage = 100             // lethal
```

| Fall Height | Approximate Damage |
|------------|-------------------|
| < 3m | 0 |
| 3–5m | 10–20 |
| 5–8m | 20–50 |
| 8–12m | 50–80 |
| 12m+ | Lethal |

### 3.2 Feedback

- Screen shake proportional to fall speed
- Dull impact thud sound
- Hard landings (damage > 20): 0.3s at 50% move speed
- Severe landings (damage > 50): 3s reduced move speed

### 3.3 Falling Objects

Falling panels from structural collapse that hit the player or enemies:
- `damage = panelMass * fallSpeed * 0.5`
- Single concrete panel falling one story ≈ 30 damage
- Multiple panels from building collapse = likely lethal underneath

---

## 4. Panel Grid Architecture

Every wall is a grid of **panels**: 1m × 1m × 0.1m slabs.

### 4.1 Panel Types

| Type | HP | Cover Value | Penetration Cost | Visual | On Break |
|------|----|-------------|-----------------|--------|----------|
| **Concrete** | 5 | Full | 1.0 | Gray (#6b6b6b) → (#2a2a2a) as HP drops | 4–8 extruded-triangle debris |
| **Brick** | 3 | Full | 0.8 | Red-brown (#8b4513), cracks as HP drops | 5–10 smaller debris |
| **Wood** | 2 | Full | 0.5 | Tan (#c4a86b), splinter marks as HP drops | 3–6 elongated splinter debris |
| **Glass** | 1 | **None** | 0.1 | Light blue (#aad4e6), opacity 0.3 | 8–15 tiny flat triangle shards + shatter sound |
| **Metal** | 4 | Full | 0.9 | Dark steel (#4a4a4a) | 3–5 bent plate debris |
| **Chain-link** | 2 | **None** | 0.1 | Wireframe-style thin gray with gaps | Minimal debris |

**Cover value** is an AI planning hint. The ballistics pipeline handles actual bullet physics. AI will not use glass or chain-link as cover.

Each panel stores:
```javascript
{
  type: String,
  hp: Number,
  maxHp: Number,
  gridX: Number,
  gridY: Number,
  wallId: Number,
  buildingId: Number,
  isSupported: Boolean,
  penetrationCost: Number
}
```

### 4.2 Damage Visualization

Progressive damage before breaking:
- 75% HP: slight color darkening
- 50% HP: visible color change + vertex perturbation (±2cm)
- 25% HP: heavy darkening + larger perturbation (±5cm), looks cracked

Modify vertex positions and colors in the merged buffer. Set `needsUpdate = true`.

**Impact marks**: every bullet hit (even non-destroying) spawns 1–3 tiny debris chips + dust puff at hit point. Walls visibly degrade under sustained fire.

---

## 5. Damage Application (Unified)

### 5.1 Bullet → Panel

1. Identify panel from raycast faceIndex (§7.2)
2. Subtract weapon damage (after penetration reduction) from panel HP
3. Spawn impact debris + dust puff
4. Update damage visualization
5. If HP <= 0: destroy → zero vertices → structural check → break debris → nav update
6. Deduct penetration cost from bullet budget
7. If budget > 0: continue ray from far face with reduced damage

### 5.2 Explosion → Radius

1. Find all panels within blast radius
2. Per-panel damage: `baseDamage * (1 - distance/radius)²`
3. Process all destroyed panels (may trigger structural cascades)
4. Same formula for player and enemies in radius
5. Extra debris with high initial velocities
6. Terrain crater if ground contact
7. Camera shake + temporary tinnitus for nearby player

### 5.3 Bullet → Player

Enemy bullet reaches player through ballistics pipeline:
1. Apply remaining damage to player HP
2. Trigger screen feedback (§2.3)
3. Record damage direction

### 5.4 Bullet → Enemy

Player bullet hits enemy:
1. Apply remaining damage to enemy HP
2. Trigger hit reaction (existing gamefeel system)
3. Continue ray if penetration budget remains

### 5.5 The Cover-Destruction Feedback Loop

The central gameplay dynamic, emergent from the systems above:

1. Player takes position behind concrete wall
2. Enemies fire. Most bullets hit the wall (accuracy spread)
3. Panels take damage. Dust and debris fly. Player sees and hears impacts.
4. Panels break. Gaps appear.
5. Bullets pass through gaps or penetrate weakened panels
6. Player starts taking hits. Screen goes red.
7. Player must reposition to fresh cover.

No scripted event. No cover-health abstraction. Bullets hitting things.

---

## 6. Structural Integrity — Support Graph

### 6.1 Support Rules

1. Ground-floor panels touching terrain are **rooted** (inherent support).
2. A panel is **supported** if it is rooted, OR has at least one intact neighbor (left, right, or below in same wall) that is supported.
3. When a panel breaks, re-evaluate support for its neighbors.
4. Unsupported panels fall.

### 6.2 Algorithm

On panel destruction:
1. Remove panel from support graph
2. BFS outward from destroyed panel's former neighbors
3. Each reached panel: can it trace a path to any rooted panel?
4. Cannot → mark unsupported
5. Process unsupported top-to-bottom (visual cascade):
   - Zero vertices in wall mesh
   - Spawn as falling debris (§8.3)

### 6.3 Floor/Ceiling Collapse

- Floor panels supported by connection to wall panels at edges
- Wall destruction that removes all support → floor panels fall
- Falling floor panels damage things below
- When >60% of a floor's panels are destroyed, entire floor collapses

### 6.4 Performance

- Support checks only on destruction events
- BFS bounded by wall size (<100 panels typical)
- Batch all buffer updates per destruction event

---

## 7. Mesh Merging Strategy

### 7.1 Per-Wall Merged Meshes

Each wall = one `THREE.Mesh` with single `BufferGeometry`.

Destroyed panel: zero its vertex positions (degenerate triangles). Update buffer once.
Damaged panel: modify vertex colors and positions in-place. Update buffer once.

### 7.2 Buffer Layout

Each panel = 12 triangles = 36 vertices (non-indexed).

Lookup: `Map<panelId, { vertexStart, vertexCount }>` for O(1) access.

**Non-indexed** geometry. Indexed makes per-panel removal harder.

**Raycast hit → panel ID**: maintain reverse map from triangle index to panel. `faceIndex / 12` gives panel index within that wall. This is how §5.1 resolves hits.

### 7.3 Building-Level Grouping

Building = `THREE.Group` containing:
- Wall meshes (merged per wall)
- Floor meshes per story (destructible horizontal panel grids)
- Roof mesh (destructible)

---

## 8. Debris System

Over-the-top. Every fight leaves scars. Rubble accumulates.

### 8.1 Extruded Triangle Debris

1. Pick 3 random points within 1m × 1m panel face
2. Extrude perpendicular by 3–10cm
3. Result: triangular prism, 8 triangles

Material: `MeshLambertMaterial({ flatShading: true, color: <panel color ± variation> })`

### 8.2 Debris Physics

Simple ballistic. No inter-debris collision.

```javascript
{ mesh, velocity, angularVelocity, gravity: -9.8, settled: false, age: 0 }
```

Per frame: apply gravity, integrate position, apply rotation. On terrain contact: snap, mark settled.

Settled debris persists 30–60 seconds or until rubble-merged.

### 8.3 Falling Panels

Unsupported panels → break into 2–4 extruded triangles immediately → fall with gravity + slight drift → secondary shatter on ground contact → dust burst (10–20 expanding/fading spheres).

Falling pieces deal damage to player, enemies, other panels.

### 8.4 Object Pooling

- Pool: 500 debris meshes (configurable)
- Exhausted → recycle oldest settled

### 8.5 Rubble Accumulation

Every 5s: scan for clusters of >5 settled debris within 2m. Merge into static rubble mound (convex hull, averaged color). Rubble mound gets collision + nav grid registration. AI treats as low cover. Movement at 60% speed over rubble.

---

## 9. Building Templates

```javascript
{
  width: 8,
  height: 3,
  defaultType: 'concrete',
  overrides: [
    { x: 2, y: 0, type: 'wood' },   // door
    { x: 3, y: 1, type: 'glass' },  // window
    { x: 4, y: 1, type: 'glass' },  // window
  ]
}
```

Biome distributions:
- **Suburbs**: wood + glass + brick
- **Strip Mall**: glass storefronts, concrete/metal backs
- **Industrial**: metal + chain-link + concrete
- **Downtown**: concrete + glass + metal

---

## 10. Nav Grid Integration

On destruction:
1. Mark affected cells changed
2. Destroyed wall panel → check for traversable gap (≥1m wide, ground to 2m clear)
3. Rubble → slow terrain (higher cost)
4. Building collapse → impassable becomes rubble
5. Incremental update only

AI reactions:
- New openings = new flank routes (re-evaluate paths)
- Lost cover = trigger cover-seeking
- Rubble = new low cover options

---

## 11. Performance Budget

| Operation | Budget |
|-----------|--------|
| Ballistics raycasts (all entities) | < 2ms/frame |
| Panel damage + buffer updates | < 0.5ms/frame |
| Structural BFS | < 1ms per event |
| Debris physics (all active) | < 1ms/frame |
| Rubble merge | < 0.5ms (every 5s) |
| Nav grid update | < 0.5ms per event |

Limits:
- Max active debris: 200
- Max settled debris before merge: 300
- Max raycasts per frame: 50 (stagger enemy fire across frames)
- Pool exhausted → expire oldest

### 11.1 Raycast Optimization

- Stagger enemy fire (not all same frame)
- Set `Raycaster.far` to weapon range
- Pre-filter meshes by firing cone
- Frame budget counter; defer excess shots to next frame

---

## 12. Implementation Order

1. **Ballistics pipeline** (`src/ballistics.js`) — raycast bullet system with penetration. Player weapons fire through this first.
2. **Panel data structure** — types, HP, grid layout in building templates.
3. **Panel-grid wall construction** — refactor `buildings.js` to merged BufferGeometry from panel grids.
4. **Bullet → panel damage** — raycasts hit panels, reduce HP, damage visualization, impact debris.
5. **Panel destruction** — zero vertices, break debris (extruded triangles).
6. **Structural integrity** — support graph, BFS, cascading collapse.
7. **Falling panels** — detach, shatter on impact, damage below.
8. **Enemy ballistics** — enemies fire through same pipeline. Misses hit environment.
9. **Player health model** — HP, regen, screen effects, directional indicator.
10. **Fall damage** — velocity tracking, landing damage, feedback.
11. **Rubble accumulation** — merge, nav update, cover properties.
12. **Explosion support** — radius damage, debris, craters.
13. **Dust/particles** — impact puffs, collapse clouds, muzzle flash.

---

## 13. Design Principles

- **One system, not two.** Bullets are raycasts. Raycasts hit things. Things take damage. Panel, enemy, or player — just a branch in the hit resolver.
- **Destruction is the spectacle.** Every fight scars the environment. More debris, more dust, more drama.
- **Cover degrades, not depletes.** No cover-health abstraction. Cover is geometry. Geometry has panels. Panels have HP. Panels break. Bullets pass through.
- **Destruction reshapes tactics.** Blown walls = new routes. Rubble = new cover. Collapse = new terrain.
- **Partial buildings stand.** One wall gone, rest holds. Only widespread ground-floor destruction triggers collapse.
- **Performance is non-negotiable.** Pool, merge, budget, stagger. 60fps with 20+ enemies and active destruction.