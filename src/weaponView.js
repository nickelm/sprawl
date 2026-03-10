import * as THREE from 'three';
import { STATE } from './state.js';
import { camera } from './renderer.js';
import { addRecoil, keys } from './player.js';
import { WEAPON_DEFS, WEAPON_ORDER } from './weaponDefs.js';
import { updateHUD } from './hud.js';

// ─── CONSTANTS ────────────────────────────────────────────
const BASE_FOV = 75;
const DEG = Math.PI / 180;

// ─── MUTABLE PER-WEAPON SETTINGS ─────────────────────────
let hipPos = new THREE.Vector3(0.32, -0.28, -0.5);
let adsPos = new THREE.Vector3(0.0, -0.17, -0.4);
let adsFov = 55;
let currentDef = null;

// ─── WEAPON MODEL ─────────────────────────────────────────
let weaponGroup = null;
let muzzleFlash3D = null;
let muzzleLight = null;
let adsVignette = null;

const matCache = {};
function getMat(color) {
  if (!matCache[color]) {
    matCache[color] = new THREE.MeshPhongMaterial({ color, flatShading: true });
  }
  return matCache[color];
}

function buildWeaponModel(defKey) {
  const def = WEAPON_DEFS[defKey];
  currentDef = def;

  // Dispose old model
  if (weaponGroup) {
    weaponGroup.traverse(child => {
      if (child.geometry) child.geometry.dispose();
    });
    camera.remove(weaponGroup);
  }

  weaponGroup = new THREE.Group();

  // Build parts from definition
  for (const [role, part] of Object.entries(def.parts)) {
    let mesh;
    if (role === 'barrel') {
      const geo = new THREE.CylinderGeometry(part.radius, part.radius, part.length, part.segments);
      geo.rotateX(Math.PI / 2);
      mesh = new THREE.Mesh(geo, getMat(part.color));
    } else {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(...part.size),
        getMat(part.color)
      );
    }
    mesh.position.set(...part.pos);
    mesh.name = role;
    weaponGroup.add(mesh);
  }

  // 3D Muzzle flash — billboard quad at barrel tip
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffee88,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
  const flashGeo = new THREE.PlaneGeometry(0.15, 0.15);
  muzzleFlash3D = new THREE.Mesh(flashGeo, flashMat);
  muzzleFlash3D.position.set(...def.muzzleOffset);
  weaponGroup.add(muzzleFlash3D);

  // Muzzle point light
  muzzleLight = new THREE.PointLight(0xffcc44, 0, 5);
  muzzleLight.position.set(...def.muzzleOffset);
  weaponGroup.add(muzzleLight);

  // Update per-weapon positions
  hipPos.set(...def.hipPos);
  adsPos.set(...def.adsPos);
  adsFov = def.adsFov;

  weaponGroup.position.copy(hipPos);
  camera.add(weaponGroup);

  adsVignette = document.getElementById('ads-vignette');
}

// ─── ANIMATION STATE ──────────────────────────────────────
let bobPhase = 0;
let prevDistance = 0;
let idleTime = 0;

// Muzzle flash
let muzzleFlashTimer = 0;

// Recoil
let recoilPitch = 0;
let recoilYaw = 0;
let weaponKickPitch = 0;
let weaponKickBack = 0;

// Weapon switch animation
// Phase: null (idle), 'lowering', 'raising'
let switchPhase = null;
let switchProgress = 0;    // 0→1 for each phase
let switchTargetKey = null; // weapon key to switch to after lowering
let switchLowerSpeed = 3.0; // speed of current weapon lowering
let switchRaiseSpeed = 3.0; // speed of new weapon raising

// Per-weapon ammo persistence
const weaponAmmo = {};

function resetAnimationState() {
  recoilPitch = 0;
  recoilYaw = 0;
  weaponKickPitch = 0;
  weaponKickBack = 0;
  bobPhase = 0;
  prevDistance = STATE.distance;
  idleTime = 0;
  muzzleFlashTimer = 0;
  if (muzzleFlash3D) muzzleFlash3D.material.opacity = 0;
  if (muzzleLight) muzzleLight.intensity = 0;
}

// ─── PUBLIC API ───────────────────────────────────────────

export function initWeaponView() {
  buildWeaponModel(STATE.currentWeapon);
}

export function resetWeaponView() {
  resetAnimationState();
  switchPhase = null;
  switchProgress = 0;
  switchTargetKey = null;
  STATE.ads = false;
  STATE.adsBlend = 0;
  STATE.reloadProgress = 0;
  camera.fov = BASE_FOV;
  camera.updateProjectionMatrix();
  if (weaponGroup) weaponGroup.position.copy(hipPos);
}

export function isSwitching() {
  return switchPhase !== null;
}

export function switchWeapon(defKey) {
  if (STATE.reloading) return;
  if (defKey === STATE.currentWeapon) return;
  if (switchPhase !== null) return; // already switching

  // Save current weapon's ammo
  weaponAmmo[STATE.currentWeapon] = STATE.ammo;

  // Begin lowering animation
  switchPhase = 'lowering';
  switchProgress = 0;
  switchTargetKey = defKey;
  switchLowerSpeed = currentDef ? currentDef.drawSpeed : 3.0;
  switchRaiseSpeed = WEAPON_DEFS[defKey].drawSpeed;

  // Drop ADS immediately
  STATE.ads = false;
}

function completeSwitchToTarget() {
  const defKey = switchTargetKey;
  const def = WEAPON_DEFS[defKey];

  STATE.currentWeapon = defKey;
  STATE.maxAmmo = def.stats.maxAmmo;
  STATE.fireRate = def.stats.fireRate;
  STATE.reloadTime = def.stats.reloadTime;
  STATE.reloading = false;
  STATE.reloadProgress = 0;

  // Restore saved ammo or default to full
  STATE.ammo = (weaponAmmo[defKey] !== undefined) ? weaponAmmo[defKey] : def.stats.maxAmmo;

  buildWeaponModel(defKey);
  resetAnimationState();
  updateHUD();

  // Start raising
  switchPhase = 'raising';
  switchProgress = 0;
}

export function initWeaponAmmo() {
  // Initialize ammo for all weapons at game start
  for (const [key, def] of Object.entries(WEAPON_DEFS)) {
    weaponAmmo[key] = def.stats.maxAmmo;
  }
}

export function triggerRecoil() {
  const adsMult = STATE.ads ? 0.7 : 1.0;

  // Camera recoil
  recoilPitch += (1.5 + Math.random() * 1.0) * DEG * adsMult;
  recoilYaw += (Math.random() - 0.5) * 1.6 * DEG * adsMult;

  // Weapon model kick
  weaponKickPitch += 5 * DEG;
  weaponKickBack += 0.05;

  // 3D muzzle flash (~20% chance to skip for variation)
  if (Math.random() > 0.2) {
    muzzleFlashTimer = 0.04; // 40ms
    if (muzzleFlash3D) {
      const s = 0.3 + Math.random() * 0.2;
      muzzleFlash3D.scale.set(s / 0.15, s / 0.15, 1);
      muzzleFlash3D.material.opacity = 1;
      muzzleFlash3D.rotation.z = Math.random() * Math.PI;
    }
    if (muzzleLight) muzzleLight.intensity = 1.0;
  }
}

export function updateWeaponView(dt) {
  if (!weaponGroup) return;

  // ── ADS blend ───────────────────────────────────────
  const adsTarget = STATE.ads ? 1 : 0;
  const adsSpeed = currentDef ? currentDef.adsSpeed : 12;
  STATE.adsBlend += (adsTarget - STATE.adsBlend) * Math.min(1, dt * adsSpeed);

  // FOV
  camera.fov = BASE_FOV + (adsFov - BASE_FOV) * STATE.adsBlend;
  camera.updateProjectionMatrix();

  // ADS vignette
  if (adsVignette) adsVignette.style.opacity = STATE.adsBlend > 0.05 ? (STATE.adsBlend * 0.6).toFixed(2) : '0';

  // ── Movement state ──────────────────────────────────
  const distDelta = STATE.distance - prevDistance;
  prevDistance = STATE.distance;
  const isMoving = distDelta > 0.001;
  const isSprinting = isMoving && (keys['ShiftLeft'] || keys['ShiftRight']);
  const adsBobMult = STATE.ads ? 0.3 : 1.0;

  // ── Bob phase ───────────────────────────────────────
  if (isSprinting) {
    bobPhase += distDelta * 1.67;
  } else if (isMoving) {
    bobPhase += distDelta * 1.33;
  }
  idleTime += dt;

  // ── Bob offsets ─────────────────────────────────────
  let bobX = 0, bobY = 0, bobRoll = 0;

  if (isSprinting) {
    bobX = Math.sin(bobPhase) * 0.045 * adsBobMult;
    bobY = Math.abs(Math.sin(bobPhase)) * 0.06 * adsBobMult;
    bobRoll = Math.sin(bobPhase) * 4 * DEG * adsBobMult;
  } else if (isMoving) {
    bobX = Math.sin(bobPhase) * 0.025 * adsBobMult;
    bobY = Math.abs(Math.sin(bobPhase)) * 0.035 * adsBobMult;
  } else {
    // Idle sway
    bobX = Math.sin(idleTime * 1.5) * 0.004 * adsBobMult;
    bobY = Math.sin(idleTime * 3) * 0.003 * adsBobMult;
  }

  // ── Recoil → camera ────────────────────────────────
  if (Math.abs(recoilPitch) > 0.0001 || Math.abs(recoilYaw) > 0.0001) {
    const applyFactor = Math.min(1, dt / 0.03);
    const applyP = recoilPitch * applyFactor;
    const applyY = recoilYaw * applyFactor;
    addRecoil(applyP, applyY);
    recoilPitch -= applyP;
    recoilYaw -= applyY;
  }

  // Decay remaining recoil (200ms time constant)
  const recoveryRate = 1 - Math.exp(-dt / 0.2);
  recoilPitch *= (1 - recoveryRate);
  recoilYaw *= (1 - recoveryRate);

  // Weapon kick recovery (120ms time constant)
  const kickRate = 1 - Math.exp(-dt / 0.12);
  weaponKickPitch *= (1 - kickRate);
  weaponKickBack *= (1 - kickRate);

  // ── Muzzle flash decay ─────────────────────────────
  if (muzzleFlashTimer > 0) {
    muzzleFlashTimer -= dt;
    if (muzzleFlashTimer <= 0) {
      if (muzzleFlash3D) muzzleFlash3D.material.opacity = 0;
      if (muzzleLight) muzzleLight.intensity = 0;
    }
  }

  // ── Reload animation ───────────────────────────────
  let reloadPitch = 0, reloadRoll = 0, reloadY = 0;

  if (STATE.reloading && currentDef) {
    STATE.reloadProgress = Math.min(1, STATE.reloadProgress + dt / (STATE.reloadTime / 1000));
    const t = STATE.reloadProgress;
    const rd = currentDef.reload;

    if (t < 0.4) {
      // Phase 1: tip up and twist (ease-out)
      const p = t / 0.4;
      const ease = 1 - (1 - p) * (1 - p);
      reloadPitch = rd.tiltPitch * DEG * ease;
      reloadRoll = rd.tiltRoll * DEG * ease;
      reloadY = rd.dropY * ease;
    } else if (t < 0.8) {
      // Phase 2: hold tilted, subtle wobble
      const wobble = Math.sin((t - 0.4) / 0.4 * Math.PI * 2) * 0.005;
      reloadPitch = rd.tiltPitch * DEG;
      reloadRoll = rd.tiltRoll * DEG;
      reloadY = rd.dropY + wobble;
    } else {
      // Phase 3: return to rest
      const p = (t - 0.8) / 0.2;
      reloadPitch = rd.tiltPitch * DEG * (1 - p);
      reloadRoll = rd.tiltRoll * DEG * (1 - p);
      reloadY = rd.dropY * (1 - p);
    }
  }

  // ── Weapon switch animation ─────────────────────────
  let switchOffsetY = 0;

  if (switchPhase === 'lowering') {
    switchProgress = Math.min(1, switchProgress + dt * switchLowerSpeed);
    const ease = switchProgress * switchProgress; // ease-in (accelerate down)
    switchOffsetY = -0.5 * ease;
    if (switchProgress >= 1) {
      completeSwitchToTarget();
    }
  } else if (switchPhase === 'raising') {
    switchProgress = Math.min(1, switchProgress + dt * switchRaiseSpeed);
    const ease = 1 - (1 - switchProgress) * (1 - switchProgress); // ease-out (decelerate up)
    switchOffsetY = -0.5 * (1 - ease);
    if (switchProgress >= 1) {
      switchPhase = null;
      switchProgress = 0;
      switchTargetKey = null;
    }
  }

  // ── Apply to weapon group ──────────────────────────
  const baseX = hipPos.x + (adsPos.x - hipPos.x) * STATE.adsBlend;
  const baseY = hipPos.y + (adsPos.y - hipPos.y) * STATE.adsBlend;
  const baseZ = hipPos.z + (adsPos.z - hipPos.z) * STATE.adsBlend;

  weaponGroup.position.x = baseX + bobX;
  weaponGroup.position.y = baseY + bobY + reloadY + switchOffsetY;
  weaponGroup.position.z = baseZ - weaponKickBack;
  weaponGroup.rotation.x = -weaponKickPitch + reloadPitch;
  weaponGroup.rotation.y = 0;
  weaponGroup.rotation.z = bobRoll + reloadRoll;
}
