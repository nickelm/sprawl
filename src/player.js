import * as THREE from 'three';
import { STATE, PLAYER_HEIGHT, PLAYER_RADIUS, MOVE_SPEED, SPRINT_MULT, MOUSE_SENS } from './state.js';
import { camera, playerLight } from './renderer.js';
import { getAllColliders } from './world.js';
import { shootBullet, reload } from './weapons.js';
import { getHeight } from './terrain.js';
import { switchWeapon } from './weaponView.js';
import { WEAPON_ORDER } from './weaponDefs.js';

// ─── INPUT STATE ───────────────────────────────────────────
export const keys = {};
let pitch = 0;
let yaw = 0;
let skipMouseFrames = 0;

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
  camera.position.set(0, PLAYER_HEIGHT, 0);
  camera.rotation.order = 'YXZ';
  yaw = 0;
  pitch = 0;
  cameraBobPhase = 0;
  shakeIntensity = 0;
}

// ─── COLLISION ─────────────────────────────────────────────
function collidesWithBuilding(x, z, colliders) {
  for (const c of colliders) {
    if (x + PLAYER_RADIUS > c.minX && x - PLAYER_RADIUS < c.maxX &&
        z + PLAYER_RADIUS > c.minZ && z - PLAYER_RADIUS < c.maxZ) {
      return true;
    }
  }
  return false;
}

// ─── PLAYER UPDATE ─────────────────────────────────────────
export function updatePlayer(dt) {
  if (STATE.dead) return;

  const adsMult = STATE.ads ? 0.6 : 1.0;
  const speed = MOVE_SPEED * ((keys['ShiftLeft'] || keys['ShiftRight']) ? SPRINT_MULT : 1) * adsMult;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

  const moveDir = new THREE.Vector3();
  if (keys['KeyW']) moveDir.add(forward);
  if (keys['KeyS']) moveDir.sub(forward);
  if (keys['KeyA']) moveDir.sub(right);
  if (keys['KeyD']) moveDir.add(right);

  if (moveDir.length() > 0) moveDir.normalize().multiplyScalar(speed * dt);

  const colliders = getAllColliders();

  const newX = camera.position.x + moveDir.x;
  if (!collidesWithBuilding(newX, camera.position.z, colliders)) camera.position.x = newX;

  const newZ = camera.position.z + moveDir.z;
  if (!collidesWithBuilding(camera.position.x, newZ, colliders)) camera.position.z = newZ;

  camera.position.y = getHeight(camera.position.x, camera.position.z) + PLAYER_HEIGHT;

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
