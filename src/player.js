import * as THREE from 'three';
import {
  STATE, PLAYER_HEIGHT, MOVE_SPEED, SPRINT_MULT, MOUSE_SENS,
  GRAVITY, PLAYER_HALF_W, JUMP_IMPULSE, STEP_HEIGHT,
  CROUCH_HEIGHT, CROUCH_EYE, CROUCH_SPEED_MULT, PLAYER_EYE_HEIGHT,
} from './state.js';
import { camera, playerLight } from './renderer.js';
import { shootBullet, reload } from './weapons.js';
import { getHeight } from './terrain.js';
import { switchWeapon } from './weaponView.js';
import { WEAPON_ORDER } from './weaponDefs.js';
import { gatherColliders, confirmCollision } from './collision.js';

// ─── INPUT STATE ───────────────────────────────────────────
export const keys = {};
let pitch = 0;
let yaw = 0;
let skipMouseFrames = 0;

// ─── PLAYER PHYSICS STATE ──────────────────────────────────
let footY = 0;            // foot position (world Y)
let velocityY = 0;
let isGrounded = true;
let isCrouching = false;
let playerHeight = PLAYER_HEIGHT;
let eyeHeight = PLAYER_EYE_HEIGHT;

// ─── CAMERA BOB ──────────────────────────────────────────
let cameraBobPhase = 0;

// ─── SCREEN SHAKE ─────────────────────────────────────────
let shakeIntensity = 0;
let shakeDecayRate = 0.1;

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
    keys[e.code] = true;
    if (e.code === 'KeyR') reload();
    if (e.code === 'Digit1' && WEAPON_ORDER[0]) switchWeapon(WEAPON_ORDER[0]);
    if (e.code === 'Digit2' && WEAPON_ORDER[1]) switchWeapon(WEAPON_ORDER[1]);
  });
  document.addEventListener('keyup', e => { keys[e.code] = false; });

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) skipMouseFrames = 2;
  });

  document.addEventListener('mousemove', e => {
    if (!STATE.started || STATE.dead) return;
    if (document.pointerLockElement !== canvas) return;
    if (skipMouseFrames > 0) { skipMouseFrames--; return; }
    yaw -= e.movementX * MOUSE_SENS;
    pitch -= e.movementY * MOUSE_SENS;
    pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, pitch));
  });

  document.addEventListener('mousedown', e => {
    if (e.button === 0 && STATE.started && !STATE.dead) shootBullet();
    if (e.button === 2 && STATE.started && !STATE.dead) STATE.ads = true;
  });

  document.addEventListener('mouseup', e => {
    if (e.button === 2) STATE.ads = false;
  });

  document.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('click', () => {
    if (STATE.started && !STATE.dead && document.pointerLockElement !== canvas) {
      canvas.requestPointerLock();
    }
  });
}

// ─── RESET ─────────────────────────────────────────────────
export function resetPlayer() {
  footY = 0;
  velocityY = 0;
  isGrounded = true;
  isCrouching = false;
  playerHeight = PLAYER_HEIGHT;
  eyeHeight = PLAYER_EYE_HEIGHT;
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

// ─── PLAYER UPDATE ─────────────────────────────────────────
export function updatePlayer(dt) {
  if (STATE.dead) return;

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

  // ── Movement input ────────────────────────────────────────
  const adsMult = STATE.ads ? 0.6 : 1.0;
  const crouchMult = isCrouching ? CROUCH_SPEED_MULT : 1.0;
  const speed = MOVE_SPEED * ((keys['ShiftLeft'] || keys['ShiftRight']) ? SPRINT_MULT : 1) * adsMult * crouchMult;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

  const moveDir = new THREE.Vector3();
  if (keys['KeyW']) moveDir.add(forward);
  if (keys['KeyS']) moveDir.sub(forward);
  if (keys['KeyA']) moveDir.sub(right);
  if (keys['KeyD']) moveDir.add(right);

  if (moveDir.length() > 0) moveDir.normalize().multiplyScalar(speed * dt);

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
  }

  // ── X-axis resolution ─────────────────────────────────────
  if (Math.abs(moveDir.x) > 0.0001) {
    const candidateX = posX + moveDir.x;
    const xAABB = makePlayerAABB(candidateX, footY, posZ);
    const xCandidates = gatherColliders(xAABB);
    let blocked = false;

    for (const col of xCandidates) {
      if (!confirmCollision(xAABB, col)) continue;

      // Try auto-step
      const stepUp = col.aabb.maxY - footY;
      if (stepUp > 0 && stepUp <= STEP_HEIGHT) {
        // Check head clearance at stepped-up position
        const stepAABB = makePlayerAABB(candidateX, col.aabb.maxY, posZ);
        const headCheck = gatherColliders(stepAABB);
        let headBlocked = false;
        for (const hc of headCheck) {
          if (confirmCollision(stepAABB, hc)) { headBlocked = true; break; }
        }
        if (!headBlocked) {
          footY = col.aabb.maxY;
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

    for (const col of zCandidates) {
      if (!confirmCollision(zAABB, col)) continue;

      // Try auto-step
      const stepUp = col.aabb.maxY - footY;
      if (stepUp > 0 && stepUp <= STEP_HEIGHT) {
        const stepAABB = makePlayerAABB(posX, col.aabb.maxY, candidateZ);
        const headCheck = gatherColliders(stepAABB);
        let headBlocked = false;
        for (const hc of headCheck) {
          if (confirmCollision(stepAABB, hc)) { headBlocked = true; break; }
        }
        if (!headBlocked) {
          footY = col.aabb.maxY;
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
  const sprinting = moving && (keys['ShiftLeft'] || keys['ShiftRight']);
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

  STATE.distance += moveDir.length();
}
