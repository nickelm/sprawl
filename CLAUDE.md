# CLAUDE.md — sprawl

## Project

**sprawl** is a browser-based FPS built with Three.js. Wave-based tactical defense across an infinite procedural cityscape with destructible environments. See `docs/design.md` for full game design specification and `docs/gamefeel.md` for hit feedback, weapon heft, and sound design specs.

## Running

Open `index.html` in a browser. No build step. ES modules with importmap pointing to CDN-hosted Three.js (r128).

## Architecture

Single-page app, modular ES modules under `src/`. Entry point is `index.html` which imports `src/main.js`.

```
src/
├── main.js          # Game loop, initialization
├── renderer.js      # Three.js setup, lighting, fog, resize
├── player.js        # FPS controls, pointer lock, movement, collision, shooting
├── world.js         # Chunk management, building placement on terrain
├── terrain.js       # Heightmap generation (Perlin noise), vertex coloring, chunk stitching
├── buildings.js     # Building templates, wall segments, destruction state
├── destruction.js   # Destruction system, debris spawning, nav grid updates
├── enemies.js       # Enemy types, individual AI state machine
├── squads.js        # Squad-level coordination (flanking, suppression)
├── waves.js         # Wave system, phase transitions, difficulty scaling
├── weapons.js       # Weapon definitions, firing, reloading, ballistics
├── hud.js           # DOM-based HUD overlay
├── audio.js         # Web Audio API sound effects
├── nav.js           # Nav grid generation, A*, flow fields
├── biomes.js        # Biome definitions (suburbs, industrial, downtown, etc.), transitions
└── utils.js         # Seeded RNG, vector math, Perlin noise
```

## Hard Rules

- No build tools, no npm, no bundler. Plain ES modules only.
- **No textures.** Zero. All visuals are geometry + material colors + vertex colors. This is the BattleBit Remastered aesthetic: low-poly, flat-shaded, readable silhouettes.
- Use `MeshPhongMaterial` with `flatShading: true` for flat-shaded geometry. Use `MeshLambertMaterial` (no flatShading) for terrain and pickups. No PBR.
- **All geometry is destructible.** Walls are discrete segments with health. Buildings can collapse. Terrain deforms from explosions. Destruction changes the nav grid.
- Seeded RNG for all procedural generation. Chunks are deterministic given (cx, cz).
- HUD is DOM-based. Fonts: Share Tech Mono (data), Rajdhani (headings).
- Color palette: dark blues/grays (#2e3440, #3a3a4a, #434c5e) for structures, red (#e74c3c) for damage/enemies, orange (#f39c12) for ammo/UI accents, green (#2ecc71) for health, white for HUD text.

## Terrain

- Heightmap per chunk using layered Perlin noise
- Adjacent chunk edges share sample points — no seams
- Vertex colors for terrain: darker in low areas, lighter on ridges, subtle variation per biome
- Buildings snap to terrain height
- Explosions deform the heightfield (craters)

## Enemy AI

All enemies are ranged. Melee is a proximity fallback only (within ~2m).

**Individual AI is a state machine:** advance → take cover → peek and shoot → retreat → flank. Enemies must never walk through buildings or stand in the open.

**Squad AI:** Groups of 3-5 coordinate. One element suppresses while another advances. Squads can execute pincer movements.

**Pathfinding:** A* on nav grid derived from terrain + building footprints. Nav grid updates incrementally when destruction changes geometry. Budget: max 2ms/frame total for all AI pathfinding.

## Performance Targets

- 60fps with 20+ active enemies on mid-range hardware
- Chunk generation must not cause frame drops
- Pathfinding must not block the main thread
- Destruction debris should use object pooling

## Priority Order

1. Refactor to modules
2. Heightmap terrain with chunk stitching
3. Nav grid + A* pathfinding
4. Wave system with advance/defense phases
5. Enemy cover-seeking AI (state machine)
6. Destruction system (wall segments, building collapse, terrain craters)
7. Building interiors with rooftop access
8. Squad coordination AI
9. Weapon feel (recoil, bob, tracers, Web Audio)
10. Grenades (arc physics, explosions, crater creation)
11. City biomes (suburbs → strip mall → industrial → downtown)
12. Visual polish (street props, particles, lighting)