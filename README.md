# sprawl

Browser-based FPS. Wave-based tactical defense across an infinite procedural cityscape with destructible environments.

## Running

Open `index.html` in a browser. No build step, no install.

Click the canvas to start (pointer lock). Works in Chrome/Firefox with WebGL.

## Controls

| Key / Input | Action |
|---|---|
| WASD | Move |
| Mouse | Look |
| Left click | Shoot |
| Right click | Aim down sights |
| R | Reload |
| T | Toggle time of day |
| Shift | Sprint |

## Architecture

Plain ES modules under `src/`. Entry point: `index.html` → `src/main.js`.

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
├── weaponView.js    # First-person weapon rendering, recoil, bob
├── weaponDefs.js    # Weapon stats
├── nav.js           # Nav grid generation, A*, flow fields
├── cover.js         # Cover point detection and evaluation
├── hud.js           # DOM-based HUD overlay
├── audio.js         # Web Audio API sound effects
├── biomes.js        # Biome definitions and transitions
├── damageNumbers.js # Floating damage text
├── state.js         # Global game state
└── utils.js         # Seeded RNG, vector math, Perlin noise
```

Three.js r128 loaded via importmap from CDN — no local dependencies.

## Design

- [Game design spec](docs/design.md)
- [Building generation spec](docs/building-generation-spec.md)
- [Destruction spec](docs/destruction-spec.md)
- [Game feel spec](docs/gamefeel.md)

## Constraints

- No build tools, no npm, no bundler — plain ES modules only
- No textures — all visuals are geometry + material colors + vertex colors (BattleBit aesthetic)
- `MeshPhongMaterial` with `flatShading: true` for structures; `MeshLambertMaterial` for terrain
- All geometry is destructible: walls have health, buildings collapse, terrain deforms from explosions
- Seeded RNG — chunks are deterministic given `(cx, cz)`
- 60 fps target with 20+ active enemies; AI pathfinding budget ≤ 2ms/frame
