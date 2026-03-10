// ─── COVER POINT SYSTEM ───────────────────────────────────
// Generates, caches, scores, and reserves cover points derived
// from building AABB colliders.

import { COVER_SEARCH_RADIUS } from './state.js';
import { hasLineOfSight } from './nav.js';

const COVER_OFFSET = 1.0;          // how far from building edge
const MIN_COVER_SPACING = 2.0;     // minimum distance between cover points
const EDGE_POINT_INTERVAL = 4.0;   // extra edge points every N units on long walls

// ─── CACHE ────────────────────────────────────────────────
const coverCache = new Map();   // chunkKey → CoverPoint[]
const reserved = new Set();     // "x,z" strings of reserved points

// ─── GENERATION ───────────────────────────────────────────

function pointKey(x, z) {
  return `${x.toFixed(1)},${z.toFixed(1)}`;
}

function collidesAny(x, z, colliders, radius) {
  for (const c of colliders) {
    if (x + radius > c.minX && x - radius < c.maxX &&
        z + radius > c.minZ && z - radius < c.maxZ) {
      return true;
    }
  }
  return false;
}

/**
 * Generate cover points for a set of building colliders belonging to a chunk.
 * Call once per chunk on creation.
 */
export function generateCoverPoints(colliders, chunkKey, allColliders) {
  const points = [];
  const usedKeys = new Set();

  for (let ci = 0; ci < colliders.length; ci++) {
    const c = colliders[ci];
    const midX = (c.minX + c.maxX) / 2;
    const midZ = (c.minZ + c.maxZ) / 2;
    const w = c.maxX - c.minX;
    const d = c.maxZ - c.minZ;

    // Candidate positions: 4 corners + 4 edge midpoints
    const candidates = [
      // Corners (offset diagonally)
      { x: c.minX - COVER_OFFSET, z: c.minZ - COVER_OFFSET },
      { x: c.maxX + COVER_OFFSET, z: c.minZ - COVER_OFFSET },
      { x: c.minX - COVER_OFFSET, z: c.maxZ + COVER_OFFSET },
      { x: c.maxX + COVER_OFFSET, z: c.maxZ + COVER_OFFSET },
      // Edge midpoints (offset perpendicular)
      { x: midX, z: c.minZ - COVER_OFFSET },
      { x: midX, z: c.maxZ + COVER_OFFSET },
      { x: c.minX - COVER_OFFSET, z: midZ },
      { x: c.maxX + COVER_OFFSET, z: midZ },
    ];

    // Extra edge points on long walls
    if (w > EDGE_POINT_INTERVAL + 2) {
      const steps = Math.floor(w / EDGE_POINT_INTERVAL);
      for (let s = 1; s < steps; s++) {
        const ex = c.minX + s * EDGE_POINT_INTERVAL;
        candidates.push({ x: ex, z: c.minZ - COVER_OFFSET });
        candidates.push({ x: ex, z: c.maxZ + COVER_OFFSET });
      }
    }
    if (d > EDGE_POINT_INTERVAL + 2) {
      const steps = Math.floor(d / EDGE_POINT_INTERVAL);
      for (let s = 1; s < steps; s++) {
        const ez = c.minZ + s * EDGE_POINT_INTERVAL;
        candidates.push({ x: c.minX - COVER_OFFSET, z: ez });
        candidates.push({ x: c.maxX + COVER_OFFSET, z: ez });
      }
    }

    for (const pt of candidates) {
      const key = pointKey(pt.x, pt.z);
      if (usedKeys.has(key)) continue;

      // Skip if inside another building
      if (collidesAny(pt.x, pt.z, allColliders || colliders, 0.45)) continue;

      // Minimum spacing from existing points
      let tooClose = false;
      for (const existing of points) {
        const dx = existing.x - pt.x;
        const dz = existing.z - pt.z;
        if (dx * dx + dz * dz < MIN_COVER_SPACING * MIN_COVER_SPACING) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      usedKeys.add(key);
      points.push({ x: pt.x, z: pt.z });
    }
  }

  coverCache.set(chunkKey, points);
}

/**
 * Remove cached cover points for a chunk.
 */
export function removeCoverPoints(chunkKey) {
  coverCache.delete(chunkKey);
}

// ─── QUERYING ─────────────────────────────────────────────

/**
 * Get all cover points across all loaded chunks.
 */
export function getAllCoverPoints() {
  const all = [];
  for (const [, pts] of coverCache) {
    for (const p of pts) all.push(p);
  }
  return all;
}

/**
 * Find the best cover point for an enemy hiding from the player.
 * Returns {x, z} or null if nothing suitable.
 *
 * @param {Object} enemyPos  - {x, z}
 * @param {Object} playerPos - {x, z}
 * @param {Array}  colliders - building AABBs
 * @param {number} searchRadius - max distance from enemy
 * @param {boolean} retreating - if true, prefer cover away from player
 */
export function findBestCover(enemyPos, playerPos, colliders, searchRadius, retreating) {
  const allPts = getAllCoverPoints();
  const sr2 = (searchRadius || COVER_SEARCH_RADIUS) * (searchRadius || COVER_SEARCH_RADIUS);

  let bestScore = Infinity;
  let bestPt = null;

  for (const pt of allPts) {
    // Distance from enemy
    const edx = pt.x - enemyPos.x;
    const edz = pt.z - enemyPos.z;
    const eDist2 = edx * edx + edz * edz;
    if (eDist2 > sr2) continue;

    // Must block LOS to player
    if (hasLineOfSight(pt.x, pt.z, playerPos.x, playerPos.z, colliders)) continue;

    const eDist = Math.sqrt(eDist2);

    // Distance from player
    const pdx = pt.x - playerPos.x;
    const pdz = pt.z - playerPos.z;
    const pDist = Math.sqrt(pdx * pdx + pdz * pdz);

    // Scoring
    let score = eDist; // prefer close cover

    if (retreating) {
      // Prefer cover that is farther from the player than enemy currently is
      const enemyPlayerDx = enemyPos.x - playerPos.x;
      const enemyPlayerDz = enemyPos.z - playerPos.z;
      const enemyPlayerDist = Math.sqrt(enemyPlayerDx * enemyPlayerDx + enemyPlayerDz * enemyPlayerDz);
      if (pDist < enemyPlayerDist) {
        score += 30; // penalize cover closer to player than enemy
      }
    } else {
      // Prefer cover that keeps enemy in engagement range (not too far)
      if (pDist > 35) score += (pDist - 35) * 2;
      // Slight preference for cover closer to player (aggressive positioning)
      score += pDist * 0.1;
    }

    // Soft penalty for reserved points
    const key = pointKey(pt.x, pt.z);
    if (reserved.has(key)) score += 15;

    if (score < bestScore) {
      bestScore = score;
      bestPt = pt;
    }
  }

  return bestPt;
}

/**
 * Find a cover point suitable for flanking — at an angle from the
 * player's view direction.
 *
 * @param {Object} enemyPos  - {x, z}
 * @param {Object} playerPos - {x, z}
 * @param {number} playerYaw - player's facing direction (radians)
 * @param {Array}  colliders - building AABBs
 */
export function findFlankCover(enemyPos, playerPos, playerYaw, colliders) {
  const allPts = getAllCoverPoints();
  const sr2 = COVER_SEARCH_RADIUS * COVER_SEARCH_RADIUS * 4; // wider search for flanking

  // Player's facing direction vector
  const facingX = Math.sin(playerYaw);
  const facingZ = Math.cos(playerYaw);

  let bestScore = Infinity;
  let bestPt = null;

  for (const pt of allPts) {
    const edx = pt.x - enemyPos.x;
    const edz = pt.z - enemyPos.z;
    const eDist2 = edx * edx + edz * edz;
    if (eDist2 > sr2) continue;

    // Must block LOS to player
    if (hasLineOfSight(pt.x, pt.z, playerPos.x, playerPos.z, colliders)) continue;

    // Angle from player to this cover point relative to player's facing
    const toPtX = pt.x - playerPos.x;
    const toPtZ = pt.z - playerPos.z;
    const toPtLen = Math.sqrt(toPtX * toPtX + toPtZ * toPtZ);
    if (toPtLen < 5) continue; // too close to player

    const dot = (toPtX * facingX + toPtZ * facingZ) / toPtLen;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));

    // Want angle > 60° (π/3) from player's facing — that's the flank zone
    if (angle < Math.PI / 3) continue;

    const eDist = Math.sqrt(eDist2);
    let score = eDist;
    // Prefer positions more to the side/rear
    score -= angle * 5;

    const key = pointKey(pt.x, pt.z);
    if (reserved.has(key)) score += 15;

    if (score < bestScore) {
      bestScore = score;
      bestPt = pt;
    }
  }

  return bestPt;
}

// ─── RESERVATION ──────────────────────────────────────────

export function reserveCover(x, z) {
  reserved.add(pointKey(x, z));
}

export function releaseCover(x, z) {
  reserved.delete(pointKey(x, z));
}

/**
 * Find an intermediate cover point between enemy and player that
 * is closer to the player than the enemy currently is. Used for
 * cover-to-cover advance.
 */
export function findAdvanceCover(enemyPos, playerPos, colliders) {
  const allPts = getAllCoverPoints();

  const epDx = playerPos.x - enemyPos.x;
  const epDz = playerPos.z - enemyPos.z;
  const epDist = Math.sqrt(epDx * epDx + epDz * epDz);

  let bestScore = Infinity;
  let bestPt = null;

  for (const pt of allPts) {
    // Distance from enemy
    const edx = pt.x - enemyPos.x;
    const edz = pt.z - enemyPos.z;
    const eDist2 = edx * edx + edz * edz;
    if (eDist2 > 40 * 40) continue; // search radius for advance

    // Distance from player
    const pdx = pt.x - playerPos.x;
    const pdz = pt.z - playerPos.z;
    const pDist = Math.sqrt(pdx * pdx + pdz * pdz);

    // Must be closer to player than enemy is (advancing)
    if (pDist >= epDist - 3) continue;
    // But not too close to player
    if (pDist < 8) continue;

    // Must block LOS to player
    if (hasLineOfSight(pt.x, pt.z, playerPos.x, playerPos.z, colliders)) continue;

    const eDist = Math.sqrt(eDist2);
    let score = eDist + pDist * 0.3;

    const key = pointKey(pt.x, pt.z);
    if (reserved.has(key)) score += 15;

    if (score < bestScore) {
      bestScore = score;
      bestPt = pt;
    }
  }

  return bestPt;
}
