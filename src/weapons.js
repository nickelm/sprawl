import * as THREE from 'three';
import { STATE, enemies } from './state.js';
import { scene, camera } from './renderer.js';
import { updateHUD, setReloading, addKillFeed, showHitMarker } from './hud.js';
import { triggerRecoil, isSwitching, getEjectionData } from './weaponView.js';
import { addScreenShake } from './player.js';
import { spawnDamageNumber } from './damageNumbers.js';
import { WEAPON_DEFS, computeStats, STANCE_MODIFIERS, ATTACHMENT_DEFS } from './weaponDefs.js';
import { fireBullet } from './ballistics.js';
import { playShot, playHit, playReload } from './audio.js';
import { spawnCasing } from './debris.js';

const _dir = new THREE.Vector3();
const DEG = Math.PI / 180;

// ─── FIRE MODE STATE ──────────────────────────────────────
let semiLatch = false;     // prevents semi-auto re-fire while held
let burstRemaining = 0;    // shots left in current burst
let burstTimer = 0;        // delay between burst shots
let pumpTimer = 0;         // pump-action lockout timer
const BURST_PAUSE = 0.15;  // seconds between bursts

// ─── SPREAD DECAY RATE ───────────────────────────────────
const SPREAD_DECAY_RATE = 3.0; // degrees/sec

// ─── COMPUTED STATS CACHE ─────────────────────────────────
let _cachedStats = null;
let _cachedStatsKey = '';

// ─── HELPERS ──────────────────────────────────────────────

function getCurrentDef() {
  return WEAPON_DEFS[STATE.currentWeapon];
}

function getCurrentLoadoutSlot() {
  return STATE.loadout.primary.weapon === STATE.currentWeapon ? 'primary' : 'secondary';
}

/** Get effective stats with attachment modifiers applied. Cached per weapon+attachments combo. */
export function getEffectiveStats() {
  const def = getCurrentDef();
  const slot = getCurrentLoadoutSlot();
  const atts = STATE.loadout[slot]?.attachments;
  // Build cache key from weapon + attachment keys
  const key = STATE.currentWeapon + '|' + (atts ? Object.values(atts).join(',') : '');
  if (_cachedStatsKey === key && _cachedStats) return _cachedStats;
  _cachedStats = computeStats(def, atts);
  _cachedStatsKey = key;
  return _cachedStats;
}

/** Invalidate cached stats (call on weapon switch or attachment change). */
export function invalidateStatsCache() {
  _cachedStats = null;
  _cachedStatsKey = '';
}

/** Apply computed stats to STATE fields used by the game loop. */
export function applyStatsToState() {
  const stats = getEffectiveStats();
  STATE.maxAmmo = stats.magSize;
  STATE.fireRate = Math.round(1000 / stats.rateOfFire);
  STATE.reloadTime = Math.round(stats.reloadTime * 1000);
  STATE.effectiveAdsTime = stats.adsTime;
}

function getStance() {
  if (!STATE.isGrounded) return 'airborne';
  if (STATE.isSprinting) return 'sprinting';
  if (STATE.isCrouching) {
    return STATE.isMoving ? 'crouched_moving' : 'crouched_still';
  }
  return STATE.isMoving ? 'walking' : 'standing_still';
}

function getStanceModifiers() {
  return STANCE_MODIFIERS[getStance()] || STANCE_MODIFIERS.standing_still;
}

function isSuppressed() {
  const slot = STATE.loadout.primary.weapon === STATE.currentWeapon ? 'primary' : 'secondary';
  return STATE.loadout[slot]?.attachments?.muzzle === 'suppressor';
}

// ─── SPREAD CALCULATION ───────────────────────────────────

export function computeCurrentSpread() {
  const def = getCurrentDef();
  const es = getEffectiveStats();
  const stance = getStanceModifiers();

  if (STATE.ads) {
    return es.spread.ads * stance.spreadAds * STATE.sustainedFireMult * def.adsFactor;
  } else {
    return es.spread.hip * stance.spreadHip * STATE.sustainedFireMult * def.hipFactor;
  }
}

function applySpread(direction, spreadDegrees) {
  if (spreadDegrees < 0.001) return direction;

  const spreadRad = spreadDegrees * DEG;
  // Uniform sampling within a cone
  const r = Math.sqrt(Math.random()) * spreadRad;
  const theta = Math.random() * Math.PI * 2;

  // Get perpendicular axes
  const up = Math.abs(direction.y) < 0.99
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(direction, up).normalize();
  const trueUp = new THREE.Vector3().crossVectors(right, direction).normalize();

  // Rotate direction within the cone
  const result = direction.clone();
  result.addScaledVector(right, Math.cos(theta) * Math.sin(r));
  result.addScaledVector(trueUp, Math.sin(theta) * Math.sin(r));
  result.normalize();
  return result;
}

// ─── UPDATE WEAPONS (called each frame from game loop) ────

export function updateWeapons(dt) {
  // Decay sustained fire multiplier
  if (STATE.sustainedFireMult > 1.0) {
    STATE.sustainedFireMult = Math.max(1.0,
      STATE.sustainedFireMult - SPREAD_DECAY_RATE * dt);
  }

  // Update current spread for crosshair rendering
  STATE.currentSpread = computeCurrentSpread();

  // Pump timer countdown
  if (pumpTimer > 0) {
    pumpTimer -= dt;
    return; // can't fire during pump
  }

  // Burst timer countdown
  if (burstTimer > 0) {
    burstTimer -= dt;
    if (burstTimer <= 0 && burstRemaining > 0) {
      fireOnce();
      burstRemaining--;
      if (burstRemaining > 0) {
        burstTimer = 1 / getCurrentDef().baseStats.rateOfFire;
      } else {
        burstTimer = BURST_PAUSE; // pause after burst completes
      }
    }
    return;
  }

  // Handle fire input based on mode
  if (!STATE.mouseHeld) {
    semiLatch = false;
    return;
  }

  if (!canFire()) return;

  const mode = STATE.fireMode;

  if (mode === 'auto') {
    const now = performance.now();
    if (now - STATE.lastShotTime >= STATE.fireRate) {
      fireOnce();
    }
  } else if (mode === 'semi') {
    if (!semiLatch) {
      semiLatch = true;
      fireOnce();
    }
  } else if (mode === 'burst3') {
    if (!semiLatch) {
      semiLatch = true;
      fireOnce();
      burstRemaining = 2; // 2 more after the first
      burstTimer = 1 / getCurrentDef().baseStats.rateOfFire;
    }
  } else if (mode === 'pump') {
    if (!semiLatch) {
      semiLatch = true;
      fireOnce();
      pumpTimer = 0.6; // pump animation lockout
    }
  }
}

// ─── CAN FIRE CHECK ───────────────────────────────────────

function canFire() {
  if (STATE.onLadder || STATE.ammo <= 0 || STATE.reloading || STATE.dead || STATE.dying) return false;
  if (isSwitching()) return false;
  return true;
}

// ─── FIRE ONE SHOT ────────────────────────────────────────

function fireOnce() {
  if (!canFire()) return;

  const now = performance.now();
  const def = getCurrentDef();
  const es = getEffectiveStats();

  // Fire rate check for auto mode
  if (now - STATE.lastShotTime < STATE.fireRate) return;

  STATE.lastShotTime = now;
  STATE.ammo--;

  // Recoil pattern application (Step 4)
  const pattern = def.recoilPattern;
  const idx = STATE.shotCount % pattern.length;
  let pitchDeg = pattern[idx].pitch;
  let yawDeg = pattern[idx].yaw;

  // ±15% random perturbation
  pitchDeg *= 1.0 + (Math.random() - 0.5) * 0.3;
  yawDeg *= 1.0 + (Math.random() - 0.5) * 0.3;

  // Attachment recoil modifiers (Step 10b)
  pitchDeg *= es.recoilVertMult;
  yawDeg *= es.recoilHorizMult;

  // Stance multipliers for recoil
  const stanceMods = getStanceModifiers();
  const adsMult = STATE.ads ? 0.7 : 1.0;
  pitchDeg *= adsMult * stanceMods.recoil;
  yawDeg *= adsMult * stanceMods.recoil;

  const suppressed = isSuppressed();
  triggerRecoil(pitchDeg, yawDeg, suppressed);
  STATE.shotCount++;

  // Audio
  playShot(def.archetype, suppressed);

  // Sound event for AI detection (Step 15a)
  emitSoundEvent(camera.position, suppressed ? 24 : 80);

  // Brass casing ejection
  const ejData = getEjectionData();
  if (ejData) {
    spawnCasing(ejData.worldPos, ejData.camRight, ejData.camUp, def.casingColor || 0xc4a63a);
  }

  // Sustained fire spread buildup
  const spreadGrowth = def.spreadPerShot;
  const adsSpreadMult = STATE.ads ? 0.5 : 1.0; // ADS grows at half rate
  STATE.sustainedFireMult = Math.min(2.5,
    STATE.sustainedFireMult + spreadGrowth * adsSpreadMult / es.spread.hip);

  addScreenShake(0.0005, 0.016);
  updateHUD();

  // Compute current spread for this shot
  const spreadDeg = computeCurrentSpread();

  // Get camera direction
  camera.getWorldDirection(_dir);

  // Build bullet stats from effective (attachment-modified) stats
  const bulletStats = {
    damage: es.damage,
    penetration: es.penetration,
    range: es.range,
    tracerColor: def.tracerColor,
  };

  // Shotgun: multiple pellets
  const pelletCount = def.pelletCount || 1;
  if (pelletCount > 1) {
    bulletStats.damage = es.damage; // per-pellet damage
    bulletStats.penetration = es.penetration; // per-pellet penetration
    for (let i = 0; i < pelletCount; i++) {
      const pelletDir = applySpread(_dir.clone(), spreadDeg);
      const hits = fireBullet(camera.position, pelletDir, bulletStats, { excludePlayer: true });
      processHits(hits);
    }
  } else {
    // Single bullet with spread
    const shotDir = applySpread(_dir, spreadDeg);
    const hits = fireBullet(camera.position, shotDir, bulletStats, { excludePlayer: true });
    processHits(hits);
  }

  // Auto-reload when empty
  if (STATE.ammo <= 0) reload();
}

// ─── PROCESS HITS ─────────────────────────────────────────

function processHits(hits) {
  for (const hit of hits) {
    if (hit.type === 'enemy') {
      const enemy = hit.enemy;
      enemy.health -= hit.damage;
      enemy.lastDamagedTime = performance.now();

      // Hit flinch
      const flinchDir = enemy.mesh.position.clone().sub(camera.position);
      flinchDir.y = 0;
      flinchDir.normalize();
      const flinchMag = 0.1 + Math.random() * 0.1;
      enemy.flinchX = flinchDir.x * flinchMag;
      enemy.flinchZ = flinchDir.z * flinchMag;
      enemy.flinchTimer = 0.1;
      enemy.flinchDuration = 0.1;

      const enemyCenter = enemy.mesh.position.clone();
      enemyCenter.y += 1.0;
      const isKill = enemy.health <= 0;
      spawnDamageNumber(enemyCenter, hit.damage, isKill);

      if (isKill) {
        enemy.alive = false;
        enemy.dying = true;
        enemy.deathTimer = 0;
        enemy.deathSpinStart = enemy.mesh.rotation.y;
        enemy.deathY = enemy.mesh.position.y;
        STATE.score++;
        addKillFeed(enemy.isRanged ? 'RANGED' : 'RUSHER');
        showHitMarker(true);
        playHit(true);
        updateHUD();
      } else {
        showHitMarker(false);
        playHit(false);
      }
      break; // Only process first enemy hit
    }
  }
}

// ─── SHOOT BULLET (legacy entry point for mousedown) ──────
export function shootBullet() {
  // Now handled by updateWeapons() frame loop.
  // This is still called on mousedown for instant semi-auto responsiveness.
  if (!canFire()) return;
  const mode = STATE.fireMode;
  if (mode === 'semi' || mode === 'burst3' || mode === 'pump') {
    // These modes fire on press, not on held — handled via updateWeapons
    // But we trigger immediately for responsiveness
    if (mode === 'burst3') {
      fireOnce();
      burstRemaining = 2;
      burstTimer = 1 / getCurrentDef().baseStats.rateOfFire;
      semiLatch = true;
    } else if (mode === 'pump') {
      if (pumpTimer <= 0) {
        fireOnce();
        pumpTimer = 0.6;
        semiLatch = true;
      }
    } else {
      fireOnce();
      semiLatch = true;
    }
  }
  // Auto mode: first shot fires immediately on mousedown via the rate check
}

// ─── RELOAD ────────────────────────────────────────────────
let reloadTimer = null;

export function reload() {
  if (STATE.reloading || STATE.ammo === STATE.maxAmmo) return;
  STATE.reloading = true;
  STATE.reloadProgress = 0;
  setReloading(true);
  playReload();

  // Revolver: dump all casings on reload
  const def = getCurrentDef();
  if (def.archetype === 'revolver') {
    const ejData = getEjectionData();
    if (ejData) {
      const count = def.baseStats.magSize - STATE.ammo; // only spent casings
      for (let i = 0; i < count; i++) {
        const pos = ejData.worldPos.clone();
        pos.x += (Math.random() - 0.5) * 0.03;
        pos.z += (Math.random() - 0.5) * 0.03;
        spawnCasing(pos, ejData.camRight, ejData.camUp, def.casingColor || 0xc4a63a);
      }
    }
  }

  // Drop ADS on reload start, track if we should re-enter
  if (STATE.ads) {
    STATE.ads = false;
  }

  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    STATE.ammo = STATE.maxAmmo;
    STATE.reloading = false;
    STATE.reloadProgress = 0;
    STATE.shotCount = 0;
    STATE.sustainedFireMult = 1.0;
    setReloading(false);
    updateHUD();

    // Re-enter ADS if button still held
    if (STATE.adsHeld) {
      STATE.ads = true;
    }
  }, STATE.reloadTime);
}

export function cancelReload() {
  if (!STATE.reloading) return;
  clearTimeout(reloadTimer);
  reloadTimer = null;
  STATE.reloading = false;
  STATE.reloadProgress = 0;
  setReloading(false);
}

// ─── FIRE MODE TOGGLE ─────────────────────────────────────
export function toggleFireMode() {
  const def = getCurrentDef();
  const modes = def.availableModes;
  if (!modes || modes.length <= 1) return;
  const idx = modes.indexOf(STATE.fireMode);
  STATE.fireMode = modes[(idx + 1) % modes.length];
}

// ─── SOUND EVENT SYSTEM (Step 15a) ────────────────────────
// Alerts enemies within hearing radius when the player fires.
function emitSoundEvent(position, radius) {
  const r2 = radius * radius;
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    const dx = enemy.mesh.position.x - position.x;
    const dz = enemy.mesh.position.z - position.z;
    if (dx * dx + dz * dz < r2) {
      enemy.alerted = true;
      enemy.lastKnownPlayerPos = position.clone();
    }
  }
}

export { isSuppressed };
