import * as THREE from 'three';
import {
  STATE, PLAYER_HEIGHT, MOVE_SPEED, SPRINT_MULT, MOUSE_SENS,
  GRAVITY, PLAYER_HALF_W, JUMP_IMPULSE, STEP_HEIGHT,
  CROUCH_HEIGHT, CROUCH_EYE, CROUCH_SPEED_MULT, PLAYER_EYE_HEIGHT,
  LADDER_CLIMB_SPEED, LADDER_YAW_LIMIT, LADDER_DISMOUNT_IMPULSE,
  LADDER_INTERACT_RANGE, PALLET_INTERACT_RANGE, pallets, weaponCrates,
} from './state.js';
import { camera, playerLight } from './renderer.js';
import { shootBullet, reload, toggleFireMode } from './weapons.js';
import { getHeight } from './terrain.js';
import { switchWeapon, rebuildCurrentWeapon } from './weaponView.js';
import { WEAPON_DEFS, computeStats } from './weaponDefs.js';
import { invalidateStatsCache, applyStatsToState } from './weapons.js';
import { setPostFXMode, getPostFXMode } from './postfx.js';
import { gatherColliders, confirmCollision } from './collision.js';
import { ladderDefs } from './buildings.js';
import { showInteractPrompt, hideInteractPrompt, takeDamage } from './hud.js';

// ─── INPUT STATE ───────────────────────────────────────────
export const keys = {};
let pitch = 0;
let yaw = 0;
let skipMouseFrames = 0;

// ─── PLAYER PHYSICS STATE ──────────────────────────────────
let footY = 0;            // foot position (world Y)
let velocityY = 0;
let isGrounded = true;
let wasGrounded = true;    // previous frame's grounded state (for fall damage)
let isCrouching = false;
let playerHeight = PLAYER_HEIGHT;
let eyeHeight = PLAYER_EYE_HEIGHT;

// ─── LADDER STATE ─────────────────────────────────────────
let ladderState = null;       // current LadderDef or null
let ladderBaseYaw = 0;        // yaw facing the wall when entering
let dismountVelX = 0;
let dismountVelZ = 0;

// ─── CAMERA BOB ──────────────────────────────────────────
let cameraBobPhase = 0;

// ─── SCREEN SHAKE ─────────────────────────────────────────
let shakeIntensity = 0;
let shakeDecayRate = 0.1;

export function getPlayerYaw() { return yaw; }

export function addScreenShake(intensity, decayTime) {
  shakeIntensity = Math.max(shakeIntensity, intensity);
  shakeDecayRate = decayTime || 0.016;
}

// ─── RECOIL API ─────────────────────────────────────────
export function addRecoil(pitchDelta, yawDelta) {
  pitch += pitchDelta;
  yaw += yawDelta;
  pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, pitch));
}

export function initPlayer() {
  const canvas = document.getElementById('game-canvas');

  document.addEventListener('keydown', e => {
    if (STATE.workbenchOpen) return;
    keys[e.code] = true;
    if (e.code === 'KeyR' && !STATE.onLadder) reload();
    if (e.code === 'KeyE') tryInteract();
    if (e.code === 'KeyF') trySwapWeaponCrate();
    if (e.code === 'KeyB') toggleFireMode();
    if (e.code === 'KeyN') {
      // Toggle night vision (helmet-mounted, not ADS-dependent)
      STATE.nvActive = !STATE.nvActive;
      if (STATE.nvActive) {
        // NV disabled while thermal ADS is active (thermal takes priority)
        if (getPostFXMode() !== 'thermal') {
          setPostFXMode('nv', 6.0);
        }
      } else {
        if (getPostFXMode() === 'nv') {
          setPostFXMode('none', 6.0);
        }
      }
    }
    // Weapon slots: 1 = secondary, 2 = primary
    if (e.code === 'Digit1' && STATE.loadout.secondary) switchWeapon(STATE.loadout.secondary.weapon);
    if (e.code === 'Digit2' && STATE.loadout.primary) switchWeapon(STATE.loadout.primary.weapon);
  });
  document.addEventListener('keyup', e => { if (!STATE.workbenchOpen) keys[e.code] = false; });

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) skipMouseFrames = 2;
  });

  document.addEventListener('mousemove', e => {
    if (!STATE.started || STATE.dead || STATE.dying) return;
    if (document.pointerLockElement !== canvas) return;
    if (skipMouseFrames > 0) { skipMouseFrames--; return; }
    const MAX_MOUSE_DELTA = 150;
    const dx = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, e.movementX));
    const dy = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, e.movementY));
    yaw -= dx * MOUSE_SENS;
    pitch -= dy * MOUSE_SENS;
    pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, pitch));
    if (yaw > Math.PI) yaw -= Math.PI * 2;
    else if (yaw < -Math.PI) yaw += Math.PI * 2;
  });

  document.addEventListener('mousedown', e => {
    if (STATE.workbenchOpen) return;
    if (e.button === 0 && STATE.started && !STATE.dead && !STATE.dying) {
      STATE.mouseHeld = true;
      shootBullet(); // immediate fire for responsiveness
    }
    if (e.button === 2 && STATE.started && !STATE.dead && !STATE.dying && !STATE.onLadder) {
      STATE.adsHeld = true;
      STATE.ads = true;
    }
  });

  document.addEventListener('mouseup', e => {
    if (STATE.workbenchOpen) return;
    if (e.button === 0) STATE.mouseHeld = false;
    if (e.button === 2) {
      STATE.adsHeld = false;
      STATE.ads = false;
    }
  });

  document.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('click', () => {
    if (STATE.started && !STATE.dead && !STATE.workbenchOpen && document.pointerLockElement !== canvas) {
      canvas.requestPointerLock();
    }
  });
}

// ─── RESET ─────────────────────────────────────────────────
export function resetPlayer() {
  footY = 0;
  velocityY = 0;
  isGrounded = true;
  wasGrounded = true;
  isCrouching = false;
  playerHeight = PLAYER_HEIGHT;
  eyeHeight = PLAYER_EYE_HEIGHT;
  ladderState = null;
  STATE.onLadder = false;
  dismountVelX = 0;
  dismountVelZ = 0;
  camera.position.set(0, footY + eyeHeight, 0);
  camera.rotation.order = 'YXZ';
  yaw = 0;
  pitch = 0;
  cameraBobPhase = 0;
  shakeIntensity = 0;
}

// ─── AABB CONSTRUCTION ────────────────────────────────────
function makePlayerAABB(cx, fY, cz, h) {
  return {
    minX: cx - PLAYER_HALF_W, maxX: cx + PLAYER_HALF_W,
    minY: fY, maxY: fY + (h ?? playerHeight),
    minZ: cz - PLAYER_HALF_W, maxZ: cz + PLAYER_HALF_W,
  };
}

// ─── INTERACTION ─────────────────────────────────────────
let _onPalletInteract = null;
export function setOnPalletInteract(fn) { _onPalletInteract = fn; }

function tryInteract() {
  if (ladderState || STATE.dead || !STATE.started) return;

  const px = camera.position.x;
  const pz = camera.position.z;
  const py = footY;

  // Ladders
  for (const lad of ladderDefs) {
    const dx = px - lad.cx;
    const dz = pz - lad.cz;
    const distXZ = Math.sqrt(dx * dx + dz * dz);
    if (distXZ > LADDER_INTERACT_RANGE) continue;
    if (py < lad.baseY - 0.5 || py > lad.topY + 0.5) continue;
    const lookX = -Math.sin(yaw);
    const lookZ = -Math.cos(yaw);
    const dot = lookX * (-lad.normal.x) + lookZ * (-lad.normal.z);
    if (dot < 0.3) continue;
    enterLadder(lad);
    return;
  }

  // Airdrop pallets
  if (_onPalletInteract) {
    for (const p of pallets) {
      const dx = px - p.mesh.position.x;
      const dz = pz - p.mesh.position.z;
      if (dx * dx + dz * dz > PALLET_INTERACT_RANGE * PALLET_INTERACT_RANGE) continue;
      if (Math.abs(py - p.mesh.position.y) > 2.0) continue;
      _onPalletInteract();
      return;
    }
  }
}

// ─── WEAPON CRATE SWAP (Step 14c) ─────────────────────────
function trySwapWeaponCrate() {
  if (STATE.dead || !STATE.started || STATE.workbenchOpen) return;
  const px = camera.position.x, py = camera.position.y - PLAYER_EYE_HEIGHT, pz = camera.position.z;
  const r2 = PALLET_INTERACT_RANGE * PALLET_INTERACT_RANGE;

  for (const crate of weaponCrates) {
    if (crate.collected) continue;
    const dx = px - crate.mesh.position.x;
    const dz = pz - crate.mesh.position.z;
    if (dx * dx + dz * dz > r2) continue;
    if (Math.abs(py - crate.mesh.position.y) > 2.0) continue;

    // Swap player's primary for crate weapon
    const crateData = crate.crateData;
    const oldWeapon = STATE.loadout.primary.weapon;
    const oldAtts = { ...STATE.loadout.primary.attachments };

    STATE.loadout.primary.weapon = crateData.weapon;
    STATE.loadout.primary.attachments = { ...crateData.attachments };

    // Put old weapon in crate (so player can swap back)
    crate.crateData = { weapon: oldWeapon, attachments: oldAtts };

    // Switch to the new weapon
    invalidateStatsCache();
    if (crateData.weapon !== STATE.currentWeapon) {
      switchWeapon(crateData.weapon);
    } else {
      rebuildCurrentWeapon();
    }

    hideInteractPrompt();
    return;
  }
}

function enterLadder(lad) {
  ladderState = lad;
  STATE.onLadder = true;
  ladderBaseYaw = Math.atan2(lad.normal.x, lad.normal.z);
  velocityY = 0;
  isGrounded = false;
  // Snap XZ to ladder position, offset from wall
  camera.position.x = lad.cx + lad.normal.x * 0.3;
  camera.position.z = lad.cz + lad.normal.z * 0.3;
}

function exitLadder(x, y, z) {
  ladderState = null;
  STATE.onLadder = false;
  footY = y;
  camera.position.set(x, y + eyeHeight, z);
  playerLight.position.copy(camera.position);
}

export function forceLadderDismount() {
  if (!ladderState) return;
  exitLadder(camera.position.x, footY, camera.position.z);
  isGrounded = false;
  // No impulse — just fall from current height
}

function updateLadderMode(dt) {
  const lad = ladderState;

  // Vertical movement
  let climbDir = 0;
  if (keys['KeyW']) climbDir = 1;
  if (keys['KeyS']) climbDir = -1;
  footY += climbDir * LADDER_CLIMB_SPEED * dt;

  // Clamp to ladder range
  footY = Math.max(lad.baseY, Math.min(lad.topY - playerHeight, footY));

  // Lock XZ to ladder position
  const posX = lad.cx + lad.normal.x * 0.3;
  const posZ = lad.cz + lad.normal.z * 0.3;

  // Restrict yaw to ±60° from base yaw
  let yawDelta = yaw - ladderBaseYaw;
  // Normalize to [-PI, PI]
  while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
  while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
  const clampedDelta = Math.max(-LADDER_YAW_LIMIT, Math.min(LADDER_YAW_LIMIT, yawDelta));
  yaw = ladderBaseYaw + clampedDelta;

  // Update camera
  camera.position.set(posX, footY + eyeHeight, posZ);
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  playerLight.position.copy(camera.position);

  // Exit: reached top
  if (climbDir > 0 && footY >= lad.topY - playerHeight) {
    exitLadder(
      lad.cx + lad.normal.x * 0.5,
      lad.topY,
      lad.cz + lad.normal.z * 0.5,
    );
    isGrounded = true;
    velocityY = 0;
    return;
  }
  // Exit: reached bottom
  if (climbDir < 0 && footY <= lad.baseY) {
    exitLadder(
      lad.cx + lad.normal.x * 0.5,
      lad.baseY,
      lad.cz + lad.normal.z * 0.5,
    );
    isGrounded = true;
    velocityY = 0;
    return;
  }
  // Exit: jump off backward
  if (keys['Space']) {
    exitLadder(camera.position.x, footY, camera.position.z);
    isGrounded = false;
    dismountVelX = lad.normal.x * LADDER_DISMOUNT_IMPULSE;
    dismountVelZ = lad.normal.z * LADDER_DISMOUNT_IMPULSE;
    return;
  }
}

// ─── PLAYER UPDATE ─────────────────────────────────────────
export function updatePlayer(dt) {
  if (STATE.dead) return;

  // ── Death animation ────────────────────────────────────────
  if (STATE.dying) {
    // Camera drops to ground over 0.5s
    const dropTarget = footY + 0.3;
    const currentEye = camera.position.y;
    if (STATE.deathTimer < 0.5) {
      const t = Math.min(1, STATE.deathTimer / 0.5);
      camera.position.y = currentEye + (dropTarget - currentEye) * (t * 0.1);
      // Slight pitch tilt
      pitch = Math.max(pitch - dt * 0.5, -0.3);
      camera.rotation.x = pitch;
    }
    return; // no movement, shooting, etc. during death
  }

  // ── Fall stun tick ─────────────────────────────────────────
  if (STATE.fallStunTimer > 0) {
    STATE.fallStunTimer -= dt;
    if (STATE.fallStunTimer <= 0) {
      STATE.fallStunTimer = 0;
      STATE.fallStunSpeedMult = 1.0;
    }
  }

  // ── Ladder mode ─────────────────────────────────────────
  if (ladderState) {
    updateLadderMode(dt);
    return;
  }

  let posX = camera.position.x;
  let posZ = camera.position.z;

  // ── Crouch ────────────────────────────────────────────────
  const wantCrouch = !!(keys['KeyC'] || keys['ControlLeft'] || keys['ControlRight']);
  if (wantCrouch && !isCrouching) {
    isCrouching = true;
    playerHeight = CROUCH_HEIGHT;
    eyeHeight = CROUCH_EYE;
  } else if (!wantCrouch && isCrouching) {
    // Check if we can stand up
    const testAABB = makePlayerAABB(posX, footY, posZ, PLAYER_HEIGHT);
    const blockers = gatherColliders(testAABB);
    let blocked = false;
    for (const col of blockers) {
      if (confirmCollision(testAABB, col)) { blocked = true; break; }
    }
    if (!blocked) {
      isCrouching = false;
      playerHeight = PLAYER_HEIGHT;
      eyeHeight = PLAYER_EYE_HEIGHT;
    }
  }

  // ── Export stance to STATE for weapon system ────────────
  STATE.isCrouching = isCrouching;
  STATE.isGrounded = isGrounded;

  // ── Sprint / ADS interaction (Step 5) ───────────────────
  const wantSprint = !!(keys['ShiftLeft'] || keys['ShiftRight']);
  const hasMovement = !!(keys['KeyW'] || keys['KeyS'] || keys['KeyA'] || keys['KeyD']);
  const sprinting = wantSprint && hasMovement && !STATE.ads && !isCrouching;

  // Sprint breaks ADS
  if (wantSprint && hasMovement && STATE.ads) {
    STATE.ads = false;
  }

  STATE.isSprinting = sprinting;

  // ── Movement input ────────────────────────────────────────
  const weaponDef = WEAPON_DEFS[STATE.currentWeapon];
  const weaponMoveSpeed = weaponDef ? weaponDef.baseStats.moveSpeed : 1.0;
  const weaponAdsSpeed = weaponDef ? weaponDef.baseStats.adsSpeed : 0.6;
  const adsMult = STATE.ads ? weaponAdsSpeed : 1.0;
  const crouchMult = isCrouching ? CROUCH_SPEED_MULT : 1.0;
  const stunMult = STATE.fallStunTimer > 0 ? STATE.fallStunSpeedMult : 1.0;
  const sprintMult = sprinting ? SPRINT_MULT : 1;
  const speed = MOVE_SPEED * weaponMoveSpeed * sprintMult * adsMult * crouchMult * stunMult;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

  const moveDir = new THREE.Vector3();
  if (keys['KeyW']) moveDir.add(forward);
  if (keys['KeyS']) moveDir.sub(forward);
  if (keys['KeyA']) moveDir.sub(right);
  if (keys['KeyD']) moveDir.add(right);

  if (moveDir.length() > 0) moveDir.normalize().multiplyScalar(speed * dt);

  // Export movement state
  STATE.isMoving = moveDir.length() > 0.001;

  // ── Ladder dismount velocity ───────────────────────────────
  if (dismountVelX || dismountVelZ) {
    moveDir.x += dismountVelX * dt;
    moveDir.z += dismountVelZ * dt;
    dismountVelX *= 0.85;
    dismountVelZ *= 0.85;
    if (Math.abs(dismountVelX) < 0.01) dismountVelX = 0;
    if (Math.abs(dismountVelZ) < 0.01) dismountVelZ = 0;
  }

  // ── Track pre-landing state for fall damage ──────────────
  const wasGroundedThisFrame = isGrounded;
  const preLandingVelocityY = velocityY;

  // ── Jump ──────────────────────────────────────────────────
  if (keys['Space'] && isGrounded) {
    velocityY = JUMP_IMPULSE;
    isGrounded = false;
  }

  // ── Gravity ───────────────────────────────────────────────
  if (!isGrounded) {
    velocityY += GRAVITY * dt;
  }

  // ── Y-axis resolution (gravity + jump) ────────────────────
  {
    const deltaY = velocityY * dt;
    const candidateFootY = footY + deltaY;
    const terrainY = getHeight(posX, posZ);

    // Test against terrain first
    let resolvedFootY = candidateFootY;
    let hitGround = false;

    if (resolvedFootY <= terrainY) {
      resolvedFootY = terrainY;
      velocityY = 0;
      hitGround = true;
    }

    // Test against building colliders
    const yTestAABB = makePlayerAABB(posX, Math.min(footY, resolvedFootY), posZ,
      playerHeight + Math.abs(deltaY));
    const yCandidates = gatherColliders(yTestAABB);

    for (const col of yCandidates) {
      const pAABB = makePlayerAABB(posX, resolvedFootY, posZ);
      if (!confirmCollision(pAABB, col)) continue;

      if (deltaY <= 0) {
        // Moving down — land on top of collider
        resolvedFootY = col.aabb.maxY;
        velocityY = 0;
        hitGround = true;
      } else {
        // Moving up — hit ceiling
        resolvedFootY = col.aabb.minY - playerHeight;
        velocityY = 0;
      }
    }

    footY = resolvedFootY;
    isGrounded = hitGround;

    // Ground probe: check if there's a surface within 0.05m below feet
    if (!isGrounded) {
      const terrainBelow = getHeight(posX, posZ);
      if (footY - terrainBelow < 0.05) {
        isGrounded = true;
        velocityY = 0;
      } else {
        // Check building colliders below
        const probeAABB = makePlayerAABB(posX, footY - 0.05, posZ, 0.05);
        const probes = gatherColliders(probeAABB);
        for (const col of probes) {
          if (confirmCollision(probeAABB, col)) {
            isGrounded = true;
            velocityY = 0;
            break;
          }
        }
      }
    }

    // ── Fall damage check ──────────────────────────────────
    if (isGrounded && !wasGroundedThisFrame) {
      const fallSpeed = Math.abs(preLandingVelocityY);
      if (fallSpeed > 8) {
        let damage = Math.min(100, (fallSpeed - 8) * 10);
        if (fallSpeed > 20) damage = 100;
        takeDamage(damage);
        addScreenShake(0.003 * fallSpeed / 8, 0.3);
        // Movement penalty
        if (damage > 50) {
          STATE.fallStunTimer = 3.0;
          STATE.fallStunSpeedMult = 0.4;
        } else if (damage > 20) {
          STATE.fallStunTimer = 0.3;
          STATE.fallStunSpeedMult = 0.5;
        }
      }
    }
    wasGrounded = isGrounded;
  }

  // ── X-axis resolution ─────────────────────────────────────
  if (Math.abs(moveDir.x) > 0.0001) {
    const candidateX = posX + moveDir.x;
    const xAABB = makePlayerAABB(candidateX, footY, posZ);
    const xCandidates = gatherColliders(xAABB);
    let blocked = false;

    // Find lowest stair top among all overlapping stairs (the immediate next step)
    let lowestStairTop = Infinity;
    for (const col of xCandidates) {
      if (col.type === 'stair' && confirmCollision(xAABB, col)) {
        lowestStairTop = Math.min(lowestStairTop, col.aabb.maxY);
      }
    }

    for (const col of xCandidates) {
      if (!confirmCollision(xAABB, col)) continue;

      // Try auto-step — for stairs, use the lowest overlapping step
      const effectiveTop = (col.type === 'stair') ? lowestStairTop : col.aabb.maxY;
      const stepUp = effectiveTop - footY;
      if (stepUp > 0 && stepUp <= STEP_HEIGHT) {
        const stepAABB = makePlayerAABB(candidateX, effectiveTop, posZ);
        const headCheck = gatherColliders(stepAABB);
        let headBlocked = false;
        for (const hc of headCheck) {
          if (confirmCollision(stepAABB, hc)) { headBlocked = true; break; }
        }
        if (!headBlocked) {
          footY = effectiveTop;
          isGrounded = true;
          velocityY = 0;
          continue; // step succeeded, allow move
        }
      }

      // Can't step — blocked
      blocked = true;
      break;
    }

    if (!blocked) posX = candidateX;
  }

  // ── Z-axis resolution ─────────────────────────────────────
  if (Math.abs(moveDir.z) > 0.0001) {
    const candidateZ = posZ + moveDir.z;
    const zAABB = makePlayerAABB(posX, footY, candidateZ);
    const zCandidates = gatherColliders(zAABB);
    let blocked = false;

    // Find lowest stair top among all overlapping stairs
    let lowestStairTopZ = Infinity;
    for (const col of zCandidates) {
      if (col.type === 'stair' && confirmCollision(zAABB, col)) {
        lowestStairTopZ = Math.min(lowestStairTopZ, col.aabb.maxY);
      }
    }

    for (const col of zCandidates) {
      if (!confirmCollision(zAABB, col)) continue;

      // Try auto-step — for stairs, use the lowest overlapping step
      const effectiveTop = (col.type === 'stair') ? lowestStairTopZ : col.aabb.maxY;
      const stepUp = effectiveTop - footY;
      if (stepUp > 0 && stepUp <= STEP_HEIGHT) {
        const stepAABB = makePlayerAABB(posX, effectiveTop, candidateZ);
        const headCheck = gatherColliders(stepAABB);
        let headBlocked = false;
        for (const hc of headCheck) {
          if (confirmCollision(stepAABB, hc)) { headBlocked = true; break; }
        }
        if (!headBlocked) {
          footY = effectiveTop;
          isGrounded = true;
          velocityY = 0;
          continue;
        }
      }

      blocked = true;
      break;
    }

    if (!blocked) posZ = candidateZ;
  }

  // ── Update camera position ────────────────────────────────
  camera.position.x = posX;
  camera.position.z = posZ;
  camera.position.y = footY + eyeHeight;

  // Camera bob
  const moving = moveDir.length() > 0.001;
  if (moving) {
    const bobRate = sprinting ? 1.67 : 1.33;
    cameraBobPhase += moveDir.length() * bobRate;
    const bobAmp = sprinting ? 0.04 : 0.02;
    camera.position.y += Math.sin(cameraBobPhase * 2) * bobAmp;
  }

  camera.rotation.y = yaw;
  camera.rotation.x = pitch;

  // Apply screen shake
  if (shakeIntensity > 0.0001) {
    camera.position.x += (Math.random() - 0.5) * 2 * shakeIntensity;
    camera.position.y += (Math.random() - 0.5) * 2 * shakeIntensity;
    shakeIntensity *= Math.exp(-dt / shakeDecayRate);
    if (shakeIntensity < 0.0001) shakeIntensity = 0;
  }

  playerLight.position.copy(camera.position);

  // ── Interaction prompts ───────────────────────────────────
  {
    let nearLadder = false;
    const lookX = -Math.sin(yaw);
    const lookZ = -Math.cos(yaw);
    for (const lad of ladderDefs) {
      const dx = posX - lad.cx;
      const dz = posZ - lad.cz;
      if (dx * dx + dz * dz > LADDER_INTERACT_RANGE * LADDER_INTERACT_RANGE) continue;
      if (footY < lad.baseY - 0.5 || footY > lad.topY + 0.5) continue;
      const dot = lookX * (-lad.normal.x) + lookZ * (-lad.normal.z);
      if (dot < 0.3) continue;
      nearLadder = true;
      break;
    }
    if (nearLadder) {
      showInteractPrompt('CLIMB [E]');
    } else {
      let nearPallet = false;
      let nearCrate = false;
      for (const p of pallets) {
        const dx = posX - p.mesh.position.x;
        const dz = posZ - p.mesh.position.z;
        if (dx * dx + dz * dz > PALLET_INTERACT_RANGE * PALLET_INTERACT_RANGE) continue;
        if (Math.abs(footY - p.mesh.position.y) > 2.0) continue;
        nearPallet = true;
        break;
      }
      if (!nearPallet) {
        for (const c of weaponCrates) {
          if (c.collected) continue;
          const dx = posX - c.mesh.position.x;
          const dz = posZ - c.mesh.position.z;
          if (dx * dx + dz * dz > PALLET_INTERACT_RANGE * PALLET_INTERACT_RANGE) continue;
          if (Math.abs(footY - c.mesh.position.y) > 2.0) continue;
          nearCrate = true;
          break;
        }
      }
      if (nearPallet) showInteractPrompt('LOADOUT [E]');
      else if (nearCrate) showInteractPrompt('SWAP WEAPON [F]');
      else hideInteractPrompt();
    }
  }

  STATE.distance += moveDir.length();
}
