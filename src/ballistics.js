// ─── Unified Ballistics Pipeline ─────────────────────────────────────────────
// Single raycast per bullet. Handles penetration, wall damage, enemy/player hits.
import * as THREE from 'three';
import { collisionWorld } from './collision.js';
import { panels, getWallMeshesForBuildings, damagePanel } from './destruction.js';
import { spawnImpactDebris } from './debris.js';
import { enemies, PLAYER_HALF_W, PLAYER_HEIGHT, STATE } from './state.js';
import { camera } from './renderer.js';

const _raycaster = new THREE.Raycaster();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();

// ─── Hit result types ────────────────────────────────────────────────────────

/**
 * Fire a bullet through the unified ballistics pipeline.
 * @param {THREE.Vector3} origin - bullet origin
 * @param {THREE.Vector3} direction - normalized direction
 * @param {object} stats - weapon stats { damage, penetration, range }
 * @param {object} [options] - { excludePlayer, excludeEnemies }
 * @returns {object[]} array of HitResult: { type, point, normal, panelId?, enemy?, damage }
 */
export function fireBullet(origin, direction, stats, options = {}) {
  const results = [];
  let remainingPen = stats.penetration;
  let remainingDmg = stats.damage;
  const originalPen = stats.penetration;

  _rayOrigin.copy(origin);
  _rayDir.copy(direction);

  // Collect wall meshes near the ray via spatial hash
  const wallMeshes = collectWallMeshes(origin, direction, stats.range);

  // Find enemy hits along the ray (player-fired bullets)
  const enemyHits = options.excludeEnemies
    ? []
    : sphereCastEnemies(origin, direction, stats.range);

  // Find player hit (enemy-fired bullets)
  const playerHit = options.excludePlayer
    ? null
    : sphereCastPlayer(origin, direction, stats.range);

  // Raycast against wall meshes
  _raycaster.set(_rayOrigin, _rayDir);
  _raycaster.far = stats.range;
  const wallHits = wallMeshes.length > 0
    ? _raycaster.intersectObjects(wallMeshes, false)
    : [];

  // Merge all hits by distance, process in order
  // Build a unified sorted hit list
  const allHits = [];

  for (let i = 0; i < wallHits.length; i++) {
    allHits.push({ kind: 'wall', distance: wallHits[i].distance, data: wallHits[i] });
  }
  for (let i = 0; i < enemyHits.length; i++) {
    allHits.push({ kind: 'enemy', distance: enemyHits[i].distance, data: enemyHits[i] });
  }
  if (playerHit) {
    allHits.push({ kind: 'player', distance: playerHit.distance, data: playerHit });
  }

  allHits.sort((a, b) => a.distance - b.distance);

  for (const h of allHits) {
    if (remainingPen <= 0 || remainingDmg <= 0) break;

    if (h.kind === 'wall') {
      const hit = h.data;
      const mesh = hit.object;
      if (!mesh.userData.isWallMesh) continue;

      if (hit.faceIndex === undefined) continue;
      const panelIndex = (hit.faceIndex / 12) | 0;
      const panelIds = mesh.userData.panelIndexToId;
      if (!panelIds || panelIndex < 0 || panelIndex >= panelIds.length) continue;

      const panelId = panelIds[panelIndex];
      const panel = panels.get(panelId);
      if (!panel) continue;

      // Already destroyed — free passage
      if (panel.hp <= 0) continue;

      // Apply damage to panel
      const hitNormal = hit.face ? hit.face.normal.clone() : _rayDir.clone().negate();
      damagePanel(panelId, 1);

      // Spawn impact debris (tiny chips) at hit point
      spawnImpactDebris(hit.point, hitNormal, panel.type);

      results.push({
        type: 'panel',
        point: hit.point.clone(),
        normal: hitNormal,
        panelId,
        damage: remainingDmg,
      });

      // Deduct penetration cost
      remainingPen -= panel.penetrationCost;
      if (remainingPen <= 0) break;

      // Reduce damage proportionally
      remainingDmg = stats.damage * (remainingPen / originalPen);

    } else if (h.kind === 'enemy') {
      const enemyHit = h.data;
      results.push({
        type: 'enemy',
        point: enemyHit.point.clone(),
        normal: _rayDir.clone().negate(),
        enemy: enemyHit.enemy,
        damage: remainingDmg,
      });
      // Bullet stops on enemy hit
      break;

    } else if (h.kind === 'player') {
      results.push({
        type: 'player',
        point: h.data.point.clone(),
        normal: _rayDir.clone().negate(),
        damage: remainingDmg,
      });
      // Bullet stops on player hit
      break;
    }
  }

  return results;
}

// ─── Wall mesh collection ────────────────────────────────────────────────────

function collectWallMeshes(origin, direction, range) {
  // Build a broad AABB along the ray
  const endX = origin.x + direction.x * range;
  const endY = origin.y + direction.y * range;
  const endZ = origin.z + direction.z * range;
  const queryAABB = {
    minX: Math.min(origin.x, endX) - 1,
    maxX: Math.max(origin.x, endX) + 1,
    minY: Math.min(origin.y, endY) - 2,
    maxY: Math.max(origin.y, endY) + 2,
    minZ: Math.min(origin.z, endZ) - 1,
    maxZ: Math.max(origin.z, endZ) + 1,
  };

  const buildings = collisionWorld.queryAABB(queryAABB);
  if (buildings.length === 0) return [];

  const buildingIds = new Set(buildings.map(b => b.buildingId));
  return getWallMeshesForBuildings(buildingIds);
}

// ─── Sphere-cast enemy detection ─────────────────────────────────────────────

const ENEMY_RADIUS = 0.8;
const ENEMY_CENTER_Y_OFFSET = 1.0;

function sphereCastEnemies(origin, direction, range) {
  const hits = [];
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    const dist = origin.distanceTo(enemy.mesh.position);
    if (dist > range) continue;

    // Vector from origin to enemy center mass
    _tmpVec.copy(enemy.mesh.position);
    _tmpVec.y += ENEMY_CENTER_Y_OFFSET;
    _tmpVec.sub(origin);

    const proj = _tmpVec.dot(direction);
    if (proj < 0) continue;

    // Closest point on ray to enemy center
    const closestX = origin.x + direction.x * proj;
    const closestY = origin.y + direction.y * proj;
    const closestZ = origin.z + direction.z * proj;

    const enemyCenterX = enemy.mesh.position.x;
    const enemyCenterY = enemy.mesh.position.y + ENEMY_CENTER_Y_OFFSET;
    const enemyCenterZ = enemy.mesh.position.z;

    const dx = closestX - enemyCenterX;
    const dy = closestY - enemyCenterY;
    const dz = closestZ - enemyCenterZ;
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq < ENEMY_RADIUS * ENEMY_RADIUS) {
      hits.push({
        distance: proj,
        enemy,
        point: new THREE.Vector3(closestX, closestY, closestZ),
      });
    }
  }

  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

// ─── Sphere-cast player detection (for enemy bullets) ────────────────────────

const PLAYER_RADIUS = PLAYER_HALF_W; // 0.3m
const PLAYER_CENTER_Y_OFFSET = PLAYER_HEIGHT * 0.5; // chest height

function sphereCastPlayer(origin, direction, range) {
  if (STATE.dead || STATE.dying) return null;

  // Player center mass approximation
  const pcx = camera.position.x;
  const pcy = camera.position.y - (PLAYER_HEIGHT - PLAYER_CENTER_Y_OFFSET);
  const pcz = camera.position.z;

  _tmpVec.set(pcx - origin.x, pcy - origin.y, pcz - origin.z);

  const proj = _tmpVec.dot(direction);
  if (proj < 0 || proj > range) return null;

  const closestX = origin.x + direction.x * proj;
  const closestY = origin.y + direction.y * proj;
  const closestZ = origin.z + direction.z * proj;

  const dx = closestX - pcx;
  const dy = closestY - pcy;
  const dz = closestZ - pcz;
  const distSq = dx * dx + dy * dy + dz * dz;

  if (distSq < PLAYER_RADIUS * PLAYER_RADIUS) {
    return {
      distance: proj,
      point: new THREE.Vector3(closestX, closestY, closestZ),
    };
  }
  return null;
}
