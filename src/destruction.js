// Destruction system — panel registry, damage, structural integrity, collapse
import * as THREE from 'three';
import { collisionWorld } from './collision.js';
import { PANEL_TYPES } from './buildings.js';
import { spawnBreakDebris, spawnFallingDebris } from './debris.js';

// Face bitmask constants (must match buildings.js)
const FACE_PX = 1, FACE_NX = 2, FACE_PY = 4, FACE_NY = 8, FACE_PZ = 16, FACE_NZ = 32;

export const panels        = new Map(); // panelId → panelData
export const props         = new Map(); // propId  → propData
// Grid-position reverse lookup: `${wallId},${gridX},${gridY}` → panelId.
export const panelByGridPos = new Map();
// Wall-level grouping: wallId → Set<panelId>. Used for slab re-splitting.
export const panelsByWall   = new Map();

// Wall mesh registry: `${buildingId},${wallKey}` → THREE.Mesh
// Used by ballistics to find raycast targets and by damage viz to access buffers.
export const wallMeshes = new Map();

// Building mesh groups: buildingId → THREE.Group (for raycasting target collection)
export const buildingGroups = new Map();

let _nextId = 0;
let _slabGroupId = 0;

export function nextSlabGroupId() { return _slabGroupId++; }

export function registerPanel(data) {
  const id = data.id ?? _nextId++;
  panels.set(id, data);
  if (data.wallId !== undefined && data.gridX !== undefined && data.gridY !== undefined) {
    panelByGridPos.set(`${data.wallId},${data.gridX},${data.gridY}`, id);
  }
  if (data.wallId !== undefined) {
    const key = `${data.buildingId},${data.wallId}`;
    if (!panelsByWall.has(key)) panelsByWall.set(key, new Set());
    panelsByWall.get(key).add(id);
  }
  return id;
}

export function registerProp(data) {
  const id = data.id ?? _nextId++;
  props.set(id, data);
  return id;
}

export function registerWallMesh(buildingId, wallKey, mesh) {
  wallMeshes.set(`${buildingId},${wallKey}`, mesh);
}

export function registerBuildingGroup(buildingId, group) {
  buildingGroups.set(buildingId, group);
}

// ─── Wall mesh collection for raycasting ─────────────────────────────────────

/** Get all wall meshes for a set of building IDs. */
export function getWallMeshesForBuildings(buildingIds) {
  const meshes = [];
  for (const [key, mesh] of wallMeshes) {
    const bid = parseInt(key.split(',')[0], 10);
    if (buildingIds.has(bid)) meshes.push(mesh);
  }
  return meshes;
}

// ─── Damage system ───────────────────────────────────────────────────────────

export function damagePanel(id, amount) {
  const p = panels.get(id);
  if (!p || p.hp <= 0) return 0;
  p.hp = Math.max(0, p.hp - amount);

  if (p.hp > 0) {
    // Damage visualization — darken colors and perturb vertices
    updatePanelVisuals(p);
  } else {
    // Panel destroyed — zero vertices, update collision
    destroyPanel(p);
  }
  return p.hp;
}

/** Convert hex color to RGB floats [0..1]. */
function matToRgb(matName) {
  const def = PANEL_TYPES[matName] ?? PANEL_TYPES.concrete;
  return {
    r: ((def.color >> 16) & 0xff) / 255,
    g: ((def.color >> 8) & 0xff) / 255,
    b: (def.color & 0xff) / 255,
  };
}

function setFaceColor(colorAttr, start, count, rgb, darken) {
  for (let i = start; i < start + count; i++) {
    colorAttr.setXYZ(i, rgb.r * darken, rgb.g * darken, rgb.b * darken);
  }
}

/** Update vertex colors to reflect damage level.
 *  slabFaceVerts order: +Y(6), -Y(6), +Z(6), -Z(6), +X(6), -X(6).
 *  H-walls: front=+Z(12), back=-Z(18). V-walls: front=+X(24), back=-X(30). */
function updatePanelVisuals(p) {
  const mesh = p.meshRef;
  if (!mesh) return;
  const colors = mesh.geometry.attributes.color;
  if (!colors) return;

  const ratio = p.hp / p.maxHp;
  let darken = 1.0;
  if (ratio <= 0.25)      darken = 0.5;
  else if (ratio <= 0.50) darken = 0.7;
  else if (ratio <= 0.75) darken = 0.85;

  const edge  = matToRgb(p.type);
  const front = matToRgb(p.frontMat || p.type);
  const back  = matToRgb(p.backMat || p.type);
  const s = p.vertexStart;
  // Face layout from slabFaceVerts: +Y, -Y, +Z, -Z, +X, -X
  if (p.isVWall) {
    // V-walls: front = +X (offset 24), back = -X (offset 30)
    setFaceColor(colors, s,      6, edge,  darken); // +Y
    setFaceColor(colors, s + 6,  6, edge,  darken); // -Y
    setFaceColor(colors, s + 12, 6, edge,  darken); // +Z (end edge)
    setFaceColor(colors, s + 18, 6, edge,  darken); // -Z (end edge)
    setFaceColor(colors, s + 24, 6, front, darken); // +X (front)
    setFaceColor(colors, s + 30, 6, back,  darken); // -X (back)
  } else {
    // H-walls: front = +Z (offset 12), back = -Z (offset 18)
    setFaceColor(colors, s,      6, edge,  darken); // +Y
    setFaceColor(colors, s + 6,  6, edge,  darken); // -Y
    setFaceColor(colors, s + 12, 6, front, darken); // +Z (front)
    setFaceColor(colors, s + 18, 6, back,  darken); // -Z (back)
    setFaceColor(colors, s + 24, 6, edge,  darken); // +X
    setFaceColor(colors, s + 30, 6, edge,  darken); // -X
  }
  colors.needsUpdate = true;
}

const _panelCenter = new THREE.Vector3();
const _wallNormal = new THREE.Vector3();

/** Compute world-space center of a panel from its vertex buffer. */
function computePanelCenter(p) {
  const mesh = p.meshRef;
  if (!mesh) return _panelCenter.set(0, 0, 0);
  const pos = mesh.geometry.attributes.position;
  let cx = 0, cy = 0, cz = 0;
  const start = p.vertexStart;
  const end = start + p.vertexCount;
  for (let i = start; i < end; i++) {
    cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i);
  }
  const n = end - start;
  _panelCenter.set(cx / n, cy / n, cz / n);
  return _panelCenter;
}

/** Estimate wall normal from panel orientation.
 *  wallId encoding: H-walls = z*10000+x → normal is ±Z; V-walls = x*10000+z → normal is ±X. */
function estimateWallNormal(p) {
  // Heuristic: H-walls (z*10000+x) have larger wallId quotients for same position
  // gridX == wallId % 10000 → matches for H-walls where wallId = z*10000 + x
  // For V-walls: wallId = x*10000 + z, and gridX = x (the wall coordinate)
  // We can't perfectly distinguish, but we can use the mesh face normals
  // For simplicity: check the 3rd face (front face) normal direction
  const mesh = p.meshRef;
  if (!mesh) return _wallNormal.set(0, 0, 1);
  const pos = mesh.geometry.attributes.position;
  // Front face starts at vertexStart + 12 (after +Y and -Y faces, 6 verts each)
  const fi = p.vertexStart + 12;
  if (fi + 2 >= pos.count) return _wallNormal.set(0, 0, 1);
  const ax = pos.getX(fi), ay = pos.getY(fi), az = pos.getZ(fi);
  const bx = pos.getX(fi + 1), by = pos.getY(fi + 1), bz = pos.getZ(fi + 1);
  const cx = pos.getX(fi + 2), cy = pos.getY(fi + 2), cz = pos.getZ(fi + 2);
  // Cross product (b-a) × (c-a)
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  _wallNormal.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
  return _wallNormal;
}

/** Visual destruction only: zero vertices, spawn debris, update collision.
 *  Does NOT trigger glass cascade or structural integrity checks. */
function destroyPanelVisual(p) {
  // Compute center and normal before zeroing vertices
  const center = computePanelCenter(p).clone();
  const normal = estimateWallNormal(p).clone();

  // Zero vertices in the mesh buffer
  const mesh = p.meshRef;
  if (mesh) {
    const geo = mesh.geometry;
    const positions = geo.attributes.position;
    const colors = geo.attributes.color;
    const start = p.vertexStart;
    const end = start + p.vertexCount;
    for (let i = start; i < end; i++) {
      positions.setXYZ(i, 0, 0, 0);
      if (colors) colors.setXYZ(i, 0, 0, 0);
    }
    positions.needsUpdate = true;
    if (colors) colors.needsUpdate = true;
  }

  // Spawn break debris
  spawnBreakDebris(p, normal, center);

  // Update collision bitmask
  if (p.wallId !== undefined) {
    collisionWorld.destroyPanel(p.buildingId, p.wallId, p.gridX, p.gridY);
  }

  // Restore endcap faces on neighbors that were suppressed at build time
  restoreNeighborEndcaps(p);
}

/** Map face bitmask → vertex offset within the 36-vertex panel stride. */
const FACE_VERT_OFFSET = {
  [FACE_PY]: 0, [FACE_NY]: 6, [FACE_PZ]: 12, [FACE_NZ]: 18, [FACE_PX]: 24, [FACE_NX]: 30,
};

/** Generate 6 vertex positions for a single box face. */
function faceVerts(x0, y0, z0, x1, y1, z1, face) {
  switch (face) {
    case FACE_PY: return [x0,y1,z0, x0,y1,z1, x1,y1,z1,  x0,y1,z0, x1,y1,z1, x1,y1,z0];
    case FACE_NY: return [x0,y0,z1, x0,y0,z0, x1,y0,z0,  x0,y0,z1, x1,y0,z0, x1,y0,z1];
    case FACE_PZ: return [x0,y0,z1, x1,y0,z1, x1,y1,z1,  x0,y0,z1, x1,y1,z1, x0,y1,z1];
    case FACE_NZ: return [x1,y0,z0, x0,y0,z0, x0,y1,z0,  x1,y0,z0, x0,y1,z0, x1,y1,z0];
    case FACE_PX: return [x1,y0,z0, x1,y1,z0, x1,y1,z1,  x1,y0,z0, x1,y1,z1, x1,y0,z1];
    case FACE_NX: return [x0,y0,z1, x0,y1,z1, x0,y1,z0,  x0,y0,z1, x0,y1,z0, x0,y0,z0];
  }
}

/** When a panel is destroyed, restore suppressed endcap faces on its horizontal neighbors. */
function restoreNeighborEndcaps(destroyed) {
  // For H-walls: neighbors at dx=±1 may have suppressed ∓X endcaps
  // For V-walls: neighbors at dx=±1 may have suppressed ∓Z endcaps
  for (const dx of [-1, 1]) {
    const nid = getNeighborPanelId(destroyed, dx, 0);
    if (nid === undefined) continue;
    const np = panels.get(nid);
    if (!np || np.hp <= 0 || !np.suppressedFaces || !np.bounds || !np.meshRef) continue;

    // Determine which endcap face to restore
    let faceToRestore;
    if (!np.isVWall) {
      // H-wall: dx=-1 destroyed → neighbor's +X faces the gap; dx=+1 → neighbor's -X
      faceToRestore = dx === -1 ? FACE_PX : FACE_NX;
    } else {
      // V-wall: dx=-1 destroyed → neighbor's +Z faces the gap; dx=+1 → neighbor's -Z
      faceToRestore = dx === -1 ? FACE_PZ : FACE_NZ;
    }

    if (!(np.suppressedFaces & faceToRestore)) continue; // wasn't suppressed

    // Write face vertices into the mesh buffer
    const [x0, y0, z0, x1, y1, z1] = np.bounds;
    const verts = faceVerts(x0, y0, z0, x1, y1, z1, faceToRestore);
    const mesh = np.meshRef;
    const positions = mesh.geometry.attributes.position;
    const colors = mesh.geometry.attributes.color;
    const vOffset = np.vertexStart + FACE_VERT_OFFSET[faceToRestore];

    for (let i = 0; i < 6; i++) {
      positions.setXYZ(vOffset + i, verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
    }

    // Set endcap face color to match the panel's material color
    if (colors) {
      const def = PANEL_TYPES[np.type];
      const hex = def ? def.color : 0x6b6b6b;
      const r = ((hex >> 16) & 0xff) / 255;
      const g = ((hex >> 8) & 0xff) / 255;
      const b = (hex & 0xff) / 255;
      for (let i = 0; i < 6; i++) {
        colors.setXYZ(vOffset + i, r, g, b);
      }
      colors.needsUpdate = true;
    }

    positions.needsUpdate = true;

    // Compute normal for the restored face (flat shading: all 6 verts get same normal)
    const normals = mesh.geometry.attributes.normal;
    if (normals) {
      const ax = verts[0], ay = verts[1], az = verts[2];
      const bx = verts[3], by = verts[4], bz = verts[5];
      const cx = verts[6], cy = verts[7], cz = verts[8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vvx = cx - ax, vvy = cy - ay, vvz = cz - az;
      let nx = uy * vvz - uz * vvy, ny = uz * vvx - ux * vvz, nz = ux * vvy - uy * vvx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (let i = 0; i < 6; i++) normals.setXYZ(vOffset + i, nx, ny, nz);
      normals.needsUpdate = true;
    }

    // Mark as no longer suppressed
    np.suppressedFaces &= ~faceToRestore;
  }
}

/** Destroy a panel and trigger cascading effects (glass shatter or structural check). */
function destroyPanel(p) {
  destroyPanelVisual(p);

  if (p.type === 'glass') {
    // Glass cascade: adjacent glass panels shatter
    cascadeGlass(p);
  } else {
    // Check structural integrity for neighbors
    checkStructuralIntegrity(p);
  }
}

/** When a glass panel breaks, all connected glass panels shatter too. */
function cascadeGlass(startPanel) {
  const queue = [startPanel];
  const processed = new Set([startPanel.id]);
  let cascaded = 0;
  while (queue.length > 0) {
    const p = queue.shift();
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nid = getNeighborPanelId(p, dx, dy);
      if (nid === undefined || processed.has(nid)) continue;
      const np = panels.get(nid);
      if (!np || np.hp <= 0 || np.type !== 'glass') continue;
      processed.add(nid);
      np.hp = 0;
      destroyPanelVisual(np);
      queue.push(np);
      cascaded++;
    }
  }
  if (cascaded > 0) console.log(`[glass cascade] shattered ${cascaded} adjacent glass panels`);
}

// ─── Structural integrity — support graph BFS ────────────────────────────────

/** Collapse queue for staggered falling panel cascade. */
const collapseQueue = [];

function isHWall(p) {
  return !p.isVWall;
}

function getNeighborPanelId(p, dx, dy) {
  // wallId for H-walls: z*10000 + x → gridX = x (position along wall)
  // wallId for V-walls: x*10000 + z → gridX = x (wall coordinate, NOT position along wall)
  const row = p.gridY % 10;
  const floor = (p.gridY / 10) | 0;
  const neighborWallId = p.wallId + dx;

  // Floor transition: going down from row 0 → find top row of floor below
  if (dy === -1 && row === 0) {
    if (floor <= 0) return undefined;
    for (let r = 9; r >= 0; r--) {
      const tryGridY = (floor - 1) * 10 + r;
      const key = isHWall(p)
        ? `${neighborWallId},${p.gridX + dx},${tryGridY}`
        : `${neighborWallId},${p.gridX},${tryGridY}`;
      const id = panelByGridPos.get(key);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  // Normal lookup
  const neighborGridY = p.gridY + dy;
  const key = isHWall(p)
    ? `${neighborWallId},${p.gridX + dx},${neighborGridY}`
    : `${neighborWallId},${p.gridX},${neighborGridY}`;
  const id = panelByGridPos.get(key);
  if (id !== undefined) return id;

  // Floor transition: going up — if not found, try next floor's row 0
  if (dy === 1) {
    const nextGridY = (floor + 1) * 10;
    const nextKey = isHWall(p)
      ? `${neighborWallId},${p.gridX + dx},${nextGridY}`
      : `${neighborWallId},${p.gridX},${nextGridY}`;
    return panelByGridPos.get(nextKey);
  }

  return undefined;
}

/** Check if a panel can reach a rooted (ground-floor) panel via BFS. */
function canReachRoot(startId) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const cid = queue.shift();
    if (visited.has(cid)) continue;
    visited.add(cid);
    const cp = panels.get(cid);
    if (!cp || cp.hp <= 0) continue;

    // Rooted: floor 0, bottom row
    const floor = (cp.gridY / 10) | 0;
    const row = cp.gridY % 10;
    if (floor === 0 && row === 0) return true;

    // Check neighbors: left, right, below
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1]]) {
      const nid = getNeighborPanelId(cp, dx, dy);
      if (nid !== undefined && !visited.has(nid)) {
        const np = panels.get(nid);
        if (np && np.hp > 0) queue.push(nid);
      }
    }
  }
  return false;
}

/** After a panel is destroyed, check if its neighbors are still supported. */
function checkStructuralIntegrity(p) {
  const unsupported = [];

  // Check all neighbors of the destroyed panel
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const nid = getNeighborPanelId(p, dx, dy);
    if (nid === undefined) continue;
    const np = panels.get(nid);
    if (!np || np.hp <= 0) continue;

    if (!canReachRoot(nid)) {
      unsupported.push(nid);
    }
  }

  if (unsupported.length === 0) return;

  // BFS outward to find all connected unsupported panels
  const allUnsupported = new Set(unsupported);
  const expandQueue = [...unsupported];
  while (expandQueue.length > 0) {
    const cid = expandQueue.shift();
    const cp = panels.get(cid);
    if (!cp) continue;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nid = getNeighborPanelId(cp, dx, dy);
      if (nid === undefined || allUnsupported.has(nid)) continue;
      const np = panels.get(nid);
      if (!np || np.hp <= 0) continue;
      if (!canReachRoot(nid)) {
        allUnsupported.add(nid);
        expandQueue.push(nid);
      }
    }
  }

  // Queue for collapse cascade — sort by gridY descending (top rows fall first)
  const sorted = [...allUnsupported].map(id => ({ id, panel: panels.get(id) }))
    .filter(e => e.panel)
    .sort((a, b) => b.panel.gridY - a.panel.gridY);

  for (let i = 0; i < sorted.length; i++) {
    collapseQueue.push({
      panelId: sorted[i].id,
      delay: i * 0.075, // 75ms stagger between rows
    });
  }
}

// ─── Collapse queue update (called from game loop) ───────────────────────────

/** Tick the collapse queue. Called each frame with delta time. */
export function updateCollapseQueue(dt) {
  for (let i = collapseQueue.length - 1; i >= 0; i--) {
    collapseQueue[i].delay -= dt;
    if (collapseQueue[i].delay <= 0) {
      const entry = collapseQueue.splice(i, 1)[0];
      const p = panels.get(entry.panelId);
      if (p && p.hp > 0) {
        // Compute center before destroying
        const center = computePanelCenter(p).clone();
        p.hp = 0;
        // Destroy panel (zeros vertices, updates collision, spawns break debris)
        // But for falling panels we want falling debris instead of break debris
        // So we manually handle it:
        const mesh = p.meshRef;
        if (mesh) {
          const geo = mesh.geometry;
          const positions = geo.attributes.position;
          const colors = geo.attributes.color;
          const start = p.vertexStart;
          const end = start + p.vertexCount;
          for (let vi = start; vi < end; vi++) {
            positions.setXYZ(vi, 0, 0, 0);
            if (colors) colors.setXYZ(vi, 0, 0, 0);
          }
          positions.needsUpdate = true;
          if (colors) colors.needsUpdate = true;
        }
        if (p.wallId !== undefined) {
          collisionWorld.destroyPanel(p.buildingId, p.wallId, p.gridX, p.gridY);
        }
        // Spawn falling debris (larger pieces, with impact damage)
        spawnFallingDebris(p, center);
      }
    }
  }
}

export function clearBuilding(buildingId) {
  for (const [id, p] of panels) {
    if (p.buildingId !== buildingId) continue;
    if (p.wallId !== undefined && p.gridX !== undefined && p.gridY !== undefined)
      panelByGridPos.delete(`${p.wallId},${p.gridX},${p.gridY}`);
    if (p.wallId !== undefined) {
      const key = `${p.buildingId},${p.wallId}`;
      const set = panelsByWall.get(key);
      if (set) { set.delete(id); if (set.size === 0) panelsByWall.delete(key); }
    }
    panels.delete(id);
  }
  for (const [id, p] of props) if (p.buildingId === buildingId) props.delete(id);
  // Clean wall mesh registry
  for (const key of wallMeshes.keys()) {
    if (key.startsWith(buildingId + ',')) wallMeshes.delete(key);
  }
  buildingGroups.delete(buildingId);
}
