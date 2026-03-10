import * as THREE from 'three';
import {
  STATE, enemies, pickups, enemyBullets,
  ENEMY_MELEE_RANGE, ENEMY_SHOOT_RANGE, ENEMY_MELEE_DAMAGE, ENEMY_BULLET_DAMAGE,
  ENGAGE_RANGE, RETREAT_HEALTH_PCT, PEEK_DURATION, PEEK_OFFSET,
  COVER_WAIT_MIN, COVER_WAIT_MAX, COVER_TIMEOUT, COVER_SEARCH_RADIUS,
} from './state.js';
import { scene, camera, enemyMeleeMat, enemyRangedMat, healthPickupMat, ammoPickupMat } from './renderer.js';
import { getHeight } from './terrain.js';
import { takeDamage, updateHUD, addKillFeed } from './hud.js';
import { findPath, hasLineOfSight } from './nav.js';
import { getAllColliders } from './world.js';
import {
  findBestCover, findAdvanceCover, findFlankCover,
  reserveCover, releaseCover,
} from './cover.js';

export { hasLineOfSight };

// ─── CONSTANTS ─────────────────────────────────────────────
const ENEMY_RADIUS = 0.45;
const PATH_REFRESH = 2.0;   // seconds between path recalculations
const WAYPOINT_REACH = 1.5; // distance to consider a waypoint reached
const DAMAGE_REACT_MS = 1500; // react to damage within this window
const PEEK_LEAN_TIME = 0.3;   // seconds to lean out / back
const PEEK_FIRE_START = 0.3;  // start firing after this
const PEEK_FIRE_END = 1.0;    // stop firing at this
const BURST_INTERVAL = 300;   // ms between shots in a burst

// ─── BUILDING COLLISION ─────────────────────────────────────
function enemyCollidesWithBuilding(x, z, colliders) {
  for (const c of colliders) {
    if (x + ENEMY_RADIUS > c.minX && x - ENEMY_RADIUS < c.maxX &&
        z + ENEMY_RADIUS > c.minZ && z - ENEMY_RADIUS < c.maxZ) {
      return true;
    }
  }
  return false;
}

// ─── LINE OF SIGHT (imported from nav.js, re-exported) ────

// Check if a bullet position is inside any building collider
function bulletHitsBuilding(x, y, z, colliders) {
  for (const c of colliders) {
    if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ &&
        y > c.minY && y < c.maxY) {
      return true;
    }
  }
  return false;
}

// ─── SHARED BULLET GEOMETRY ────────────────────────────────
const bulletGeo = new THREE.SphereGeometry(0.05, 4, 4);
const enemyBulletMat = new THREE.MeshBasicMaterial({ color: 0xff4444 });
const _bulletPool = [];

// ─── MOVEMENT HELPER ──────────────────────────────────────
function moveEnemy(enemy, targetX, targetZ, speed, dt, colliders) {
  const dx = targetX - enemy.mesh.position.x;
  const dz = targetZ - enemy.mesh.position.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.01) return false;

  const nx = enemy.mesh.position.x + (dx / dist) * speed * dt;
  const nz = enemy.mesh.position.z + (dz / dist) * speed * dt;
  let moved = false;
  if (!enemyCollidesWithBuilding(nx, enemy.mesh.position.z, colliders)) {
    enemy.mesh.position.x = nx;
    moved = true;
  }
  if (!enemyCollidesWithBuilding(enemy.mesh.position.x, nz, colliders)) {
    enemy.mesh.position.z = nz;
    moved = true;
  }
  enemy.mesh.position.y = getHeight(enemy.mesh.position.x, enemy.mesh.position.z);
  return moved;
}

// ─── PATH FOLLOWING ───────────────────────────────────────
function followPath(enemy, dt, colliders) {
  if (enemy.path.length === 0 || enemy.pathNode >= enemy.path.length) return false;

  const wp = enemy.path[enemy.pathNode];
  const dx = wp.x - enemy.mesh.position.x;
  const dz = wp.z - enemy.mesh.position.z;
  if (Math.sqrt(dx * dx + dz * dz) < WAYPOINT_REACH) {
    enemy.pathNode++;
    if (enemy.pathNode >= enemy.path.length) return false;
  }

  if (enemy.pathNode < enemy.path.length) {
    const t = enemy.path[enemy.pathNode];
    moveEnemy(enemy, t.x, t.z, enemy.speed, dt, colliders);
    return true;
  }
  return false;
}

// ─── PATHFIND TO TARGET ───────────────────────────────────
function pathTo(enemy, tx, tz, colliders) {
  const result = findPath(
    { x: enemy.mesh.position.x, z: enemy.mesh.position.z },
    { x: tx, z: tz },
    colliders
  );
  if (result) {
    enemy.path = result;
    enemy.pathNode = 0;
    enemy.pathTimer = PATH_REFRESH;
    return true;
  }
  enemy.path = [];
  enemy.pathTimer = 0.5;
  return false;
}

// ─── LEG ANIMATION ────────────────────────────────────────
function animateLegs(enemy, dt, moving) {
  if (moving) {
    enemy.walkPhase += dt * enemy.speed * 3;
    enemy.legL.rotation.x =  Math.sin(enemy.walkPhase) * 0.5;
    enemy.legR.rotation.x = -Math.sin(enemy.walkPhase) * 0.5;
  } else {
    enemy.legL.rotation.x *= 0.9;
    enemy.legR.rotation.x *= 0.9;
  }
}

// ─── STATE HELPERS ────────────────────────────────────────
function recentlyDamaged(enemy, now) {
  return enemy.lastDamagedTime && (now - enemy.lastDamagedTime < DAMAGE_REACT_MS);
}

function shouldRetreat(enemy) {
  return enemy.health <= enemy.maxHealth * RETREAT_HEALTH_PCT;
}

function changeState(enemy, newState) {
  // Release cover when leaving cover-based states
  if ((enemy.aiState === 'IN_COVER' || enemy.aiState === 'PEEK_SHOOT') && enemy.coverTarget) {
    releaseCover(enemy.coverTarget.x, enemy.coverTarget.z);
  }
  enemy.aiState = newState;
  enemy.aiStateTimer = 0;
  enemy.peekOffset = 0;
  enemy.burstCount = 0;
}

// ─── ENEMY SPAWNING ────────────────────────────────────────
export function spawnEnemy(x, z, isRanged, ck) {
  const mat = isRanged ? enemyRangedMat : enemyMeleeMat;

  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.0, 0.4), mat);
  body.position.y = 1.1;
  group.add(body);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), mat);
  head.position.y = 1.8;
  group.add(head);

  const legGeo = new THREE.BoxGeometry(0.25, 0.6, 0.3);
  const legL = new THREE.Mesh(legGeo, mat);
  legL.position.set(-0.17, 0.3, 0);
  group.add(legL);

  const legR = new THREE.Mesh(legGeo, mat);
  legR.position.set(0.17, 0.3, 0);
  group.add(legR);

  if (isRanged) {
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.6),
      new THREE.MeshLambertMaterial({ color: 0x333333 })
    );
    gun.position.set(0.4, 1.1, 0.2);
    group.add(gun);
  }

  group.position.set(x, getHeight(x, z), z);
  scene.add(group);

  const enemy = {
    mesh: group,
    isRanged,
    health: isRanged ? 30 : 50,
    maxHealth: isRanged ? 30 : 50,
    speed: isRanged ? 2.5 : 4,
    chunkKey: ck,
    lastAttack: 0,
    attackCooldown: isRanged ? 1500 : 800,
    legL, legR,
    walkPhase: Math.random() * Math.PI * 2,
    alive: true,
    path: [],
    pathNode: 0,
    pathTimer: Math.random() * PATH_REFRESH,
    // Cover AI state
    aiState: 'ADVANCE',
    aiStateTimer: 0,
    coverTarget: null,
    previousCover: null,
    peekDir: Math.random() > 0.5 ? 1 : -1,
    peekTimer: 0,
    peekOffset: 0,
    burstCount: 0,
    lastDamagedTime: 0,
    coverSearchCooldown: 0,
    // Hit flinch
    flinchX: 0,
    flinchZ: 0,
    flinchTimer: 0,
    flinchDuration: 0,
    // Death animation
    dying: false,
    deathTimer: 0,
    deathSpinStart: 0,
    deathY: 0,
  };
  enemies.push(enemy);
  return enemy;
}

// ─── PICKUP SPAWNING ────────────────────────────────────────
export function spawnPickup(x, z, type, ck) {
  const geo = type === 'health'
    ? new THREE.OctahedronGeometry(0.4)
    : new THREE.BoxGeometry(0.5, 0.3, 0.3);
  const mat = type === 'health' ? healthPickupMat : ammoPickupMat;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, getHeight(x, z) + 0.8, z);
  scene.add(mesh);
  pickups.push({ mesh, type, chunkKey: ck });
}

// ─── CHUNK CLEANUP ─────────────────────────────────────────
export function clearEnemiesInChunk(key) {
  for (let i = enemies.length - 1; i >= 0; i--) {
    if (enemies[i].chunkKey === key) {
      // Release any cover reservation
      if (enemies[i].coverTarget) {
        releaseCover(enemies[i].coverTarget.x, enemies[i].coverTarget.z);
      }
      scene.remove(enemies[i].mesh);
      enemies.splice(i, 1);
    }
  }
}

export function clearPickupsInChunk(key) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    if (pickups[i].chunkKey === key) {
      scene.remove(pickups[i].mesh);
      pickups.splice(i, 1);
    }
  }
}

export function clearAllEnemyBullets() {
  for (const b of enemyBullets) {
    b.mesh.visible = false;
    _bulletPool.push(b);
  }
  enemyBullets.length = 0;
}

// ─── ENEMY BULLET SPAWNING ─────────────────────────────────
function spawnEnemyBullet(enemy) {
  const dir = camera.position.clone().sub(enemy.mesh.position).normalize();
  dir.x += (Math.random() - 0.5) * 0.15;
  dir.y += (Math.random() - 0.5) * 0.1;
  dir.z += (Math.random() - 0.5) * 0.15;
  dir.normalize();

  let b = _bulletPool.pop();
  if (!b) {
    b = { mesh: new THREE.Mesh(bulletGeo, enemyBulletMat), velocity: new THREE.Vector3(), life: 0 };
    scene.add(b.mesh);
  } else {
    b.mesh.visible = true;
  }
  b.mesh.position.copy(enemy.mesh.position);
  b.mesh.position.y += 1.2;
  b.velocity.copy(dir).multiplyScalar(25);
  b.life = 3;
  enemyBullets.push(b);
}

// ─── RANGED AI STATE MACHINE ──────────────────────────────

function updateAdvance(enemy, dt, now, colliders) {
  const px = camera.position.x, pz = camera.position.z;
  const ex = enemy.mesh.position.x, ez = enemy.mesh.position.z;
  const dx = px - ex, dz = pz - ez;
  const dist = Math.sqrt(dx * dx + dz * dz);

  enemy.aiStateTimer += dt;

  // Transition: took damage → seek cover immediately
  if (recentlyDamaged(enemy, now)) {
    changeState(enemy, 'SEEK_COVER');
    return;
  }

  // Transition: in engagement range → seek cover
  if (dist < ENGAGE_RANGE) {
    changeState(enemy, 'SEEK_COVER');
    return;
  }

  // Try cover-to-cover advance when getting closer (< 40m)
  if (dist < 40 && enemy.coverSearchCooldown <= 0) {
    const advCover = findAdvanceCover(
      { x: ex, z: ez }, { x: px, z: pz }, colliders
    );
    if (advCover) {
      enemy.coverTarget = advCover;
      reserveCover(advCover.x, advCover.z);
      pathTo(enemy, advCover.x, advCover.z, colliders);
      changeState(enemy, 'SEEK_COVER');
      // Keep coverTarget set since changeState clears reservation only from IN_COVER/PEEK_SHOOT
      enemy.coverTarget = advCover;
      return;
    }
    enemy.coverSearchCooldown = 2.0; // don't re-search every frame
  }
  enemy.coverSearchCooldown -= dt;

  // Path toward player
  enemy.pathTimer -= dt;
  if (enemy.pathTimer <= 0) {
    pathTo(enemy, px, pz, colliders);
  }

  const moved = followPath(enemy, dt, colliders);
  if (!moved && dist > 2) {
    moveEnemy(enemy, px, pz, enemy.speed, dt, colliders);
  }
  animateLegs(enemy, dt, true);
}

function updateSeekCover(enemy, dt, now, colliders) {
  const px = camera.position.x, pz = camera.position.z;
  const ex = enemy.mesh.position.x, ez = enemy.mesh.position.z;

  enemy.aiStateTimer += dt;

  // If we don't have a cover target yet, find one
  if (!enemy.coverTarget) {
    const cover = findBestCover(
      { x: ex, z: ez }, { x: px, z: pz },
      colliders, COVER_SEARCH_RADIUS, false
    );
    if (cover) {
      enemy.coverTarget = cover;
      reserveCover(cover.x, cover.z);
      pathTo(enemy, cover.x, cover.z, colliders);
    } else {
      // No cover available — fall back to advancing
      changeState(enemy, 'ADVANCE');
      return;
    }
  }

  // Move toward cover target
  const cdx = enemy.coverTarget.x - ex;
  const cdz = enemy.coverTarget.z - ez;
  const coverDist = Math.sqrt(cdx * cdx + cdz * cdz);

  if (coverDist < WAYPOINT_REACH) {
    // Arrived at cover
    changeState(enemy, 'IN_COVER');
    enemy.coverTarget = enemy.coverTarget; // preserve
    reserveCover(enemy.coverTarget.x, enemy.coverTarget.z);
    enemy.peekTimer = COVER_WAIT_MIN + Math.random() * (COVER_WAIT_MAX - COVER_WAIT_MIN);
    return;
  }

  // Follow path or move directly to cover
  const moved = followPath(enemy, dt, colliders);
  if (!moved) {
    moveEnemy(enemy, enemy.coverTarget.x, enemy.coverTarget.z, enemy.speed, dt, colliders);
  }
  animateLegs(enemy, dt, true);

  // Timeout — re-evaluate
  if (enemy.aiStateTimer > 5) {
    releaseCover(enemy.coverTarget.x, enemy.coverTarget.z);
    enemy.coverTarget = null;
    enemy.aiStateTimer = 0;
  }
}

function updateInCover(enemy, dt, now, colliders) {
  const px = camera.position.x, pz = camera.position.z;
  const ex = enemy.mesh.position.x, ez = enemy.mesh.position.z;

  enemy.aiStateTimer += dt;
  enemy.peekTimer -= dt;

  // Face the player
  const toDx = px - ex, toDz = pz - ez;
  enemy.mesh.rotation.y = Math.atan2(toDx, toDz);

  animateLegs(enemy, dt, false);

  // Retreat if low health
  if (shouldRetreat(enemy)) {
    enemy.previousCover = enemy.coverTarget;
    changeState(enemy, 'RETREAT');
    return;
  }

  // Check if cover still valid (blocks LOS to player)
  if (hasLineOfSight(ex, ez, px, pz, colliders)) {
    // Player can see us — cover is invalid, find new cover
    enemy.previousCover = enemy.coverTarget;
    releaseCover(enemy.coverTarget.x, enemy.coverTarget.z);
    enemy.coverTarget = null;
    changeState(enemy, 'SEEK_COVER');
    return;
  }

  // Time to peek and shoot
  if (enemy.peekTimer <= 0) {
    changeState(enemy, 'PEEK_SHOOT');
    // Preserve cover target for peek
    enemy.peekTimer = PEEK_DURATION;
    enemy.burstCount = 0;

    // Choose peek direction: try both sides, pick the one with LOS
    const perpX = -toDz;
    const perpZ = toDx;
    const perpLen = Math.sqrt(perpX * perpX + perpZ * perpZ);
    if (perpLen > 0.01) {
      const pnx = perpX / perpLen;
      const pnz = perpZ / perpLen;
      const testX1 = ex + pnx * PEEK_OFFSET;
      const testZ1 = ez + pnz * PEEK_OFFSET;
      const testX2 = ex - pnx * PEEK_OFFSET;
      const testZ2 = ez - pnz * PEEK_OFFSET;

      const los1 = hasLineOfSight(testX1, testZ1, px, pz, colliders);
      const los2 = hasLineOfSight(testX2, testZ2, px, pz, colliders);

      if (los1 && !los2) enemy.peekDir = 1;
      else if (los2 && !los1) enemy.peekDir = -1;
      else enemy.peekDir = Math.random() > 0.5 ? 1 : -1;
    }
    return;
  }

  // Flank after staying in cover too long
  if (enemy.aiStateTimer > COVER_TIMEOUT) {
    enemy.previousCover = enemy.coverTarget;
    changeState(enemy, 'FLANK');
    return;
  }
}

function updatePeekShoot(enemy, dt, now, colliders) {
  const px = camera.position.x, pz = camera.position.z;

  if (!enemy.coverTarget) {
    changeState(enemy, 'ADVANCE');
    return;
  }

  const cx = enemy.coverTarget.x, cz = enemy.coverTarget.z;

  enemy.aiStateTimer += dt;
  enemy.peekTimer -= dt;

  // Face the player
  const toDx = px - enemy.mesh.position.x;
  const toDz = pz - enemy.mesh.position.z;
  enemy.mesh.rotation.y = Math.atan2(toDx, toDz);

  // Calculate perpendicular direction for peeking
  const perpX = -toDz;
  const perpZ = toDx;
  const perpLen = Math.sqrt(perpX * perpX + perpZ * perpZ);
  const pnx = perpLen > 0.01 ? perpX / perpLen : 0;
  const pnz = perpLen > 0.01 ? perpZ / perpLen : 1;

  // Animate peek offset based on phase
  const elapsed = PEEK_DURATION - enemy.peekTimer;
  let targetOffset;
  if (elapsed < PEEK_LEAN_TIME) {
    // Leaning out
    targetOffset = (elapsed / PEEK_LEAN_TIME) * PEEK_OFFSET;
  } else if (elapsed < PEEK_FIRE_END) {
    // Fully peeked — fire
    targetOffset = PEEK_OFFSET;
  } else {
    // Leaning back
    const backProgress = (elapsed - PEEK_FIRE_END) / (PEEK_DURATION - PEEK_FIRE_END);
    targetOffset = PEEK_OFFSET * (1 - Math.min(1, backProgress));
  }

  enemy.peekOffset += (targetOffset - enemy.peekOffset) * Math.min(1, dt * 10);

  // Apply peek position
  enemy.mesh.position.x = cx + pnx * enemy.peekOffset * enemy.peekDir;
  enemy.mesh.position.z = cz + pnz * enemy.peekOffset * enemy.peekDir;
  enemy.mesh.position.y = getHeight(enemy.mesh.position.x, enemy.mesh.position.z);

  animateLegs(enemy, dt, false);

  // Fire during the peek window
  if (elapsed > PEEK_FIRE_START && elapsed < PEEK_FIRE_END &&
      enemy.burstCount < 3 && now - enemy.lastAttack > BURST_INTERVAL) {
    if (hasLineOfSight(enemy.mesh.position.x, enemy.mesh.position.z, px, pz, colliders)) {
      enemy.lastAttack = now;
      enemy.burstCount++;
      spawnEnemyBullet(enemy);
    }
  }

  // Took damage during peek → retreat
  if (recentlyDamaged(enemy, now) && shouldRetreat(enemy)) {
    // Snap back to cover position first
    enemy.mesh.position.x = cx;
    enemy.mesh.position.z = cz;
    enemy.previousCover = enemy.coverTarget;
    changeState(enemy, 'RETREAT');
    return;
  }

  // Peek done → back to cover
  if (enemy.peekTimer <= 0) {
    enemy.mesh.position.x = cx;
    enemy.mesh.position.z = cz;
    enemy.mesh.position.y = getHeight(cx, cz);

    // Re-enter IN_COVER state
    enemy.aiState = 'IN_COVER';
    enemy.aiStateTimer = 0;
    enemy.peekOffset = 0;
    enemy.peekTimer = COVER_WAIT_MIN + Math.random() * (COVER_WAIT_MAX - COVER_WAIT_MIN);
    // Don't release cover — we're staying
    return;
  }
}

function updateRetreat(enemy, dt, now, colliders) {
  const px = camera.position.x, pz = camera.position.z;
  const ex = enemy.mesh.position.x, ez = enemy.mesh.position.z;

  enemy.aiStateTimer += dt;

  // Find retreat cover if we don't have one
  if (!enemy.coverTarget) {
    const cover = findBestCover(
      { x: ex, z: ez }, { x: px, z: pz },
      colliders, COVER_SEARCH_RADIUS * 1.5, true
    );
    if (cover) {
      enemy.coverTarget = cover;
      reserveCover(cover.x, cover.z);
      pathTo(enemy, cover.x, cover.z, colliders);
    } else {
      // No retreat cover — desperation advance
      changeState(enemy, 'ADVANCE');
      return;
    }
  }

  // Move toward retreat cover
  const cdx = enemy.coverTarget.x - ex;
  const cdz = enemy.coverTarget.z - ez;
  const coverDist = Math.sqrt(cdx * cdx + cdz * cdz);

  if (coverDist < WAYPOINT_REACH) {
    changeState(enemy, 'IN_COVER');
    enemy.coverTarget = enemy.coverTarget;
    reserveCover(enemy.coverTarget.x, enemy.coverTarget.z);
    enemy.peekTimer = COVER_WAIT_MIN + Math.random() * (COVER_WAIT_MAX - COVER_WAIT_MIN);
    return;
  }

  const moved = followPath(enemy, dt, colliders);
  if (!moved) {
    moveEnemy(enemy, enemy.coverTarget.x, enemy.coverTarget.z, enemy.speed * 1.3, dt, colliders);
  }
  animateLegs(enemy, dt, true);

  // Timeout
  if (enemy.aiStateTimer > 6) {
    if (enemy.coverTarget) releaseCover(enemy.coverTarget.x, enemy.coverTarget.z);
    enemy.coverTarget = null;
    changeState(enemy, 'ADVANCE');
  }
}

function updateFlank(enemy, dt, now, colliders) {
  const px = camera.position.x, pz = camera.position.z;
  const ex = enemy.mesh.position.x, ez = enemy.mesh.position.z;

  enemy.aiStateTimer += dt;

  // Find flank cover if we don't have one
  if (!enemy.coverTarget) {
    // Use camera rotation for player facing direction
    const playerYaw = camera.rotation.y;
    const cover = findFlankCover(
      { x: ex, z: ez }, { x: px, z: pz }, playerYaw, colliders
    );
    if (cover) {
      enemy.coverTarget = cover;
      reserveCover(cover.x, cover.z);
      pathTo(enemy, cover.x, cover.z, colliders);
    } else {
      // No flank position — just advance
      changeState(enemy, 'ADVANCE');
      return;
    }
  }

  // Move toward flank cover
  const cdx = enemy.coverTarget.x - ex;
  const cdz = enemy.coverTarget.z - ez;
  const coverDist = Math.sqrt(cdx * cdx + cdz * cdz);

  if (coverDist < WAYPOINT_REACH) {
    changeState(enemy, 'IN_COVER');
    enemy.coverTarget = enemy.coverTarget;
    reserveCover(enemy.coverTarget.x, enemy.coverTarget.z);
    enemy.peekTimer = COVER_WAIT_MIN + Math.random() * (COVER_WAIT_MAX - COVER_WAIT_MIN);
    return;
  }

  const moved = followPath(enemy, dt, colliders);
  if (!moved) {
    moveEnemy(enemy, enemy.coverTarget.x, enemy.coverTarget.z, enemy.speed, dt, colliders);
  }
  animateLegs(enemy, dt, true);

  // Timeout
  if (enemy.aiStateTimer > 8) {
    if (enemy.coverTarget) releaseCover(enemy.coverTarget.x, enemy.coverTarget.z);
    enemy.coverTarget = null;
    changeState(enemy, 'ADVANCE');
  }
}

// ─── ENEMY AI UPDATE ───────────────────────────────────────
let _pathStagger = 0;
let _frameCount = 0;
const LOD_DIST_NEAR = 40;
const LOD_DIST_FAR  = 80;

export function updateEnemies(dt) {
  const now = performance.now();
  const colliders = getAllColliders();

  _pathStagger = (_pathStagger + 1) % Math.max(1, enemies.length);
  _frameCount++;

  for (let i = enemies.length - 1; i >= 0; i--) {
    const enemy = enemies[i];
    if (!enemy.alive) {
      // Release cover when dying
      if (enemy.coverTarget) {
        releaseCover(enemy.coverTarget.x, enemy.coverTarget.z);
        enemy.coverTarget = null;
      }
      continue;
    }

    const toDx = camera.position.x - enemy.mesh.position.x;
    const toDz = camera.position.z - enemy.mesh.position.z;
    const dist = Math.sqrt(toDx * toDx + toDz * toDz);

    // Distance-based AI LOD — reduce update frequency for distant enemies
    if (dist > LOD_DIST_FAR  && (_frameCount % 8) !== (i % 8)) continue;
    if (dist > LOD_DIST_NEAR && (_frameCount % 4) !== (i % 4)) continue;

    // Face player (overridden in some states)
    enemy.mesh.rotation.y = Math.atan2(toDx, toDz);

    if (enemy.isRanged) {
      // ── RANGED AI STATE MACHINE ──
      switch (enemy.aiState) {
        case 'ADVANCE':    updateAdvance(enemy, dt, now, colliders); break;
        case 'SEEK_COVER': updateSeekCover(enemy, dt, now, colliders); break;
        case 'IN_COVER':   updateInCover(enemy, dt, now, colliders); break;
        case 'PEEK_SHOOT': updatePeekShoot(enemy, dt, now, colliders); break;
        case 'RETREAT':    updateRetreat(enemy, dt, now, colliders); break;
        case 'FLANK':      updateFlank(enemy, dt, now, colliders); break;
        default:           changeState(enemy, 'ADVANCE'); break;
      }
    } else {
      // ── MELEE AI (unchanged) ──
      enemy.pathTimer -= dt;
      if (enemy.pathTimer <= 0 && i === _pathStagger) {
        pathTo(enemy, camera.position.x, camera.position.z, colliders);
      }

      animateLegs(enemy, dt, dist > ENEMY_MELEE_RANGE);

      if (dist > ENEMY_MELEE_RANGE) {
        const moved = followPath(enemy, dt, colliders);
        if (!moved) {
          moveEnemy(enemy, camera.position.x, camera.position.z, enemy.speed, dt, colliders);
        }
      }

      if (dist < ENEMY_MELEE_RANGE && now - enemy.lastAttack > enemy.attackCooldown) {
        enemy.lastAttack = now;
        takeDamage(ENEMY_MELEE_DAMAGE);
      }
    }

    // Apply hit flinch (additive visual offset)
    if (enemy.flinchTimer > 0) {
      enemy.flinchTimer -= dt;
      const t = Math.max(0, enemy.flinchTimer / enemy.flinchDuration);
      enemy.mesh.position.x += enemy.flinchX * t;
      enemy.mesh.position.z += enemy.flinchZ * t;
    }
  }

  // Update enemy bullets
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    const b = enemyBullets[i];
    b.mesh.position.x += b.velocity.x * dt;
    b.mesh.position.y += b.velocity.y * dt;
    b.mesh.position.z += b.velocity.z * dt;
    b.life -= dt;

    if (b.mesh.position.distanceTo(camera.position) < 1.0) {
      takeDamage(ENEMY_BULLET_DAMAGE);
      b.mesh.visible = false;
      _bulletPool.push(b);
      enemyBullets.splice(i, 1);
      continue;
    }

    if (bulletHitsBuilding(b.mesh.position.x, b.mesh.position.y, b.mesh.position.z, colliders)) {
      b.mesh.visible = false;
      _bulletPool.push(b);
      enemyBullets.splice(i, 1);
      continue;
    }

    if (b.life <= 0) {
      b.mesh.visible = false;
      _bulletPool.push(b);
      enemyBullets.splice(i, 1);
    }
  }
}

// ─── DYING ENEMIES UPDATE ─────────────────────────────────
export function updateDyingEnemies(dt) {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const enemy = enemies[i];
    if (!enemy.dying) continue;

    enemy.deathTimer += dt;

    // Ground height at enemy position
    const groundY = getHeight(enemy.mesh.position.x, enemy.mesh.position.z);

    // Phase 1: Spin + fall to ground (0–300ms)
    if (enemy.deathTimer < 0.3) {
      const t = enemy.deathTimer / 0.3;
      const ease = t * t; // ease-in for gravity feel
      enemy.mesh.rotation.y = enemy.deathSpinStart + t * (Math.PI / 2);
      enemy.mesh.rotation.z = ease * (Math.PI / 2); // topple sideways
      enemy.mesh.position.y = enemy.deathY + (groundY - enemy.deathY) * ease;
    } else {
      enemy.mesh.rotation.y = enemy.deathSpinStart + Math.PI / 2;
      enemy.mesh.rotation.z = Math.PI / 2;
      enemy.mesh.position.y = groundY;
    }

    // Phase 2: Fade out (after 3 seconds)
    if (enemy.deathTimer > 3.0) {
      const fadeT = Math.min(1, (enemy.deathTimer - 3.0) / 0.5);
      enemy.mesh.traverse(child => {
        if (child.material) {
          if (!child.material._deathCloned) {
            child.material = child.material.clone();
            child.material.transparent = true;
            child.material._deathCloned = true;
          }
          child.material.opacity = 1 - fadeT;
        }
      });
    }

    // Phase 3: Remove (after 3.5 seconds)
    if (enemy.deathTimer > 3.5) {
      scene.remove(enemy.mesh);
      enemies.splice(i, 1);
    }
  }
}

// ─── PICKUP UPDATE ─────────────────────────────────────────
export function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.mesh.rotation.y += dt * 2;
    p.mesh.position.y = getHeight(p.mesh.position.x, p.mesh.position.z) + 0.8 + Math.sin(performance.now() * 0.003) * 0.15;

    if (camera.position.distanceTo(p.mesh.position) < 1.5) {
      if (p.type === 'health') {
        STATE.health = Math.min(STATE.maxHealth, STATE.health + 25);
      } else {
        STATE.ammo = Math.min(STATE.maxAmmo, STATE.ammo + 15);
      }
      scene.remove(p.mesh);
      pickups.splice(i, 1);
      updateHUD();
    }
  }
}
