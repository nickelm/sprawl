import { STATE, enemies } from './state.js';
import { camera } from './renderer.js';
import { spawnEnemy } from './enemies.js';
import { getAllColliders, spawnWeaponCrate, clearWeaponCrates } from './world.js';
import { updateWaveHUD, showWaveAnnounce, updateHUD, showAttachmentChoice } from './hud.js';
import { getRandomInteriorPositions } from './nav.js';
import { generateRandomWeapon, getCompatibleAttachments, ATTACHMENT_DEFS } from './weaponDefs.js';

// ─── WAVE DEFINITIONS ──────────────────────────────────────
// Returns { total, types } for a given wave number
function getWaveConfig(wave) {
  if (wave <= 3) {
    // Waves 1-3: Riflemen only, 5-8 enemies
    const total = 5 + Math.floor(Math.random() * 4);
    return { total, types: [{ isRanged: true, healthMult: 1, weight: 1, enemyType: 'rifleman' }] };
  }
  if (wave <= 6) {
    // Waves 4-6: + Flankers (melee), 10-15 enemies
    const total = 10 + Math.floor(Math.random() * 6);
    return {
      total,
      types: [
        { isRanged: true, healthMult: 1, weight: 3, enemyType: 'rifleman' },
        { isRanged: true, healthMult: 1, weight: 2, enemyType: 'flanker' },
      ],
    };
  }
  if (wave <= 9) {
    // Waves 7-9: + Heavies (tanky ranged), 15-20 enemies
    const total = 15 + Math.floor(Math.random() * 6);
    return {
      total,
      types: [
        { isRanged: true, healthMult: 1, weight: 3, enemyType: 'rifleman' },
        { isRanged: true, healthMult: 1, weight: 2, enemyType: 'flanker' },
        { isRanged: true, healthMult: 2.5, weight: 1, enemyType: 'heavy' },
      ],
    };
  }
  // Wave 10+: Full mix, 20+ enemies, scaling
  const total = 20 + (wave - 10) * 2;
  return {
    total,
    types: [
      { isRanged: true, healthMult: 1, weight: 3, enemyType: 'rifleman' },
      { isRanged: true, healthMult: 1, weight: 2, enemyType: 'flanker' },
      { isRanged: true, healthMult: 2.5, weight: 1, enemyType: 'heavy' },
    ],
  };
}

// Pick a weighted random enemy type from the config
function pickEnemyType(types) {
  const totalWeight = types.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * totalWeight;
  for (const t of types) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return types[0];
}

// ─── SPAWN POSITIONING ─────────────────────────────────────
function getDirectionCount(wave) {
  if (wave <= 3) return 1;
  if (wave <= 6) return 2;
  if (wave <= 9) return 3;
  return 4;
}

// Pre-pick spawn directions for this wave (angles in radians)
let waveDirections = [];

function pickWaveDirections(wave) {
  const count = getDirectionCount(wave);
  const base = Math.random() * Math.PI * 2;
  const dirs = [];
  for (let i = 0; i < count; i++) {
    dirs.push(base + (i * Math.PI * 2) / count);
  }
  return dirs;
}

// Check that position is not inside or wedged between buildings
function isPositionClear(x, z, colliders, margin) {
  for (const c of colliders) {
    if (x > c.minX - margin && x < c.maxX + margin &&
        z > c.minZ - margin && z < c.maxZ + margin) {
      return false;
    }
  }
  return true;
}

function findSpawnPosition(colliders) {
  const px = camera.position.x;
  const pz = camera.position.z;

  // Try many attempts with varying angles and distances
  for (let attempt = 0; attempt < 20; attempt++) {
    // Pick a random direction from the wave's approach directions
    const baseAngle = waveDirections[Math.floor(Math.random() * waveDirections.length)];
    // Spread within ±30° of the direction
    const angle = baseAngle + (Math.random() - 0.5) * (Math.PI / 3);
    const dist = 35 + Math.random() * 25; // 35-60m from player

    const x = px + Math.cos(angle) * dist;
    const z = pz + Math.sin(angle) * dist;

    // Use 2m margin to avoid spawning near building edges/gaps
    if (isPositionClear(x, z, colliders, 2.0)) {
      return { x, z };
    }
  }

  // Fallback: spawn further out where buildings are sparser
  const fallbackAngle = Math.random() * Math.PI * 2;
  const fallbackDist = 55 + Math.random() * 15;
  return {
    x: px + Math.cos(fallbackAngle) * fallbackDist,
    z: pz + Math.sin(fallbackAngle) * fallbackDist,
  };
}

// ─── WAVE STATE ─────────────────────────────────────────────
let waveConfig = null;
const INTERMISSION = 8;     // seconds between waves
const SPAWN_INTERVAL = 0.3; // seconds between individual enemy spawns
const FIRST_WAVE_DELAY = 3; // seconds before first wave

// Track which enemies belong to the current wave
const waveEnemySet = new Set();

// ─── PUBLIC API ─────────────────────────────────────────────

export function initWaves() {
  STATE.wave = 0;
  STATE.waveActive = false;
  STATE.wavePause = true;
  STATE.waveTimer = FIRST_WAVE_DELAY;
  STATE.waveEnemiesTotal = 0;
  STATE.waveEnemiesAlive = 0;
  STATE.waveEnemiesSpawned = 0;
  STATE.waveSpawnTimer = 0;
  waveConfig = null;
  waveDirections = [];
  waveEnemySet.clear();
}

export function updateWaves(dt) {
  if (STATE.dead) return;

  // ── INTERMISSION ──
  if (STATE.wavePause) {
    STATE.waveTimer -= dt;
    if (STATE.waveTimer <= 0) {
      startNextWave();
    }
    updateWaveHUD();
    return;
  }

  // ── SPAWNING PHASE ──
  if (STATE.waveEnemiesSpawned < STATE.waveEnemiesTotal) {
    STATE.waveSpawnTimer -= dt;
    if (STATE.waveSpawnTimer <= 0) {
      spawnWaveEnemy();
      STATE.waveSpawnTimer = SPAWN_INTERVAL;
    }
  }

  // ── COUNT ALIVE ENEMIES ──
  let alive = 0;
  for (const e of enemies) {
    if (e.alive && waveEnemySet.has(e)) alive++;
  }
  STATE.waveEnemiesAlive = alive;

  // ── WAVE COMPLETE ──
  if (STATE.waveEnemiesSpawned >= STATE.waveEnemiesTotal && alive === 0) {
    endWave();
  }

  updateWaveHUD();
}

// ─── INTERNAL ───────────────────────────────────────────────

function startNextWave() {
  STATE.wave++;
  waveConfig = getWaveConfig(STATE.wave);
  waveDirections = pickWaveDirections(STATE.wave);

  // Clear weapon crates when new wave starts
  clearWeaponCrates();

  STATE.waveActive = true;
  STATE.wavePause = false;
  STATE.waveEnemiesTotal = waveConfig.total;
  STATE.waveEnemiesSpawned = 0;
  STATE.waveEnemiesAlive = 0;
  STATE.waveSpawnTimer = 0;
  waveEnemySet.clear();

  showWaveAnnounce(STATE.wave, waveConfig.total);
}

function endWave() {
  STATE.waveActive = false;
  STATE.wavePause = true;
  STATE.waveTimer = INTERMISSION;
  waveEnemySet.clear();

  // Partial ammo resupply (half of missing ammo)
  const missing = STATE.maxAmmo - STATE.ammo;
  STATE.ammo += Math.ceil(missing / 2);
  if (STATE.ammo > STATE.maxAmmo) STATE.ammo = STATE.maxAmmo;

  // Partial health regen (recover 20 hp, cap at max)
  STATE.health = Math.min(STATE.maxHealth, STATE.health + 20);

  updateHUD();

  // Spawn weapon crates nearby (Step 14a)
  clearWeaponCrates();
  const px = camera.position.x, pz = camera.position.z;
  const crateCount = 1 + (STATE.wave >= 5 ? 1 : 0); // 2 crates from wave 5+
  for (let i = 0; i < crateCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 15 + Math.random() * 10; // 15-25m away
    const cx = px + Math.cos(angle) * dist;
    const cz = pz + Math.sin(angle) * dist;
    spawnWeaponCrate(cx, cz, generateRandomWeapon(STATE.wave));
  }

  // Attachment reward every 3rd wave (Step 14d)
  if (STATE.wave > 0 && STATE.wave % 3 === 0) {
    const compatible = getCompatibleAttachments(STATE.currentWeapon);
    if (compatible.length >= 2) {
      // Pick 2 random distinct attachments
      const shuffled = compatible.sort(() => Math.random() - 0.5);
      const options = shuffled.slice(0, 2);
      showAttachmentChoice(options);
    }
  }
}

function spawnWaveEnemy() {
  if (!waveConfig) return;
  const colliders = getAllColliders();
  const type = pickEnemyType(waveConfig.types);

  // ~40% chance to spawn indoors for testing interior navigation
  let pos = null;
  let yOverride = null;
  if (Math.random() < 0.4) {
    const indoor = getRandomInteriorPositions(1);
    if (indoor.length > 0) {
      pos = indoor[0];
      yOverride = pos.y;
    }
  }
  if (!pos) {
    pos = findSpawnPosition(colliders);
  }

  const enemy = spawnEnemy(pos.x, pos.z, type.isRanged, null, yOverride, type.enemyType || 'rifleman');
  if (enemy) {
    // Apply health multiplier for heavies
    if (type.healthMult !== 1) {
      enemy.health = Math.round(enemy.health * type.healthMult);
      enemy.maxHealth = enemy.health;
    }
    // Set building-awareness for indoor-spawned enemies so they don't
    // collide with the building's outer AABB or snap to terrain height
    if (yOverride != null && pos.buildingId != null) {
      enemy.insideBuildingId = pos.buildingId;
      enemy._insideBuildingCollider = colliders.find(c =>
        pos.x >= c.minX && pos.x <= c.maxX && pos.z >= c.minZ && pos.z <= c.maxZ
      ) || null;
    }
    waveEnemySet.add(enemy);
  }
  STATE.waveEnemiesSpawned++;
}
