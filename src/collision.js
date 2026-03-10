// ─── collision.js ────────────────────────────────────────────────────────────
// Player collision system — spatial hash, wall/floor/prop/stair colliders,
// bitmask-based destruction passability.
// See docs/collision-nav-spec.md for full specification.

// ─── AABB helpers ───────────────────────────────────────────────────────────

export function testAABBOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX &&
         a.minY < b.maxY && a.maxY > b.minY &&
         a.minZ < b.maxZ && a.maxZ > b.minZ;
}

function makeWorldAABB(local, wx, wy, wz) {
  return {
    minX: local.minX + wx, maxX: local.maxX + wx,
    minY: local.minY + wy, maxY: local.maxY + wy,
    minZ: local.minZ + wz, maxZ: local.maxZ + wz,
  };
}

// ─── Wall bitmask collision ─────────────────────────────────────────────────

/** Test player AABB (building-local) vs a WallCollider with bitmask.
 *  Returns true if any intact panel overlaps. */
export function testPlayerVsWall(pAABB, wall) {
  if (!testAABBOverlap(pAABB, wall.aabb)) return false;

  // Determine which axis the wall runs along
  const wallAxis = wall.axis; // 'h' = runs along X, 'v' = runs along Z
  const panelH = (wall.aabb.maxY - wall.aabb.minY) / wall.panelsHigh;

  // Compute which panel columns (along wall run) the player overlaps
  let p0, p1;
  if (wallAxis === 'h') {
    p0 = Math.floor(pAABB.minX - wall.gridStart);
    p1 = Math.floor(pAABB.maxX - wall.gridStart - 0.001);
  } else {
    p0 = Math.floor(pAABB.minZ - wall.gridStart);
    p1 = Math.floor(pAABB.maxZ - wall.gridStart - 0.001);
  }
  p0 = Math.max(0, p0);
  p1 = Math.min(wall.panelsWide - 1, p1);

  // Compute which panel rows (vertical) the player overlaps
  let py0 = Math.floor((pAABB.minY - wall.aabb.minY) / panelH);
  let py1 = Math.floor((pAABB.maxY - wall.aabb.minY - 0.001) / panelH);
  py0 = Math.max(0, py0);
  py1 = Math.min(wall.panelsHigh - 1, py1);

  // Check if any overlapped panel is intact
  for (let py = py0; py <= py1; py++) {
    for (let px = p0; px <= p1; px++) {
      if (wall.mask[py * wall.panelsWide + px] !== 0) return true;
    }
  }
  return false;
}

// ─── Floor void-grid collision ──────────────────────────────────────────────

/** Test player AABB (building-local) vs a FloorCollider with void grid.
 *  Returns true if the floor is solid at the player's XZ position. */
export function testPlayerVsFloor(pAABB, floor) {
  if (!testAABBOverlap(pAABB, floor.aabb)) return false;

  // Check void grid — player blocked only if at least one overlapped cell is solid
  const cx0 = Math.max(0, Math.floor(pAABB.minX));
  const cx1 = Math.min(floor.width - 1, Math.floor(pAABB.maxX - 0.001));
  const cz0 = Math.max(0, Math.floor(pAABB.minZ));
  const cz1 = Math.min(floor.depth - 1, Math.floor(pAABB.maxZ - 0.001));

  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      if (floor.voidGrid[cx * floor.depth + cz] === 0) return true; // solid
    }
  }
  return false; // all void — player passes through
}

// ─── CollisionWorld ─────────────────────────────────────────────────────────

class CollisionWorld {
  constructor() {
    this._cellSize = 4;
    this._hash = new Map();     // "cx,cz" → Set<buildingId>
    this._buildings = new Map(); // buildingId → BuildingCollisionData
    this._wallMap = new Map();  // "buildingId,wallKey" → WallCollider
  }

  addBuilding(id, data) {
    // data: { worldX, worldY, worldZ, footprintW, footprintD, totalH,
    //         wallColliders[], floorColliders[], propColliders[], stairColliders[] }
    const wx = data.worldX, wz = data.worldZ;
    const worldAABB = {
      minX: wx, maxX: wx + data.footprintW,
      minY: data.worldY, maxY: data.worldY + data.totalH,
      minZ: wz, maxZ: wz + data.footprintD,
    };
    data.worldAABB = worldAABB;
    this._buildings.set(id, data);

    // Insert into spatial hash
    const cs = this._cellSize;
    const x0 = Math.floor(worldAABB.minX / cs);
    const x1 = Math.floor(worldAABB.maxX / cs);
    const z0 = Math.floor(worldAABB.minZ / cs);
    const z1 = Math.floor(worldAABB.maxZ / cs);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = x + ',' + z;
        let set = this._hash.get(key);
        if (!set) { set = new Set(); this._hash.set(key, set); }
        set.add(id);
      }
    }

    // Index wall colliders for destruction lookup
    for (const wc of data.wallColliders) {
      this._wallMap.set(id + ',' + wc.wallKey, wc);
    }
  }

  removeBuilding(id) {
    const data = this._buildings.get(id);
    if (!data) return;

    // Remove from spatial hash
    const cs = this._cellSize;
    const bb = data.worldAABB;
    const x0 = Math.floor(bb.minX / cs);
    const x1 = Math.floor(bb.maxX / cs);
    const z0 = Math.floor(bb.minZ / cs);
    const z1 = Math.floor(bb.maxZ / cs);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = x + ',' + z;
        const set = this._hash.get(key);
        if (set) { set.delete(id); if (set.size === 0) this._hash.delete(key); }
      }
    }

    // Remove wall index entries
    for (const wc of data.wallColliders) {
      this._wallMap.delete(id + ',' + wc.wallKey);
    }

    this._buildings.delete(id);
  }

  /** Return array of { buildingId, data } for buildings whose world AABB overlaps query. */
  queryAABB(worldAABB) {
    const cs = this._cellSize;
    const x0 = Math.floor(worldAABB.minX / cs);
    const x1 = Math.floor(worldAABB.maxX / cs);
    const z0 = Math.floor(worldAABB.minZ / cs);
    const z1 = Math.floor(worldAABB.maxZ / cs);
    const seen = new Set();
    const results = [];
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const set = this._hash.get(x + ',' + z);
        if (!set) continue;
        for (const bid of set) {
          if (seen.has(bid)) continue;
          seen.add(bid);
          const bd = this._buildings.get(bid);
          if (bd && testAABBOverlap(worldAABB, bd.worldAABB)) {
            results.push({ buildingId: bid, data: bd });
          }
        }
      }
    }
    return results;
  }

  /** Update wall bitmask when a panel is destroyed. */
  updateWallMask(buildingId, wallKey, panelGridX, panelGridY, value) {
    const wc = this._wallMap.get(buildingId + ',' + wallKey);
    if (!wc) return;
    const idx = panelGridY * wc.panelsWide + panelGridX;
    if (idx >= 0 && idx < wc.mask.length) {
      wc.mask[idx] = value;
    }
  }

  /** Find and update the correct wall collider when a panel is destroyed.
   *  wallId from destruction.js: H-walls = z*10000+x, V-walls = x*10000+z
   *  panelRow = vertical row within the floor (gridY % 10) */
  /** panelGridY = f*10 + p from destruction.js */
  destroyPanel(buildingId, wallId, gridX, panelGridY) {
    const bd = this._buildings.get(buildingId);
    if (!bd) return;
    const posAlongWall = wallId % 10000;
    const floor = (panelGridY / 10) | 0;
    const panelRow = panelGridY % 10;
    for (const wc of bd.wallColliders) {
      if (wc.floor !== floor) continue;
      const localPos = posAlongWall - wc.gridStart;
      if (localPos < 0 || localPos >= wc.panelsWide) continue;
      const localRow = panelRow - wc.panelRowOffset;
      if (localRow < 0 || localRow >= wc.panelsHigh) continue;
      const idx = localRow * wc.panelsWide + localPos;
      if (idx >= 0 && idx < wc.mask.length) {
        wc.mask[idx] = 0;
      }
      return;
    }
  }
}

export const collisionWorld = new CollisionWorld();

// ─── Player collision resolution ────────────────────────────────────────────

/** Gather all collider AABBs (world-space) that overlap a world-space AABB.
 *  Returns array of { aabb (world), type, ref (original collider) }. */
export function gatherColliders(worldAABB) {
  const results = [];
  const buildings = collisionWorld.queryAABB(worldAABB);
  for (const { data } of buildings) {
    const wx = data.worldX, wy = data.worldY, wz = data.worldZ;

    // Transform query AABB to building-local
    const localAABB = {
      minX: worldAABB.minX - wx, maxX: worldAABB.maxX - wx,
      minY: worldAABB.minY - wy, maxY: worldAABB.maxY - wy,
      minZ: worldAABB.minZ - wz, maxZ: worldAABB.maxZ - wz,
    };

    // Walls — use bitmask test
    for (const wc of data.wallColliders) {
      if (testPlayerVsWall(localAABB, wc)) {
        // Find the blocking sub-region: use the wall AABB in world space
        results.push({
          aabb: makeWorldAABB(wc.aabb, wx, wy, wz),
          type: 'wall',
          ref: wc,
          wx, wy, wz,
        });
      }
    }

    // Floors & ceilings
    for (const fc of data.floorColliders) {
      if (testPlayerVsFloor(localAABB, fc)) {
        results.push({
          aabb: makeWorldAABB(fc.aabb, wx, wy, wz),
          type: 'floor',
          ref: fc,
          wx, wy, wz,
        });
      }
    }

    // Props — simple AABB
    for (const pc of data.propColliders) {
      if (testAABBOverlap(localAABB, pc)) {
        results.push({
          aabb: makeWorldAABB(pc, wx, wy, wz),
          type: 'prop',
          ref: pc,
          wx, wy, wz,
        });
      }
    }

    // Stairs — simple AABB
    for (const sc of data.stairColliders) {
      if (testAABBOverlap(localAABB, sc)) {
        results.push({
          aabb: makeWorldAABB(sc, wx, wy, wz),
          type: 'stair',
          ref: sc,
          wx, wy, wz,
        });
      }
    }
  }
  return results;
}

/** Precise re-test: does a player AABB (world-space) actually collide with a
 *  collider, considering bitmask/void-grid? Used after axis resolution to
 *  confirm collisions at the resolved position. */
export function confirmCollision(playerWorldAABB, col) {
  if (!testAABBOverlap(playerWorldAABB, col.aabb)) return false;

  const localAABB = {
    minX: playerWorldAABB.minX - col.wx,
    maxX: playerWorldAABB.maxX - col.wx,
    minY: playerWorldAABB.minY - col.wy,
    maxY: playerWorldAABB.maxY - col.wy,
    minZ: playerWorldAABB.minZ - col.wz,
    maxZ: playerWorldAABB.maxZ - col.wz,
  };

  if (col.type === 'wall') return testPlayerVsWall(localAABB, col.ref);
  if (col.type === 'floor') return testPlayerVsFloor(localAABB, col.ref);
  return testAABBOverlap(localAABB, col.ref); // prop/stair
}
