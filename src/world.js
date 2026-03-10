import * as THREE from 'three';
import { CHUNK_SIZE, RENDER_DIST } from './state.js';
import { seededRNG, chunkSeed, chunkKey } from './utils.js';
import { scene, camera } from './renderer.js';
import { spawnPickup, clearEnemiesInChunk, clearPickupsInChunk } from './enemies.js';
import { generateTerrainChunk, getHeight } from './terrain.js';
import { generateCoverPoints, removeCoverPoints } from './cover.js';
import { generateBuilding, spawnBuilding } from './buildings.js';
import { getBiomeAt, selectArchetype } from './biomes.js';
const _foundationMat = new THREE.MeshLambertMaterial({ color: 0x5a5a5a });

// ─── CHUNK MAP ─────────────────────────────────────────────
export const chunks = new Map();

export function generateChunk(cx, cz) {
  const key = chunkKey(cx, cz);
  if (chunks.has(key)) return;

  const group = new THREE.Group();
  const rng = seededRNG(chunkSeed(cx, cz));
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  // Heightmap terrain
  const terrainMesh = generateTerrainChunk(cx, cz);
  group.add(terrainMesh);

  const streetWidth = 8;

  // Collision boxes for this chunk
  const chunkColliders = [];

  // Buildings in 4 quadrants (avoid roads in center)
  const quadrants = [
    { x: ox + 4, z: oz + 4, w: CHUNK_SIZE / 2 - streetWidth / 2 - 4, h: CHUNK_SIZE / 2 - streetWidth / 2 - 4 },
    { x: ox + CHUNK_SIZE / 2 + streetWidth / 2, z: oz + 4, w: CHUNK_SIZE / 2 - streetWidth / 2 - 4, h: CHUNK_SIZE / 2 - streetWidth / 2 - 4 },
    { x: ox + 4, z: oz + CHUNK_SIZE / 2 + streetWidth / 2, w: CHUNK_SIZE / 2 - streetWidth / 2 - 4, h: CHUNK_SIZE / 2 - streetWidth / 2 - 4 },
    { x: ox + CHUNK_SIZE / 2 + streetWidth / 2, z: oz + CHUNK_SIZE / 2 + streetWidth / 2, w: CHUNK_SIZE / 2 - streetWidth / 2 - 4, h: CHUNK_SIZE / 2 - streetWidth / 2 - 4 },
  ];

  for (const quad of quadrants) {
    if (quad.w < 6 || quad.h < 6) continue;
    // One procedural building per quadrant (the generator controls its own size)
    const archetype = selectArchetype(getBiomeAt(cx, cz), rng);
    const maxW = Math.floor(quad.w) - 2;
    const maxD = Math.floor(quad.h) - 2;
    const buildingDef = generateBuilding(archetype, rng, {}, maxW, maxD);

    const bw = buildingDef.footprintW;
    const bd = buildingDef.footprintD;
    // Centre the building in the quadrant with ±1 cell jitter so buildings
    // cluster together rather than scattering across the full quadrant.
    const jitterX = Math.floor(rng() * 3) - 1;
    const jitterZ = Math.floor(rng() * 3) - 1;
    const bx = quad.x + Math.max(0, Math.floor((maxW - bw) / 2) + jitterX);
    const bz = quad.z + Math.max(0, Math.floor((maxD - bd) / 2) + jitterZ);

    // Sample terrain at 5 points; building sits on the peak so walls are always
    // above ground; a foundation skirt fills the gap down to the lowest point.
    const hSamples = [
      getHeight(bx,          bz),
      getHeight(bx + bw,     bz),
      getHeight(bx,          bz + bd),
      getHeight(bx + bw,     bz + bd),
      getHeight(bx + bw / 2, bz + bd / 2),
    ];
    const groundY = Math.max(...hSamples);
    const foundY  = Math.min(...hSamples) - 0.3; // sink slightly below lowest terrain

    const bGroup = spawnBuilding(buildingDef, bx, groundY, bz);
    group.add(bGroup);

    // Foundation skirt: solid concrete box from foundY up to just below groundY.
    // Top face stops 0.05m below groundY to avoid Z-fighting with terrain at the
    // corner sample points (which are exactly at groundY).
    if (groundY - foundY > 0.1) {
      const fh = groundY - foundY - 0.05;
      const fGeo = new THREE.BoxGeometry(bw, fh, bd);
      const fMesh = new THREE.Mesh(fGeo, _foundationMat);
      fMesh.position.set(bx + bw / 2, foundY + fh / 2, bz + bd / 2);
      fMesh.receiveShadow = true;
      group.add(fMesh);
    }

    const totalH = buildingDef.floors.length * buildingDef.heightPerFloor;
    chunkColliders.push({
      minX: bx, maxX: bx + bw,
      minZ: bz, maxZ: bz + bd,
      minY: groundY, maxY: groundY + totalH,
    });
  }

  // Spawn pickups
  if (rng() > 0.5) spawnPickup(ox + 10 + rng() * (CHUNK_SIZE - 20), oz + 10 + rng() * (CHUNK_SIZE - 20), 'health', key);
  if (rng() > 0.5) spawnPickup(ox + 10 + rng() * (CHUNK_SIZE - 20), oz + 10 + rng() * (CHUNK_SIZE - 20), 'ammo', key);

  scene.add(group);
  chunks.set(key, { group, colliders: chunkColliders });
  markCollidersDirty();

  // Generate cover points from building edges
  generateCoverPoints(chunkColliders, key, getAllColliders());
}

export function removeChunk(cx, cz) {
  const key = chunkKey(cx, cz);
  const chunk = chunks.get(key);
  if (!chunk) return;
  scene.remove(chunk.group);
  chunk.group.traverse(obj => { if (obj.geometry) obj.geometry.dispose(); });
  clearEnemiesInChunk(key);
  clearPickupsInChunk(key);
  removeCoverPoints(key);
  chunks.delete(key);
  markCollidersDirty();
}

export function updateChunks() {
  const pcx = Math.floor(camera.position.x / CHUNK_SIZE);
  const pcz = Math.floor(camera.position.z / CHUNK_SIZE);

  for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) {
    for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++) {
      generateChunk(pcx + dx, pcz + dz);
    }
  }

  for (const [key] of chunks) {
    const [cx, cz] = key.split(',').map(Number);
    if (Math.abs(cx - pcx) > RENDER_DIST + 1 || Math.abs(cz - pcz) > RENDER_DIST + 1) {
      removeChunk(cx, cz);
    }
  }
}

let _collidersCache = [];
let _collidersDirty = true;

export function markCollidersDirty() { _collidersDirty = true; }

export function getAllColliders() {
  if (!_collidersDirty) return _collidersCache;
  _collidersCache = [];
  for (const [, chunk] of chunks) _collidersCache.push(...chunk.colliders);
  _collidersDirty = false;
  return _collidersCache;
}
