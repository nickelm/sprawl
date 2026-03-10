# sprawl — Game Design Document

## Overview

**sprawl** is a browser-based FPS built with Three.js. Wave-based tactical defense across an infinite procedural cityscape. Modern Warfare 2's defense sequences crossed with ARMA overwatch gameplay, rendered in a BattleBit Remastered low-poly aesthetic.

## Visual Reference

**BattleBit Remastered** is the target look. Key characteristics:
- Low-poly geometry with no textures — all visual information comes from geometry shape, vertex colors, and material colors
- Readable silhouettes and clean forms
- Simple geometry that is fast to author procedurally
- Destructible environments — walls break, buildings collapse, cover degrades
- Terrain has real topography: hills, depressions, ridgelines

No textures anywhere. Color comes from materials and vertex colors only.

## Core Loop

Two alternating phases:

1. **Advance Phase** — Player moves through the city, scavenges ammo/supplies, picks a defensive position (rooftop, intersection, building interior, hilltop). Timer or distance-based trigger starts the next defense phase.

2. **Defense Phase** — Waves of enemies advance toward the player's position using cover, flanking, and suppression. Between waves: brief resupply/reposition window.

After surviving N waves at a position, the player must advance deeper into the city. The city changes character as you progress (see City Biomes below). No endpoint — pure survival with escalating difficulty.

## Terrain

Heightmap-based terrain per chunk using layered Perlin noise. Buildings and props snap to terrain height. Adjacent chunk edges must stitch seamlessly (shared edge samples).

Terrain properties:
- Gentle rolling hills in suburban areas, flatter in downtown/industrial
- Depressions and ridgelines that create natural defensive positions
- No textures — terrain color via vertex colors (darker in low areas, lighter on ridges, subtle green tint for grass areas)
- Terrain is part of the destruction system: craters from explosions lower the heightfield locally

## City Biomes

As the player progresses deeper into the city, the procedural generator transitions between biome types. Each biome has distinct building templates, density, and street patterns:

- **Suburbs** — Low-density, 1-2 story houses, wide streets, yards/fences, gentle hills. Open sightlines. Early game.
- **Strip Malls** — Commercial sprawl. Parking lots, single-story wide buildings, signage geometry. Medium density.
- **Industrial** — Warehouses, silos, loading docks, chain-link fences, flat terrain. Large open spaces between big structures.
- **Financial / Downtown** — Dense high-rises, narrow street canyons, plazas. Vertical gameplay — rooftops matter. Late game.
- **Mixed / Transitional** — Blends between adjacent biome types at boundaries.

Biome selection can be noise-based (large-scale Perlin) or progression-based (suburbs → strip mall → industrial → downtown as distance from origin increases). Probably a combination.

## Destruction System

All environment geometry is destructible. This is a core mechanic, not polish.

- **Walls** — Built from discrete segments. Bullets chip away health per segment; when health reaches zero, the segment breaks (geometry removed, debris particles spawned). This opens new sightlines and removes cover.
- **Buildings** — Structural integrity system: if enough ground-floor walls are destroyed, upper floors collapse (simplified — replace building mesh with rubble pile mesh). Creates new terrain features.
- **Props** — Cars, fences, barriers are destructible cover. They degrade visibly (color shift, geometry simplification) before breaking.
- **Terrain** — Explosions (grenades, RPGs) create craters by deforming the heightfield. Craters serve as improvised cover.

Destruction affects AI pathfinding — destroyed walls open new paths, collapsed buildings block old ones. The nav grid must update incrementally.

## Enemy Design

Military-style enemies. All enemies are ranged combatants. Melee only occurs as a proximity fallback (enemy within ~2m of player uses a melee attack).

### Enemy Types

- **Rifleman** — Standard infantry. Medium speed, medium health. Uses cover, peeks to shoot, advances when suppressed or flanking.
- **Flanker** — Faster, less armored. Tries to approach from the side or rear. Prioritizes positions the player isn't watching.
- **Heavy** — Slow, heavily armored. Suppressive fire (high rate of fire, lower accuracy). Pins the player down while others reposition.
- **RPG** — Appears in later waves. Fires explosive projectiles that damage terrain and structures. Area denial. Forces the player to reposition.

### AI Behavior

This is the most important system in the game. Enemies that stand in the open and shoot are boring. The AI must be tactically readable — the player should be able to see enemies making decisions and react to them.

**Individual behaviors (state machine):**
- Advance: move toward objective using cover-to-cover movement
- Take cover: evaluate nearby geometry for line-of-sight blocking relative to player position
- Peek and shoot: lean out from cover, fire burst, return to cover
- Retreat: fall back to previous cover position when health is low
- Flank: pathfind to a position that has line-of-sight to player but is not in the player's current facing direction
- Melee: proximity fallback when within ~2m

**Squad behaviors (groups of 3-5):**
- Coordinated advance: one element suppresses, another moves
- Pincer: squad splits and approaches from two directions
- Rally: regroup after taking casualties

**Pathfinding:**
- A* on a navigation grid derived from terrain heightmap + building footprints
- Nav grid must update when destruction changes the environment
- Pathfinding budget: max 2ms per frame total across all enemies
- Consider flow fields for large numbers of enemies moving to the same target

## Wave System

- **Wave 1-3:** Riflemen only, 5-8 enemies, approach from one direction
- **Wave 4-6:** Add flankers, enemies approach from two directions, 10-15 enemies
- **Wave 7-9:** Add heavies, three approach directions, 15-20 enemies
- **Wave 10+:** Full mix including RPG, all directions, 20+ enemies, destruction escalates
- **Between waves:** 15-20 second window. Partial ammo resupply. Health regenerates slowly (not to full).

## Player Capabilities

- **Assault rifle** — Primary weapon. 30-round magazine, semi-auto or full-auto
- **Grenades** — Throwable with arc preview. Explosion damages terrain + enemies. Limited supply (2-3, resupplied between waves)
- **Sprint** — Faster movement, no shooting
- **Rooftop access** — Enter buildings to reach upper floors/roof. Simplified: interact with door → stairwell → roof. Provides elevation advantage.
- **Future:** Secondary weapons (sniper, shotgun), claymores, binoculars/marking

## Overwatch / Elevation

- Player can access rooftops and upper building floors
- Height advantage: better sightlines, harder for enemies to hit
- Enemies can also enter buildings and shoot from windows
- Rooftop positions are powerful but exposed to RPG fire in later waves — forces repositioning

## Vehicle Mode (Future)

Helicopter overwatch as a separate game mode. Stretch goal. Don't architect against it, but don't build for it yet.

## Technical Priorities (Ordered)

1. **Refactor to modules** — Break monolithic HTML into ES module structure
2. **Heightmap terrain** — Perlin noise terrain with chunk stitching, vertex-colored
3. **Pathfinding** — Nav grid on terrain + buildings, A* implementation
4. **Wave system** — Phase transitions, wave spawning, difficulty curve
5. **Enemy cover AI** — Cover evaluation, peek-and-shoot, state machine
6. **Destruction** — Wall segments, building collapse, terrain deformation
7. **Building interiors** — Enterable buildings with floors, windows, stairs
8. **Squad AI** — Coordinated flanking, suppression, pincer moves
9. **Weapon feel** — Recoil, weapon bob, tracers, sound (Web Audio API)
10. **Grenades** — Arc physics, explosion, area damage, crater creation
11. **City biomes** — Biome-specific building templates, density transitions
12. **Visual polish** — Street props, particles, lighting refinement

## File Structure

```
sprawl/
├── index.html
├── CLAUDE.md
├── docs/
│   └── design.md          # This file
├── src/
│   ├── main.js
│   ├── renderer.js
│   ├── player.js
│   ├── world.js            # Chunk gen, terrain, building placement
│   ├── terrain.js          # Heightmap generation, vertex coloring
│   ├── buildings.js        # Building templates, destruction state
│   ├── destruction.js      # Destruction system, debris, updates
│   ├── enemies.js          # Enemy types, individual AI
│   ├── squads.js           # Squad-level coordination
│   ├── waves.js            # Wave system, spawning, difficulty
│   ├── weapons.js          # Weapon definitions, ballistics
│   ├── hud.js
│   ├── audio.js
│   ├── nav.js              # Nav grid, A*, flow fields
│   ├── biomes.js           # Biome definitions, transitions
│   └── utils.js
└── README.md
```

## Constraints

- Modern browser, no build step. ES modules with importmap.
- 60fps with 20+ active enemies on mid-range hardware
- No external assets beyond CDN-hosted Three.js
- No textures. Geometry + material/vertex colors only.
- Single-player only