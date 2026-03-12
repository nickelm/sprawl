// ─── Debris System ───────────────────────────────────────────────────────────
// Object-pooled debris for panel destruction, impact chips, and falling panels.
import * as THREE from 'three';
import { scene, camera } from './renderer.js';
import { getHeight } from './terrain.js';
import { PANEL_TYPES } from './buildings.js';
import { STATE, enemies } from './state.js';
import { takeDamage } from './hud.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const MAX_ACTIVE = 200;
const SETTLE_LIFETIME = 40;  // seconds before settled debris fades
const GRAVITY = -9.8;

// ─── Template geometry (extruded triangle prism, 8 triangles) ────────────────

function createDebrisGeometry() {
  // Triangular prism: 3 random-ish points on a face, extruded by depth
  // Base triangle in XY plane, extruded along Z
  const verts = [];
  // Front triangle
  const ax = -0.5, ay = -0.5;
  const bx = 0.5, by = -0.3;
  const cx = 0.1, cy = 0.5;
  const d = 0.5; // extrude depth

  // Front face (2 tris)
  verts.push(ax, ay, 0, bx, by, 0, cx, cy, 0);
  // Back face (2 tris, reversed winding)
  verts.push(cx, cy, d, bx, by, d, ax, ay, d);
  // Side 1: a-b (2 tris)
  verts.push(ax, ay, 0, bx, by, 0, bx, by, d, ax, ay, 0, bx, by, d, ax, ay, d);
  // Side 2: b-c (2 tris)
  verts.push(bx, by, 0, cx, cy, 0, cx, cy, d, bx, by, 0, cx, cy, d, bx, by, d);
  // Side 3: c-a (2 tris)
  verts.push(cx, cy, 0, ax, ay, 0, ax, ay, d, cx, cy, 0, ax, ay, d, cx, cy, d);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.computeVertexNormals();
  return geo;
}

const _debrisGeo = createDebrisGeometry();

// ─── Debris pool ─────────────────────────────────────────────────────────────

const _pool = [];       // inactive pool entries
const _active = [];     // active debris entries
const _tmpV = new THREE.Vector3();

function createEntry() {
  const mat = new THREE.MeshPhongMaterial({ flatShading: true, color: 0x888888 });
  const mesh = new THREE.Mesh(_debrisGeo, mat);
  mesh.castShadow = true;
  mesh.visible = false;
  scene.add(mesh);
  return {
    mesh,
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    settled: false,
    age: 0,
    lifetime: SETTLE_LIFETIME,
  };
}

function acquire() {
  let entry;
  if (_pool.length > 0) {
    entry = _pool.pop();
  } else if (_active.length >= MAX_ACTIVE) {
    // Recycle oldest settled, or oldest active
    let oldest = -1, oldestAge = -1;
    for (let i = 0; i < _active.length; i++) {
      if (_active[i].settled && _active[i].age > oldestAge) {
        oldest = i; oldestAge = _active[i].age;
      }
    }
    if (oldest < 0) {
      // No settled — recycle oldest overall
      for (let i = 0; i < _active.length; i++) {
        if (_active[i].age > oldestAge) { oldest = i; oldestAge = _active[i].age; }
      }
    }
    if (oldest < 0) return null;
    entry = _active.splice(oldest, 1)[0];
  } else {
    entry = createEntry();
  }
  entry.mesh.visible = true;
  entry.settled = false;
  entry.age = 0;
  entry.lifetime = SETTLE_LIFETIME;
  _active.push(entry);
  return entry;
}

function release(entry) {
  entry.mesh.visible = false;
  const idx = _active.indexOf(entry);
  if (idx >= 0) _active.splice(idx, 1);
  _pool.push(entry);
}

// ─── Spawning functions ─────────────────────────────────────────────────────

/**
 * Spawn impact debris (tiny chips) at a hit point.
 * @param {THREE.Vector3} point - world-space hit point
 * @param {THREE.Vector3} normal - surface normal at hit
 * @param {string} panelType - material name for color
 */
export function spawnImpactDebris(point, normal, panelType) {
  const count = 1 + Math.floor(Math.random() * 3); // 1-3 chips
  const def = PANEL_TYPES[panelType] ?? PANEL_TYPES.concrete;

  for (let i = 0; i < count; i++) {
    const entry = acquire();
    if (!entry) break;

    const scale = 0.02 + Math.random() * 0.04; // tiny chips
    entry.mesh.scale.set(scale, scale, scale);
    entry.mesh.position.copy(point);

    // Color with slight variation
    const variation = 0.9 + Math.random() * 0.2;
    const r = ((def.color >> 16) & 0xff) / 255 * variation;
    const g = ((def.color >> 8) & 0xff) / 255 * variation;
    const b = (def.color & 0xff) / 255 * variation;
    entry.mesh.material.color.setRGB(r, g, b);

    // Velocity: outward from surface + random spread
    entry.velocity.copy(normal).multiplyScalar(1 + Math.random() * 2);
    entry.velocity.x += (Math.random() - 0.5) * 2;
    entry.velocity.y += Math.random() * 2;
    entry.velocity.z += (Math.random() - 0.5) * 2;

    entry.angularVelocity.set(
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 10
    );

    entry.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    entry.lifetime = 2 + Math.random() * 2; // short-lived chips
  }
}

/**
 * Spawn break debris when a panel is destroyed.
 * @param {object} panelData - panel data from destruction registry
 * @param {THREE.Vector3} wallNormal - wall face normal
 * @param {THREE.Vector3} panelCenter - world center of destroyed panel
 */
export function spawnBreakDebris(panelData, wallNormal, panelCenter) {
  const def = PANEL_TYPES[panelData.type] ?? PANEL_TYPES.concrete;
  const [minCount, maxCount] = def.debrisCount || [4, 8];
  const count = minCount + Math.floor(Math.random() * (maxCount - minCount + 1));

  for (let i = 0; i < count; i++) {
    const entry = acquire();
    if (!entry) break;

    const isGlass = panelData.type === 'glass';
    const scale = isGlass
      ? 0.03 + Math.random() * 0.05    // small glass shards
      : 0.15 + Math.random() * 0.25;   // larger structural chunks
    entry.mesh.scale.set(scale, scale, scale * (0.3 + Math.random() * 0.7));
    entry.mesh.position.copy(panelCenter);
    entry.mesh.position.x += (Math.random() - 0.5) * 0.8;
    entry.mesh.position.y += (Math.random() - 0.5) * 0.8;
    entry.mesh.position.z += (Math.random() - 0.5) * 0.1;

    const variation = 0.8 + Math.random() * 0.4;
    const r = ((def.color >> 16) & 0xff) / 255 * variation;
    const g = ((def.color >> 8) & 0xff) / 255 * variation;
    const b = (def.color & 0xff) / 255 * variation;
    entry.mesh.material.color.setRGB(r, g, b);

    // Velocity: outward from wall + gravity will pull down
    entry.velocity.copy(wallNormal).multiplyScalar(1 + Math.random() * 3);
    entry.velocity.x += (Math.random() - 0.5) * 2;
    entry.velocity.y += Math.random() * 3;
    entry.velocity.z += (Math.random() - 0.5) * 2;

    entry.angularVelocity.set(
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 8
    );

    entry.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  }
}

/**
 * Spawn falling panel debris (larger pieces from structural collapse).
 * @param {object} panelData - panel data
 * @param {THREE.Vector3} panelCenter - world center of panel
 */
export function spawnFallingDebris(panelData, panelCenter) {
  const def = PANEL_TYPES[panelData.type] ?? PANEL_TYPES.concrete;
  const count = 2 + Math.floor(Math.random() * 3); // 2-4 large pieces

  for (let i = 0; i < count; i++) {
    const entry = acquire();
    if (!entry) break;

    const scale = 0.1 + Math.random() * 0.15; // larger than break debris
    entry.mesh.scale.set(scale, scale, scale);
    entry.mesh.position.copy(panelCenter);
    entry.mesh.position.x += (Math.random() - 0.5) * 0.6;
    entry.mesh.position.z += (Math.random() - 0.5) * 0.6;

    const variation = 0.8 + Math.random() * 0.4;
    const r = ((def.color >> 16) & 0xff) / 255 * variation;
    const g = ((def.color >> 8) & 0xff) / 255 * variation;
    const b = (def.color & 0xff) / 255 * variation;
    entry.mesh.material.color.setRGB(r, g, b);

    // Slight outward drift + downward
    entry.velocity.set(
      (Math.random() - 0.5) * 1.5,
      -0.5 - Math.random(),
      (Math.random() - 0.5) * 1.5
    );

    entry.angularVelocity.set(
      (Math.random() - 0.5) * 5,
      (Math.random() - 0.5) * 5,
      (Math.random() - 0.5) * 5
    );

    entry.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);

    // Tag with panel mass for impact damage
    entry._panelMass = def.mass || 1.0;
    entry._isFallingPanel = true;
  }
}

/**
 * Spawn a brass casing from the weapon's ejection port.
 * @param {THREE.Vector3} worldPos - world-space ejection port position
 * @param {THREE.Vector3} camRight - camera right vector (world space)
 * @param {THREE.Vector3} camUp - camera up vector (world space)
 * @param {number} color - hex color (brass gold or red for shotgun)
 */
export function spawnCasing(worldPos, camRight, camUp, color) {
  const entry = acquire();
  if (!entry) return;

  entry.mesh.scale.set(0.01, 0.005, 0.005);
  entry.mesh.position.copy(worldPos);
  entry.mesh.material.color.setHex(color);
  entry.mesh.material.opacity = 1;
  entry.mesh.material.transparent = false;

  // Velocity: right + up + random jitter
  entry.velocity.set(0, 0, 0);
  entry.velocity.addScaledVector(camRight, 2.0 + Math.random() * 1.5);
  entry.velocity.addScaledVector(camUp, 1.5 + Math.random() * 1.0);
  entry.velocity.x += (Math.random() - 0.5) * 0.5;
  entry.velocity.z += (Math.random() - 0.5) * 0.5;

  entry.angularVelocity.set(
    (Math.random() - 0.5) * 20,
    (Math.random() - 0.5) * 20,
    (Math.random() - 0.5) * 20
  );

  entry.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  entry.lifetime = 1.5;  // short-lived casings
}

// ─── Per-frame update ────────────────────────────────────────────────────────

export function updateDebris(dt) {
  for (let i = _active.length - 1; i >= 0; i--) {
    const e = _active[i];
    e.age += dt;

    if (e.settled) {
      // Fade and expire settled debris
      if (e.age > e.lifetime) {
        release(e);
        continue;
      }
      // Fade opacity in last 2 seconds
      const fadeStart = e.lifetime - 2;
      if (e.age > fadeStart) {
        const alpha = 1 - (e.age - fadeStart) / 2;
        e.mesh.material.opacity = alpha;
        e.mesh.material.transparent = true;
      }
      continue;
    }

    // Apply gravity
    e.velocity.y += GRAVITY * dt;

    // Integrate position
    e.mesh.position.x += e.velocity.x * dt;
    e.mesh.position.y += e.velocity.y * dt;
    e.mesh.position.z += e.velocity.z * dt;

    // Integrate rotation
    e.mesh.rotation.x += e.angularVelocity.x * dt;
    e.mesh.rotation.y += e.angularVelocity.y * dt;
    e.mesh.rotation.z += e.angularVelocity.z * dt;

    // Terrain collision
    const groundY = getHeight(e.mesh.position.x, e.mesh.position.z);
    if (e.mesh.position.y <= groundY + 0.02) {
      e.mesh.position.y = groundY + 0.02;
      e.settled = true;
      e.age = 0; // Reset age for settle timer
      e.mesh.material.opacity = 1;
      e.mesh.material.transparent = false;

      // Falling panel impact damage
      if (e._isFallingPanel) {
        const fallSpeed = Math.abs(e.velocity.y);
        const impactDmg = (e._panelMass || 1) * fallSpeed * 0.5;
        checkFallingDamage(e.mesh.position, impactDmg);
        e._isFallingPanel = false;
      }

      e.velocity.set(0, 0, 0);
      e.angularVelocity.set(0, 0, 0);
    }
  }
}

// ─── Falling panel damage check ──────────────────────────────────────────────

const IMPACT_RADIUS = 1.0;

function checkFallingDamage(pos, damage) {
  if (damage < 5) return;

  // Check player
  if (!STATE.dead && !STATE.dying) {
    const dx = pos.x - camera.position.x;
    const dz = pos.z - camera.position.z;
    if (dx * dx + dz * dz < IMPACT_RADIUS * IMPACT_RADIUS) {
      takeDamage(damage); // no source direction for falling debris
    }
  }

  // Check enemies
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    _tmpV.copy(enemy.mesh.position).sub(pos);
    _tmpV.y = 0;
    if (_tmpV.lengthSq() < IMPACT_RADIUS * IMPACT_RADIUS) {
      enemy.health -= damage;
      if (enemy.health <= 0) {
        enemy.alive = false;
        enemy.dying = true;
        enemy.deathTimer = 0;
      }
    }
  }
}
