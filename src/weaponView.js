import * as THREE from 'three';
import { STATE } from './state.js';
import { camera } from './renderer.js';
import { addRecoil, keys } from './player.js';
import { WEAPON_DEFS, WEAPON_ORDER, computeStats, OPTIC_DEFS, ATTACHMENT_DEFS } from './weaponDefs.js';
import { updateCrosshair, setReticle } from './reticles.js';
import { updateHUD } from './hud.js';
import { cancelReload, invalidateStatsCache, applyStatsToState } from './weapons.js';
import { setPostFXMode, getPostFXMode } from './postfx.js';

// ─── CONSTANTS ────────────────────────────────────────────
const BASE_FOV = 80;  // spec §4.2: 80° hipfire FOV
const DEG = Math.PI / 180;

// ─── MUTABLE PER-WEAPON SETTINGS ─────────────────────────
let hipPos = new THREE.Vector3(0.32, -0.28, -0.5);
let adsPos = new THREE.Vector3(0.0, -0.17, -0.4);
let adsFov = 65;
let currentDef = null;

// ─── WEAPON MODEL ─────────────────────────────────────────
let weaponGroup = null;
let muzzleFlash3D = null;
let muzzleLight = null;
let adsVignette = null;

const matCache = {};
export function getMat(color) {
  if (!matCache[color]) {
    matCache[color] = new THREE.MeshPhongMaterial({ color, flatShading: true });
  }
  return matCache[color];
}

// Build a clean weapon mesh group from a weapon definition key.
// Returns a THREE.Group with named children — no muzzle flash, no camera attachment.
export function buildWeaponMesh(defKey) {
  const def = WEAPON_DEFS[defKey];
  const group = new THREE.Group();

  for (const [role, part] of Object.entries(def.parts)) {
    let mesh;
    if (part.radius !== undefined) {
      const geo = new THREE.CylinderGeometry(part.radius, part.radius, part.length, part.segments || 8);
      geo.rotateX(Math.PI / 2);
      mesh = new THREE.Mesh(geo, getMat(part.color));
    } else if (part.type === 'wedge') {
      mesh = new THREE.Mesh(createWedgeGeometry(part.size), getMat(part.color));
    } else if (part.type === 'pyramid') {
      mesh = new THREE.Mesh(createPyramidGeometry(part.size), getMat(part.color));
    } else {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(...part.size),
        getMat(part.color)
      );
    }
    mesh.position.set(...part.pos);
    if (part.rot) {
      mesh.rotation.set(...part.rot);
    }
    mesh.name = role;
    group.add(mesh);
  }

  return group;
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

  weaponGroup = buildWeaponMesh(defKey);

  // Add attachment geometry from current loadout (Step 10d)
  const slot = STATE.loadout.primary.weapon === defKey ? 'primary' : 'secondary';
  const loadoutAtts = STATE.loadout[slot]?.attachments;
  addAttachmentMeshesToGroup(weaponGroup, defKey, loadoutAtts);

  // 3D Muzzle flash — billboard quad at barrel tip
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffee88,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const flashGeo = new THREE.PlaneGeometry(0.15, 0.15);
  muzzleFlash3D = new THREE.Mesh(flashGeo, flashMat);
  muzzleFlash3D.position.set(...def.muzzleOffset);
  muzzleFlash3D.visible = false;
  muzzleFlash3D.userData.isHot = true;  // glow in thermal view
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

  // Set reticle based on loadout optic (falls back to weapon default)
  const opticKey = loadoutAtts?.optic || def.defaultOptic || 'iron_sights';
  const opticDef = OPTIC_DEFS[opticKey];
  if (opticDef) {
    setReticle(opticDef.reticle);
    if (opticDef.fov) adsFov = opticDef.fov;
  }
}

// Wedge geometry: triangular prism (for trigger guards, angled stocks, etc.)
export function createWedgeGeometry(size) {
  const [w, h, d] = size;
  const hw = w / 2, hh = h / 2, hd = d / 2;
  // Three.js computes face normal as (C-B)×(A-B) for triangle (A,B,C).
  // Winding must produce outward normals for correct culling & lighting.
  const vertices = new Float32Array([
    // front face (triangle) — normal -Z
    hw, -hh, -hd,  -hw, -hh, -hd,  0, hh, -hd,
    // back face (triangle) — normal +Z
    -hw, -hh, hd,   hw, -hh, hd,   0, hh, hd,
    // bottom face (quad as 2 triangles) — normal -Y
    -hw, -hh, -hd,  hw, -hh, -hd,   hw, -hh, hd,
    -hw, -hh, -hd,  hw, -hh, hd,   -hw, -hh, hd,
    // left face (quad as 2 triangles) — normal -X
    -hw, -hh, -hd, -hw, -hh, hd,    0, hh, hd,
    -hw, -hh, -hd,  0, hh, hd,      0, hh, -hd,
    // right face (quad as 2 triangles) — normal +X
    hw, -hh, hd,    hw, -hh, -hd,   0, hh, -hd,
    hw, -hh, hd,    0, hh, -hd,     0, hh, hd,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

// Pyramid geometry: 4-sided pyramid, apex at -Z (thin/weapon side), base at +Z (wide/shoulder side)
export function createPyramidGeometry(size) {
  const [w, h, d] = size;
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const vertices = new Float32Array([
    // base face — normal +Z (2 triangles)
    -hw, -hh, hd,   hw, -hh, hd,   hw, hh, hd,
    -hw, -hh, hd,   hw, hh, hd,   -hw, hh, hd,
    // bottom face — normal -Y
    0, 0, -hd,      hw, -hh, hd,  -hw, -hh, hd,
    // top face — normal +Y
    0, 0, -hd,     -hw, hh, hd,    hw, hh, hd,
    // left face — normal -X
    0, 0, -hd,     -hw, -hh, hd,  -hw, hh, hd,
    // right face — normal +X
    0, 0, -hd,      hw, hh, hd,    hw, -hh, hd,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

// ─── ATTACHMENT GEOMETRY DATA ─────────────────────────────
// Duplicated from workbench.js to avoid import chain issues.

const ATTACHMENT_GEOMETRY = {
  suppressor:    { mount: 'muzzle', parts: [{ radius: 0.022, length: 0.12, segments: 8, color: 0x2a2a2a, offset: [0, 0, -0.06] }] },
  compensator:   { mount: 'muzzle', parts: [{ size: [0.035, 0.035, 0.04], color: 0x3a3a3a, offset: [0, 0, -0.02] }] },
  flash_hider:   { mount: 'muzzle', parts: [{ radius: 0.018, length: 0.05, segments: 3, color: 0x2a2a2a, offset: [0, 0, -0.025] }] },
  muzzle_brake:  { mount: 'muzzle', parts: [{ size: [0.04, 0.03, 0.04], color: 0x3a3a3a, offset: [0, 0, -0.02] }] },
  long_barrel:   { mount: 'barrel_mod', barrelScale: [1.0, 1.0, 1.25], parts: [] },
  short_barrel:  { mount: 'barrel_mod', barrelScale: [1.0, 1.0, 0.7], parts: [] },
  heavy_barrel:  { mount: 'barrel_mod', barrelScale: [1.4, 1.4, 1.0], parts: [] },
  vertical_grip: { mount: 'underbarrel', parts: [{ size: [0.03, 0.08, 0.03], color: 0x4a3728, offset: [0, -0.04, 0] }] },
  angled_grip:   { mount: 'underbarrel', parts: [{ size: [0.03, 0.07, 0.03], color: 0x4a3728, offset: [0, -0.035, -0.015], rot: [0.4, 0, 0] }] },
  stubby_grip:   { mount: 'underbarrel', parts: [{ type: 'sphere', radius: 0.025, segments: 8, color: 0x4a3728, offset: [0, -0.025, 0] }] },
  bipod:         { mount: 'barrel_under', parts: [
    { radius: 0.006, length: 0.14, segments: 6, color: 0x2a2a2a, offset: [-0.015, -0.008, -0.07] },
    { radius: 0.006, length: 0.14, segments: 6, color: 0x2a2a2a, offset: [0.015, -0.008, -0.07] },
    { size: [0.04, 0.015, 0.02], color: 0x2a2a2a, offset: [0, -0.005, 0] },
  ]},
  extended_mag:    { mount: 'mag_bottom', parts: [{ size: [0.05, 0.04, 0.04], color: 0x3a3a3a, offset: [0, -0.02, 0] }] },
  fast_mag:        { mount: 'mag_bottom', parts: [{ size: [0.015, 0.025, 0.035], color: 0xf39c12, offset: [0, -0.005, 0.02] }] },
  drum_mag:        { mount: 'mag_replace', parts: [{ radius: 0.07, length: 0.08, segments: 12, color: 0x3a3a3a, offset: [0, -0.05, 0] }] },
  full_stock:      { mount: 'stock', parts: [
    { type: 'pyramid', size: [0.07, 0.09, 0.24], color: 0x3d3530, offset: [0, 0, 0.08] },
    { size: [0.07, 0.09, 0.015], color: 0x1a1a1a, offset: [0, 0, 0.20] },
  ]},
  skeleton_stock:  { mount: 'stock', parts: [
    { radius: 0.006, length: 0.22, segments: 6, color: 0x4a4a4a, offset: [0, 0.025, 0.11] },
    { radius: 0.006, length: 0.22, segments: 6, color: 0x4a4a4a, offset: [0, -0.020, 0.11] },
    { size: [0.04, 0.065, 0.012], color: 0x1a1a1a, offset: [0, 0.002, 0.22] },
  ]},
};

const OPTIC_GEOMETRY = {
  iron_sights:  { parts: [] },
  red_dot:      { mount: 'rail', parts: [{ size: [0.03, 0.035, 0.04], color: 0x1a1a1a, offset: [0, 0.02, 0] }] },
  holographic:  { mount: 'rail', parts: [{ size: [0.035, 0.04, 0.05], color: 0x2a2a2a, offset: [0, 0.02, 0] }] },
  acog:         { mount: 'rail', parts: [{ radius: 0.016, length: 0.08, segments: 8, color: 0x1a1a1a, offset: [0, 0.02, 0] }] },
  dmr_scope:    { mount: 'rail', parts: [{ radius: 0.018, length: 0.14, segments: 8, color: 0x1a1a1a, offset: [0, 0.02, 0] }] },
  sniper_scope: { mount: 'rail', parts: [{ radius: 0.020, length: 0.20, segments: 8, color: 0x1a1a1a, offset: [0, 0.02, 0] }] },
  sniper_12x:   { mount: 'rail', parts: [{ radius: 0.022, length: 0.24, segments: 8, color: 0x1a1a1a, offset: [0, 0.02, 0] }] },
  thermal:      { mount: 'rail', parts: [{ size: [0.04, 0.04, 0.06], color: 0x2a2a2a, offset: [0, 0.025, 0] }] },
};

const ACCESSORY_GEOMETRY = {
  laser_sight: { mount: 'accessory', parts: [
    { size: [0.02, 0.02, 0.04], color: 0x1a1a1a, offset: [0.01, 0, 0] },
    { radius: 0.003, length: 0.02, segments: 6, color: 0xff0000, offset: [0.01, 0, -0.03] },
  ]},
  flashlight:  { mount: 'accessory', parts: [
    { radius: 0.014, length: 0.06, segments: 8, color: 0x2a2a2a, offset: [0.01, 0, -0.01] },
    { radius: 0.012, length: 0.01, segments: 8, color: 0xffffcc, offset: [0.01, 0, -0.05] },
  ]},
  ir_laser:    { mount: 'accessory', parts: [{ size: [0.025, 0.025, 0.05], color: 0x1a1a1a, offset: [0.01, 0, 0] }] },
};

function getMountPoint(defKey, mountType) {
  const def = WEAPON_DEFS[defKey];
  const parts = def.parts;
  const body = parts.body;
  const barrel = parts.barrel;

  switch (mountType) {
    case 'muzzle':
    case 'barrel_end':
      if (barrel) return [barrel.pos[0], barrel.pos[1], barrel.pos[2] - barrel.length / 2];
      if (body) return [body.pos[0], body.pos[1], body.pos[2] - (body.size ? body.size[2] / 2 : 0.10)];
      return [0, 0, -0.10];
    case 'barrel_mid':
      if (barrel) return [barrel.pos[0], barrel.pos[1], barrel.pos[2]];
      return [0, 0, -0.05];
    case 'barrel_under':
      if (barrel) return [barrel.pos[0], barrel.pos[1] - (barrel.radius || 0.02), barrel.pos[2]];
      return [0, -0.03, -0.10];
    case 'underbarrel': {
      const hg = parts.handguard;
      if (hg) return [hg.pos[0], hg.pos[1] - (hg.size ? hg.size[1] / 2 : 0.04), hg.pos[2]];
      if (body) return [body.pos[0], body.pos[1] - (body.size ? body.size[1] / 2 : 0.05), body.pos[2] - (body.size ? body.size[2] / 4 : 0.05)];
      return [0, -0.05, -0.05];
    }
    case 'rail': {
      const r = parts.rail;
      if (r) return [r.pos[0], r.pos[1], r.pos[2]];
      if (body) return [body.pos[0], body.pos[1] + (body.size ? body.size[1] / 2 : 0.05), body.pos[2]];
      return [0, 0.07, -0.05];
    }
    case 'accessory': {
      const hg = parts.handguard;
      if (hg) return [hg.size ? hg.size[0] / 2 : 0.04, hg.pos[1], hg.pos[2]];
      if (body) return [body.size ? body.size[0] / 2 : 0.04, body.pos[1], body.pos[2] - (body.size ? body.size[2] / 4 : 0.05)];
      return [0.04, 0, -0.10];
    }
    case 'mag_bottom': {
      const m = parts.magazine || parts.boxMag;
      if (m) return [m.pos[0], m.pos[1] - (m.size ? m.size[1] / 2 : 0.08), m.pos[2]];
      const g = parts.grip;
      if (g) return [g.pos[0], g.pos[1] - (g.size ? g.size[1] / 2 : 0.04), g.pos[2]];
      return [0, -0.15, 0.05];
    }
    case 'mag_replace': {
      const m = parts.magazine || parts.boxMag;
      if (m) return [m.pos[0], m.pos[1], m.pos[2]];
      if (body) return [body.pos[0], body.pos[1] - (body.size ? body.size[1] / 2 : 0.05), body.pos[2]];
      return [0, -0.05, 0.05];
    }
    case 'stock':
      if (body) return [body.pos[0], body.pos[1], body.pos[2] + (body.size ? body.size[2] / 2 : 0.10)];
      return [0, 0, 0.20];
    default: return [0, 0, 0];
  }
}

function isStockPart(name) {
  return name && (name.startsWith('stock') || name === 'cheekRest');
}

function isIronSightPart(name) {
  return name && (name.startsWith('sight') || name === 'scope');
}

/** Add attachment meshes to the weapon group based on current loadout. */
function addAttachmentMeshesToGroup(group, defKey, attachments) {
  if (!attachments) return;

  const optic = attachments.optic;
  if (optic && optic !== 'iron_sights') {
    group.traverse(c => { if (c.isMesh && isIronSightPart(c.name)) c.visible = false; });
  }
  if (attachments.stock) {
    group.traverse(c => { if (c.isMesh && isStockPart(c.name)) c.visible = false; });
  }

  for (const [slot, attKey] of Object.entries(attachments)) {
    if (!attKey) continue;

    let geoDef;
    if (slot === 'optic') geoDef = OPTIC_GEOMETRY[attKey];
    else if (slot === 'accessory') geoDef = ACCESSORY_GEOMETRY[attKey];
    else geoDef = ATTACHMENT_GEOMETRY[attKey];

    if (!geoDef) continue;

    // Barrel modification: scale the barrel mesh
    if (geoDef.barrelScale) {
      group.traverse(c => { if (c.isMesh && c.name === 'barrel') c.scale.set(...geoDef.barrelScale); });
      continue;
    }

    if (!geoDef.parts || geoDef.parts.length === 0) continue;

    const mp = getMountPoint(defKey, geoDef.mount);
    if (!mp) continue;

    for (const p of geoDef.parts) {
      let mesh;
      if (p.type === 'pyramid') {
        mesh = new THREE.Mesh(createPyramidGeometry(p.size), getMat(p.color));
      } else if (p.type === 'sphere') {
        mesh = new THREE.Mesh(new THREE.SphereGeometry(p.radius, p.segments || 8, p.segments || 8), getMat(p.color));
      } else if (p.radius !== undefined) {
        const geo = new THREE.CylinderGeometry(p.radius, p.radius, p.length, p.segments || 8);
        geo.rotateX(Math.PI / 2);
        mesh = new THREE.Mesh(geo, getMat(p.color));
      } else {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(...p.size), getMat(p.color));
      }
      mesh.position.set(mp[0] + p.offset[0], mp[1] + p.offset[1], mp[2] + p.offset[2]);
      if (p.rot) mesh.rotation.set(...p.rot);
      mesh.name = `att_${slot}`;
      group.add(mesh);
    }

    // Drum mag hides original magazine
    if (attKey === 'drum_mag') {
      group.traverse(c => { if (c.isMesh && (c.name === 'magazine' || c.name === 'boxMag')) c.visible = false; });
    }
  }
}

// ─── ANIMATION STATE ──────────────────────────────────────
let bobPhase = 0;
let prevDistance = 0;
let idleTime = 0;

// Muzzle flash
let muzzleFlashTimer = 0;

// Recoil — deterministic pattern system (step 4)
let recoilPitch = 0;     // pending camera recoil to apply
let recoilYaw = 0;
let accRecoilPitch = 0;  // accumulated recoil for recovery tracking
let accRecoilYaw = 0;
let lastShotTime = 0;    // for recovery delay

// Visual weapon kick — spring-damper (step 4)
let weaponKickPitch = 0;
let weaponKickBack = 0;
let kickVelPitch = 0;
let kickVelBack = 0;

// Weapon switch animation
let switchPhase = null;
let switchProgress = 0;
let switchTargetKey = null;
let switchLowerSpeed = 3.0;
let switchRaiseSpeed = 3.0;

// Per-weapon ammo persistence
const weaponAmmo = {};

function resetAnimationState() {
  recoilPitch = 0;
  recoilYaw = 0;
  accRecoilPitch = 0;
  accRecoilYaw = 0;
  lastShotTime = 0;
  weaponKickPitch = 0;
  weaponKickBack = 0;
  kickVelPitch = 0;
  kickVelBack = 0;
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
  STATE.adsHeld = false;
  STATE.reloadProgress = 0;
  camera.fov = BASE_FOV;
  camera.updateProjectionMatrix();
  if (weaponGroup) weaponGroup.position.copy(hipPos);
}

export function isSwitching() {
  return switchPhase !== null;
}

export function switchWeapon(defKey) {
  if (defKey === STATE.currentWeapon) return;
  if (switchPhase !== null) return;

  if (STATE.reloading) cancelReload();

  weaponAmmo[STATE.currentWeapon] = STATE.ammo;

  switchPhase = 'lowering';
  switchProgress = 0;
  switchTargetKey = defKey;
  switchLowerSpeed = currentDef ? currentDef.drawSpeed : 3.0;
  switchRaiseSpeed = WEAPON_DEFS[defKey].drawSpeed;

  STATE.ads = false;
}

function completeSwitchToTarget() {
  const defKey = switchTargetKey;
  const def = WEAPON_DEFS[defKey];

  STATE.currentWeapon = defKey;
  STATE.reloading = false;
  STATE.reloadProgress = 0;
  STATE.shotCount = 0;
  STATE.sustainedFireMult = 1.0;
  STATE.fireMode = def.baseStats.fireMode;

  // Apply attachment-modified stats (Step 10e)
  invalidateStatsCache();
  applyStatsToState();

  STATE.ammo = (weaponAmmo[defKey] !== undefined) ? weaponAmmo[defKey] : STATE.maxAmmo;

  buildWeaponModel(defKey);
  resetAnimationState();
  updateHUD();

  switchPhase = 'raising';
  switchProgress = 0;
}

/** Rebuild the current weapon model and recompute stats (after workbench/attachment change). */
export function rebuildCurrentWeapon() {
  invalidateStatsCache();
  applyStatsToState();
  buildWeaponModel(STATE.currentWeapon);
  resetAnimationState();
  updateHUD();
}

export function initWeaponAmmo() {
  for (const [key, def] of Object.entries(WEAPON_DEFS)) {
    weaponAmmo[key] = def.baseStats.magSize;
  }
}

// ─── RECOIL API (Step 4) ─────────────────────────────────
// Called by weapons.js with deterministic pattern values
export function triggerRecoil(pitchDeg, yawDeg, suppressed = false) {
  // Camera recoil (will be applied gradually in updateWeaponView)
  const pitchRad = pitchDeg * DEG;
  const yawRad = yawDeg * DEG;
  recoilPitch += pitchRad;
  recoilYaw += yawRad;
  accRecoilPitch += pitchRad;
  accRecoilYaw += yawRad;
  lastShotTime = performance.now();

  // Visual weapon kick (spring-damper driven)
  const weight = currentDef ? currentDef.baseStats.weight : 3.0;
  weaponKickPitch += pitchDeg * DEG * 0.5;
  weaponKickBack += 0.005 + 0.003 * weight;

  // 3D muzzle flash — suppressor removes flash entirely (Step 10c)
  if (!suppressed && Math.random() > 0.2) {
    muzzleFlashTimer = 0.04;
    if (muzzleFlash3D) {
      muzzleFlash3D.visible = true;
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

  // ── ADS blend (Step 5: time-based transition) ──────────
  const adsTime = STATE.effectiveAdsTime || (currentDef ? currentDef.baseStats.adsTime : 0.15);
  if (STATE.ads) {
    STATE.adsBlend = Math.min(1, STATE.adsBlend + dt / adsTime);
  } else {
    STATE.adsBlend = Math.max(0, STATE.adsBlend - dt / (adsTime * 0.8)); // slightly faster exit
  }

  // Thermal optic activation (Step 11e)
  const slot = STATE.loadout.primary.weapon === STATE.currentWeapon ? 'primary' : 'secondary';
  const equippedOptic = STATE.loadout[slot]?.attachments?.optic;
  if (equippedOptic === 'thermal') {
    if (STATE.ads && getPostFXMode() !== 'thermal') {
      setPostFXMode('thermal', 1.0 / adsTime);
    } else if (!STATE.ads && getPostFXMode() === 'thermal') {
      // When exiting thermal ADS, restore NV if it was active
      if (STATE.nvActive) {
        setPostFXMode('nv', 1.0 / (adsTime * 0.8));
      } else {
        setPostFXMode('none', 1.0 / (adsTime * 0.8));
      }
    }
  }

  // FOV
  const targetFov = adsFov;
  camera.fov = BASE_FOV + (targetFov - BASE_FOV) * STATE.adsBlend;
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
    bobX = Math.sin(idleTime * 1.5) * 0.004 * adsBobMult;
    bobY = Math.sin(idleTime * 3) * 0.003 * adsBobMult;
  }

  // ── Recoil → camera (Step 4: pattern-based) ────────
  // Apply pending recoil to camera smoothly over a short window
  if (Math.abs(recoilPitch) > 0.0001 || Math.abs(recoilYaw) > 0.0001) {
    const applyFactor = Math.min(1, dt / 0.03);
    const applyP = recoilPitch * applyFactor;
    const applyY = recoilYaw * applyFactor;
    addRecoil(applyP, applyY);
    recoilPitch -= applyP;
    recoilYaw -= applyY;
  }

  // Recoil recovery: drift camera back after a delay
  const now = performance.now();
  const recoveryDelay = currentDef ? (1000 / currentDef.baseStats.rateOfFire) : 100;
  const recoveryRate = currentDef ? currentDef.recoilRecoveryRate : 5;

  if (now - lastShotTime > recoveryDelay && (Math.abs(accRecoilPitch) > 0.0001 || Math.abs(accRecoilYaw) > 0.0001)) {
    const maxRecovery = recoveryRate * DEG * dt;
    // Recover pitch
    if (Math.abs(accRecoilPitch) > 0.0001) {
      const recoverP = Math.min(Math.abs(accRecoilPitch), maxRecovery);
      const signP = Math.sign(accRecoilPitch);
      addRecoil(-signP * recoverP, 0);
      accRecoilPitch -= signP * recoverP;
    }
    // Recover yaw
    if (Math.abs(accRecoilYaw) > 0.0001) {
      const recoverY = Math.min(Math.abs(accRecoilYaw), maxRecovery * 0.5);
      const signY = Math.sign(accRecoilYaw);
      addRecoil(0, -signY * recoverY);
      accRecoilYaw -= signY * recoverY;
    }
  }

  // ── Weapon kick spring-damper (Step 4) ─────────────
  const weight = currentDef ? currentDef.baseStats.weight : 3.0;
  const stiffness = Math.max(10, 20 - weight);  // heavier = slower return
  const damping = 8;

  kickVelPitch += (-stiffness * weaponKickPitch - damping * kickVelPitch) * dt;
  weaponKickPitch += kickVelPitch * dt;

  kickVelBack += (-stiffness * weaponKickBack - damping * kickVelBack) * dt;
  weaponKickBack += kickVelBack * dt;

  // ── Muzzle flash decay ─────────────────────────────
  if (muzzleFlashTimer > 0) {
    muzzleFlashTimer -= dt;
    if (muzzleFlashTimer <= 0) {
      if (muzzleFlash3D) { muzzleFlash3D.material.opacity = 0; muzzleFlash3D.visible = false; }
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
      const p = t / 0.4;
      const ease = 1 - (1 - p) * (1 - p);
      reloadPitch = rd.tiltPitch * DEG * ease;
      reloadRoll = rd.tiltRoll * DEG * ease;
      reloadY = rd.dropY * ease;
    } else if (t < 0.8) {
      const wobble = Math.sin((t - 0.4) / 0.4 * Math.PI * 2) * 0.005;
      reloadPitch = rd.tiltPitch * DEG;
      reloadRoll = rd.tiltRoll * DEG;
      reloadY = rd.dropY + wobble;
    } else {
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
    const ease = switchProgress * switchProgress;
    switchOffsetY = -0.5 * ease;
    if (switchProgress >= 1) {
      completeSwitchToTarget();
    }
  } else if (switchPhase === 'raising') {
    switchProgress = Math.min(1, switchProgress + dt * switchRaiseSpeed);
    const ease = 1 - (1 - switchProgress) * (1 - switchProgress);
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
  weaponGroup.position.z = baseZ - Math.max(0, weaponKickBack);
  weaponGroup.rotation.x = -Math.max(0, weaponKickPitch) + reloadPitch;
  weaponGroup.rotation.y = 0;
  weaponGroup.rotation.z = bobRoll + reloadRoll;

  // ── Update crosshair / reticle (Step 6) ──────────────
  updateCrosshair(STATE.currentSpread, STATE.adsBlend, camera.fov);
}

// ─── EJECTION DATA (Step 9b) ─────────────────────────────
// Returns world-space ejection port position and camera orientation vectors.
const _ejRight = new THREE.Vector3();
const _ejUp = new THREE.Vector3();
const _ejFwd = new THREE.Vector3();

export function getEjectionData() {
  if (!weaponGroup || !currentDef || !currentDef.ejectionOffset) return null;
  const worldPos = new THREE.Vector3(...currentDef.ejectionOffset);
  weaponGroup.localToWorld(worldPos);
  camera.matrixWorld.extractBasis(_ejRight, _ejUp, _ejFwd);
  return { worldPos, camRight: _ejRight.clone(), camUp: _ejUp.clone() };
}
