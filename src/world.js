import * as THREE from 'three';
import { CHUNK_SIZE, RENDER_DIST, pallets, weaponCrates } from './state.js';
import { seededRNG, chunkSeed, chunkKey } from './utils.js';
import { scene, camera } from './renderer.js';
import { spawnPickup, clearEnemiesInChunk, clearPickupsInChunk } from './enemies.js';
import { generateTerrainChunk, getHeight } from './terrain.js';
import { generateCoverPoints, removeCoverPoints } from './cover.js';
import { generateBuilding, spawnBuilding, removeLaddersForBuilding } from './buildings.js';
import { getBiomeAt, selectArchetype } from './biomes.js';
import { collisionWorld } from './collision.js';
import { registerBuildingInterior, unregisterBuildingInterior } from './nav.js';
import { clearBuilding } from './destruction.js';
const _foundationMat = new THREE.MeshLambertMaterial({ color: 0x5a5a5a });

// ─── AIRDROP PALLET ──────────────────────────────────────────
const _palletCrateMat  = new THREE.MeshPhongMaterial({ color: 0x4a5a3a, flatShading: true }); // olive drab
const _palletLidMat    = new THREE.MeshPhongMaterial({ color: 0x5a6a4a, flatShading: true }); // lighter olive
const _palletStrapMat  = new THREE.MeshPhongMaterial({ color: 0x3a3a2a, flatShading: true }); // dark strap
const _palletMarkerMat = new THREE.MeshPhongMaterial({ color: 0x3498db, flatShading: true, emissive: 0x1a4c6e }); // blue marker

function spawnPallet(x, z, ck) {
  const group = new THREE.Group();

  // Base crate
  const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.8), _palletCrateMat);
  crate.position.y = 0.25;
  crate.castShadow = true;
  crate.receiveShadow = true;
  group.add(crate);

  // Lid stripe
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.6), _palletLidMat);
  lid.position.y = 0.53;
  group.add(lid);

  // Cross straps
  const strap1 = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.04, 0.08), _palletStrapMat);
  strap1.position.y = 0.54;
  strap1.rotation.y = Math.PI * 0.15;
  group.add(strap1);
  const strap2 = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.04, 0.08), _palletStrapMat);
  strap2.position.y = 0.54;
  strap2.rotation.y = -Math.PI * 0.15;
  group.add(strap2);

  // Floating marker above crate
  const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.15), _palletMarkerMat);
  marker.position.y = 1.2;
  marker.name = 'marker';
  group.add(marker);

  const y = getHeight(x, z);
  group.position.set(x, y, z);
  scene.add(group);
  pallets.push({ mesh: group, chunkKey: ck, marker });
}

function clearPalletsInChunk(key) {
  for (let i = pallets.length - 1; i >= 0; i--) {
    if (pallets[i].chunkKey === key) {
      scene.remove(pallets[i].mesh);
      pallets.splice(i, 1);
    }
  }
}

export function updatePallets(dt) {
  const t = performance.now() * 0.003;
  for (const p of pallets) {
    p.marker.position.y = 1.2 + Math.sin(t) * 0.15;
    p.marker.rotation.y += dt * 1.5;
  }
}

// ─── WEAPON CRATES (Step 14a) ─────────────────────────────
const _crateMat    = new THREE.MeshPhongMaterial({ color: 0x5a4a2a, flatShading: true }); // dark crate
const _crateAccent = new THREE.MeshPhongMaterial({ color: 0xf39c12, flatShading: true, emissive: 0x7a4e09 }); // orange marker

export function spawnWeaponCrate(x, z, crateData) {
  const group = new THREE.Group();

  // Crate body
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 0.6), _crateMat);
  crate.position.y = 0.2;
  crate.castShadow = true;
  group.add(crate);

  // Orange accent stripe
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.06, 0.3), _crateAccent);
  stripe.position.y = 0.43;
  group.add(stripe);

  // Floating orange diamond marker
  const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), _crateAccent);
  marker.position.y = 1.0;
  marker.name = 'marker';
  group.add(marker);

  const y = getHeight(x, z);
  group.position.set(x, y, z);
  scene.add(group);
  weaponCrates.push({ mesh: group, marker, crateData, collected: false });
}

export function clearWeaponCrates() {
  for (const c of weaponCrates) scene.remove(c.mesh);
  weaponCrates.length = 0;
}

export function updateWeaponCrates(dt) {
  const t = performance.now() * 0.004;
  for (const c of weaponCrates) {
    if (c.collected) continue;
    c.marker.position.y = 1.0 + Math.sin(t) * 0.1;
    c.marker.rotation.y += dt * 2.0;
  }
}

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
  const buildingIds = [];

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
    if (bGroup.userData.buildingId !== undefined) buildingIds.push(bGroup.userData.buildingId);

    // Foundation skirt: solid concrete box from foundY up to groundY.
    // Extended +0.1m in X and Z to cover wall overhang at those edges.
    const foundH = groundY - foundY;
    if (foundH > 0.1) {
      const fGeo = new THREE.BoxGeometry(bw + 0.1, foundH, bd + 0.1);
      const fMesh = new THREE.Mesh(fGeo, _foundationMat);
      fMesh.position.set(bx + (bw + 0.1) / 2, foundY + foundH / 2, bz + (bd + 0.1) / 2);
      fMesh.receiveShadow = true;
      group.add(fMesh);

      // Register foundation collision (building-local coordinates)
      const bid = bGroup.userData.buildingId;
      if (bid !== undefined) {
        collisionWorld.addFoundation(bid, {
          minX: -0.05, maxX: bw + 0.05,
          minY: foundY - groundY, maxY: 0,
          minZ: -0.05, maxZ: bd + 0.05,
        });
      }
    }

    // Entry ramps/steps outside exterior doors on raised foundations
    if (bGroup.userData.buildingId !== undefined) {
      const gfp = buildingDef.floors[0]; // ground floor plan
      if (gfp && gfp.doors) {
        for (const dk of gfp.doors) {
          const parts = dk.split(':');
          const axis = parts[0];
          const dx = parseInt(parts[1], 10);
          const dz = parseInt(parts[2], 10);

          // Determine if this door is on a perimeter wall
          let outDirX = 0, outDirZ = 0;
          if (axis === 'h') {
            if (dz === 0) outDirZ = -1;                   // south wall
            else if (dz === gfp.depth) outDirZ = 1;       // north wall
            else continue; // interior door
          } else {
            if (dx === 0) outDirX = -1;                   // west wall
            else if (dx === gfp.width) outDirX = 1;       // east wall
            else continue; // interior door
          }

          // World position of the cell just outside the door
          let doorWorldX, doorWorldZ;
          if (axis === 'h') {
            doorWorldX = bx + dx + 0.5;
            doorWorldZ = bz + dz + (outDirZ < 0 ? -0.5 : 0.5);
          } else {
            doorWorldX = bx + dx + (outDirX < 0 ? -0.5 : 0.5);
            doorWorldZ = bz + dz + 0.5;
          }

          const terrainAtDoor = getHeight(doorWorldX, doorWorldZ);
          const delta = groundY - terrainAtDoor;
          if (delta <= 0.35) continue; // auto-step handles it

          // Generate steps descending from building floor to terrain
          const numSteps = Math.min(6, Math.ceil(delta / 0.3));
          const stepH = delta / numSteps;
          const stepRun = 0.4;
          const bid = bGroup.userData.buildingId;

          for (let s = 0; s < numSteps; s++) {
            const stepTopY = groundY - s * stepH;

            // Position: each step is further from the door
            let sx, sz, sw, sd;
            if (outDirZ !== 0) {
              sx = bx + dx;
              sz = outDirZ < 0
                ? bz + dz - (s + 1) * stepRun
                : bz + dz + s * stepRun;
              sw = 1.0; sd = stepRun;
            } else {
              sz = bz + dz;
              sx = outDirX < 0
                ? bx + dx - (s + 1) * stepRun
                : bx + dx + s * stepRun;
              sw = stepRun; sd = 1.0;
            }

            // Each step extends down to terrain at its actual position (not the door's)
            // Sink 0.15m below terrain so steps never float above sloped ground
            const localTerrainY = getHeight(sx + sw / 2, sz + sd / 2);
            const stepBotY = Math.min(terrainAtDoor, localTerrainY) - 0.15;

            // Visual mesh — extends from terrain to step top
            const visH = stepTopY - stepBotY;
            const sGeo = new THREE.BoxGeometry(sw, visH, sd);
            const sMesh = new THREE.Mesh(sGeo, _foundationMat);
            sMesh.position.set(sx + sw / 2, stepBotY + visH / 2, sz + sd / 2);
            sMesh.receiveShadow = true;
            group.add(sMesh);

            // Collision AABB (building-local coords)
            collisionWorld.addFoundation(bid, {
              minX: sx - bx, maxX: sx - bx + sw,
              minY: stepBotY - groundY, maxY: stepTopY - groundY,
              minZ: sz - bz, maxZ: sz - bz + sd,
            });
          }
        }
      }
    }

    // Register interior nav graph for AI pathfinding
    if (bGroup.userData.buildingId !== undefined) {
      registerBuildingInterior(bGroup.userData.buildingId, buildingDef, bx, groundY, bz);
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

  // Spawn airdrop pallet (loadout station) in the road corridor
  if (rng() > 0.4) {
    const px = ox + CHUNK_SIZE / 2 + (rng() - 0.5) * 6;
    const pz = oz + CHUNK_SIZE / 2 + (rng() - 0.5) * 6;
    spawnPallet(px, pz, key);
  }

  scene.add(group);
  chunks.set(key, { group, colliders: chunkColliders, buildingIds });
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
  for (const bid of chunk.buildingIds ?? []) {
    collisionWorld.removeBuilding(bid);
    removeLaddersForBuilding(bid);
    unregisterBuildingInterior(bid);
    clearBuilding(bid);
  }
  clearEnemiesInChunk(key);
  clearPickupsInChunk(key);
  clearPalletsInChunk(key);
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
