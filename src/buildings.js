// ─── buildings.js ────────────────────────────────────────────────────────────
// Procedural building generation — steps 1–6 of building-generation-spec.md
// Pipeline: Footprint → Rooms (BSP) → Doors → Windows → Panel Instantiation
import * as THREE from 'three';
import { registerPanel, registerProp, nextSlabGroupId, panels, panelsByWall,
         registerWallMesh, registerBuildingGroup } from './destruction.js';
import { collisionWorld } from './collision.js';

// ─── Ladder placement registry ───────────────────────────────────────────────
export const ladderDefs = [];

const LADDER_NORMALS = {
  n: { x: 0, z: -1 },
  s: { x: 0, z:  1 },
  e: { x: 1, z:  0 },
  w: { x: -1, z: 0 },
};

function registerLadder(id, buildingId, ladderResult) {
  const { cx, cz, face, baseY, topY } = ladderResult;
  ladderDefs.push({
    id, buildingId, face,
    cx, cz, baseY, topY,
    normal: LADDER_NORMALS[face],
  });
}

export function removeLaddersForBuilding(buildingId) {
  for (let i = ladderDefs.length - 1; i >= 0; i--) {
    if (ladderDefs[i].buildingId === buildingId) ladderDefs.splice(i, 1);
  }
}

// ─── §4 Panel types ──────────────────────────────────────────────────────────
export const PANEL_TYPES = {
  concrete:  { hp: 5, pen: 1.0, color: 0x6b6b6b, debrisCount: [4, 8],  mass: 2.0 },
  brick:     { hp: 3, pen: 0.8, color: 0x8b4513, debrisCount: [5, 10], mass: 1.5 },
  wood:      { hp: 2, pen: 0.5, color: 0xc4a86b, debrisCount: [3, 6],  mass: 0.8 },
  glass:     { hp: 1, pen: 0.1, color: 0xaad4e6, opacity: 0.3, debrisCount: [8, 15], mass: 0.5 },
  metal:     { hp: 4, pen: 0.9, color: 0x4a4a4a, debrisCount: [3, 5],  mass: 1.8 },
};

// ─── §5 Archetype configuration ──────────────────────────────────────────────
const ARCHETYPE_CFG = {
  warehouse: {
    minW: 10, maxW: 20, minD: 15, maxD: 30,
    minFloors: 1, maxFloors: 1, floorH: 6,
    minRoom: 6,
    shape: 'rect',
    style: { extWall: 'metal', intWall: 'wood', floorMat: 'concrete', windowDensity: 0.12 },
  },
  dwelling: {
    minW: 6, maxW: 10, minD: 8, maxD: 12,
    minFloors: 1, maxFloors: 2, floorH: 3,
    minRoom: 3,
    shape: 'rect_or_l',      // 60% L-shape
    style: { extWall: 'brick', intWall: 'wood', floorMat: 'wood', windowDensity: 0.9 },
  },
  apartment: {
    minW: 10, maxW: 15, minD: 15, maxD: 25,
    minFloors: 3, maxFloors: 6, floorH: 3,
    minRoom: 3,
    shape: 'rect_or_u',     // 50% U-shape
    hasCorridor: true,
    style: { extWall: 'concrete', intWall: 'wood', floorMat: 'concrete', windowDensity: 0.9 },
  },
  office: {
    minW: 12, maxW: 20, minD: 12, maxD: 20,
    minFloors: 3, maxFloors: 8, floorH: 3,
    minRoom: 3,
    shape: 'rect_or_t',     // 50% T-shape
    hasCorridor: true,
    style: { extWall: 'concrete', intWall: 'wood', floorMat: 'concrete', windowDensity: 1.0 },
  },
  strip_mall: {
    minW: 8, maxW: 15, minD: 6, maxD: 10,
    minFloors: 1, maxFloors: 1, floorH: 3,
    minRoom: 3,
    shape: 'rect',
    style: { extWall: 'concrete', intWall: 'wood', floorMat: 'concrete', windowDensity: 0.3 },
  },
};

const ROOM_TAGS = {
  warehouse:  ['warehouse_floor'],
  dwelling:   ['living_room', 'kitchen', 'bedroom', 'bathroom'],
  apartment:  ['living_room', 'bedroom', 'bathroom'],
  office:     ['office_room', 'open_office'],
  strip_mall: ['retail', 'storage'],
};

// ─── §6 Interior prop definitions ────────────────────────────────────────────
// w/d in cells (metres), h in metres, hp, mat = panel material key
const PROP_DEFS = {
  table:      { w: 1,   h: 0.8, d: 1,   hp: 3, mat: 'wood'  },
  desk:       { w: 1,   h: 0.8, d: 0.7, hp: 4, mat: 'wood'  },
  counter:    { w: 1,   h: 1.0, d: 0.5, hp: 4, mat: 'wood'  },
  shelf:      { w: 2,   h: 1.8, d: 0.3, hp: 3, mat: 'wood'  },
  couch:      { w: 2,   h: 0.7, d: 1,   hp: 3, mat: 'wood'  },
  bed:        { w: 2,   h: 0.5, d: 1,   hp: 2, mat: 'wood'  },
  crate:      { w: 1,   h: 1.0, d: 1,   hp: 5, mat: 'wood'  },
  filing:     { w: 0.5, h: 1.2, d: 0.5, hp: 4, mat: 'metal' },
  conf_table: { w: 2,   h: 0.8, d: 1,   hp: 5, mat: 'wood'  },
};

const PROP_TABLE = {
  living_room:     ['couch', 'table', 'shelf'],
  kitchen:         ['counter', 'table'],
  bedroom:         ['bed', 'desk', 'shelf'],
  office_room:     ['desk', 'shelf'],
  open_office:     ['desk', 'desk', 'desk'],
  retail:          ['counter', 'shelf', 'shelf'],
  warehouse_floor: ['crate', 'crate', 'shelf'],
  storage:         ['crate', 'shelf'],
  // corridor / stairwell / bathroom: no props
};

// ─── Material cache (shared across buildings) ─────────────────────────────────
const _matCache = new Map();
function getPanelMat(typeName) {
  if (_matCache.has(typeName)) return _matCache.get(typeName);
  const def = PANEL_TYPES[typeName] ?? PANEL_TYPES.concrete;
  const mat = new THREE.MeshPhongMaterial({
    color: def.color,
    transparent: def.opacity !== undefined,
    opacity: def.opacity ?? 1.0,
    flatShading: true,
  });
  _matCache.set(typeName, mat);
  return mat;
}

// ─── Wall mesh materials (vertex-colored, shared) ────────────────────────────
let _wallMat = null;
function getWallMat() {
  if (!_wallMat) _wallMat = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true });
  return _wallMat;
}
let _glassMat = null;
function getGlassMat() {
  if (!_glassMat) _glassMat = new THREE.MeshPhongMaterial({
    vertexColors: true, flatShading: true, transparent: true, opacity: 0.3,
  });
  return _glassMat;
}

/** Convert a panel type name to RGB floats. */
function panelColorRGB(typeName) {
  const def = PANEL_TYPES[typeName] ?? PANEL_TYPES.concrete;
  return [
    ((def.color >> 16) & 0xff) / 255,
    ((def.color >> 8) & 0xff) / 255,
    (def.color & 0xff) / 255,
  ];
}

/** Build a wall mesh from per-panel vertex data with vertex colors. */
function buildWallMesh(positions, colors, panelIds, buildingId, transparent) {
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, transparent ? getGlassMat() : getWallMat());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.isWallMesh = true;
  mesh.userData.buildingId = buildingId;
  mesh.userData.panelIndexToId = panelIds;
  return mesh;
}

/** Push 6 vertices of color (r,g,b) into the colors array. */
function pushFaceColor(arr, r, g, b) {
  for (let i = 0; i < 6; i++) arr.push(r, g, b);
}

/** Emit per-panel geometry: always 36 vertices (fixed stride for raycast lookup).
 *  Suppressed faces become degenerate (zero-area) triangles to avoid z-fighting. */
function emitPanelFaces(posArr, x0, y0, z0, x1, y1, z1, faceMask) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const allFaces = [FACE_PY, FACE_NY, FACE_PZ, FACE_NZ, FACE_PX, FACE_NX];
  for (const face of allFaces) {
    if (faceMask & face) {
      posArr.push(...slabFaceVerts(x0, y0, z0, x1, y1, z1, face));
    } else {
      // Degenerate face: 6 coincident vertices → 2 zero-area triangles
      posArr.push(cx, cy, cz, cx, cy, cz, cx, cy, cz, cx, cy, cz, cx, cy, cz, cx, cy, cz);
    }
  }
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

// Full 6-face solid box (non-indexed, correct CCW winding). Used for props.
function solidBoxVerts(cx, cy, cz, w, h, d) {
  const hx=w*0.5, hy=h*0.5, hz=d*0.5;
  const x0=cx-hx, x1=cx+hx, y0=cy-hy, y1=cy+hy, z0=cz-hz, z1=cz+hz;
  return [
    x0,y1,z0, x0,y1,z1, x1,y1,z1,  x0,y1,z0, x1,y1,z1, x1,y1,z0, // +Y
    x0,y0,z1, x0,y0,z0, x1,y0,z0,  x0,y0,z1, x1,y0,z0, x1,y0,z1, // -Y
    x0,y0,z1, x1,y0,z1, x1,y1,z1,  x0,y0,z1, x1,y1,z1, x0,y1,z1, // +Z
    x1,y0,z0, x0,y0,z0, x0,y1,z0,  x1,y0,z0, x0,y1,z0, x1,y1,z0, // -Z
    x1,y0,z0, x1,y1,z0, x1,y1,z1,  x1,y0,z0, x1,y1,z1, x1,y0,z1, // +X
    x0,y0,z1, x0,y1,z1, x0,y1,z0,  x0,y0,z1, x0,y1,z0, x0,y0,z0, // -X
  ];
}

// Face bitmask constants for selective face emission
const FACE_PX = 1, FACE_NX = 2, FACE_PY = 4, FACE_NY = 8, FACE_PZ = 16, FACE_NZ = 32;

// Unified slab geometry: emits only faces specified by bitmask.
// Takes origin-based bounds (x0,y0,z0 → x1,y1,z1), not center+extents.
function slabFaceVerts(x0, y0, z0, x1, y1, z1, mask) {
  const out = [];
  if (mask & FACE_PY) out.push(x0,y1,z0, x0,y1,z1, x1,y1,z1,  x0,y1,z0, x1,y1,z1, x1,y1,z0);
  if (mask & FACE_NY) out.push(x0,y0,z1, x0,y0,z0, x1,y0,z0,  x0,y0,z1, x1,y0,z0, x1,y0,z1);
  if (mask & FACE_PZ) out.push(x0,y0,z1, x1,y0,z1, x1,y1,z1,  x0,y0,z1, x1,y1,z1, x0,y1,z1);
  if (mask & FACE_NZ) out.push(x1,y0,z0, x0,y0,z0, x0,y1,z0,  x1,y0,z0, x0,y1,z0, x1,y1,z0);
  if (mask & FACE_PX) out.push(x1,y0,z0, x1,y1,z0, x1,y1,z1,  x1,y0,z0, x1,y1,z1, x1,y0,z1);
  if (mask & FACE_NX) out.push(x0,y0,z1, x0,y1,z1, x0,y1,z0,  x0,y0,z1, x0,y1,z0, x0,y0,z0);
  return out;
}

// Center-based ±Y slab wrapper (stairs, ladders, catwalks — no face culling needed)
function slabVerts(cx, cy, cz, w, h, d) {
  return slabFaceVerts(cx-w*0.5, cy-h*0.5, cz-d*0.5, cx+w*0.5, cy+h*0.5, cz+d*0.5, FACE_PY|FACE_NY);
}

// Vertical slab edge face: one cell-width strip, used for door frame reveals and open-edge sides.
// axis 'x': edge at x=ex spanning z=[ea,eb]; axis 'z': edge at z=ex spanning x=[ea,eb].
// dir +1 → normal points +X or +Z; dir -1 → normal points -X or -Z.
function slabEdgeFaceVerts(ex, y0, y1, ea, eb, axis, dir) {
  if (axis === 'x') {
    return dir > 0
      ? [ex,y0,ea, ex,y1,ea, ex,y1,eb,  ex,y0,ea, ex,y1,eb, ex,y0,eb]  // normal +X
      : [ex,y0,eb, ex,y1,eb, ex,y1,ea,  ex,y0,eb, ex,y1,ea, ex,y0,ea]; // normal -X
  } else {
    return dir > 0
      ? [eb,y0,ex, eb,y1,ex, ea,y1,ex,  eb,y0,ex, ea,y1,ex, ea,y0,ex]  // normal +Z
      : [ea,y0,ex, ea,y1,ex, eb,y1,ex,  ea,y0,ex, eb,y1,ex, eb,y0,ex]; // normal -Z
  }
}


function buildMesh(arr, mat) {
  if (!arr || arr.length === 0) return null;
  const data = new Float32Array(arr);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ─── §1.2 Data-structure factories ───────────────────────────────────────────

function makeFloorPlan(width, depth) {
  return {
    width,
    depth,
    cells: Array.from({ length: width }, () => new Uint8Array(depth)),
    walls: {
      h: Array.from({ length: width },     () => new Uint8Array(depth + 1)),
      v: Array.from({ length: width + 1 }, () => new Uint8Array(depth)),
    },
    wallMaterials: {
      h: Array.from({ length: width },     () => new Uint8Array(depth + 1)),
      v: Array.from({ length: width + 1 }, () => new Uint8Array(depth)),
    },
    doors:   new Set(), // string keys "h:x:z" or "v:x:z"
    windows: new Set(),
    props:   [],        // [{x, z, type}]
  };
}

// ─── §2.1 Footprint generation ────────────────────────────────────────────────

function dKey(axis, x, z) { return `${axis}:${x}:${z}`; }

export function generateFootprint(archetype, rng, maxW = 999, maxD = 999) {
  const cfg = ARCHETYPE_CFG[archetype];
  const w = Math.min(cfg.minW + Math.floor(rng() * (cfg.maxW - cfg.minW + 1)), maxW);
  const d = Math.min(cfg.minD + Math.floor(rng() * (cfg.maxD - cfg.minD + 1)), maxD);

  // Build full rectangle of interior cells
  const grid = Array.from({ length: w }, () => new Uint8Array(d).fill(1));

  if (cfg.shape === 'rect_or_l' && rng() < 0.6) {
    // L-shape: zero out a random corner block (at least 30% of each dimension)
    const cutX = Math.floor(w * 0.5) + Math.floor(rng() * Math.max(1, w * 0.25));
    const cutZ = Math.floor(d * 0.5) + Math.floor(rng() * Math.max(1, d * 0.25));
    for (let x = Math.min(cutX, w - 1); x < w; x++)
      for (let z = Math.min(cutZ, d - 1); z < d; z++)
        grid[x][z] = 0;
  } else if (cfg.shape === 'rect_or_t' && rng() < 0.5) {
    // T-shape: zero out two corner strips on the +Z end, keeping a centre bump
    const keepW = Math.max(Math.floor(w * 0.45), 4);
    const lCut  = Math.floor((w - keepW) / 2);
    const rCut  = w - lCut - keepW;
    const cutD  = Math.max(Math.floor(d * 0.35), 2);
    for (let z = d - cutD; z < d; z++) {
      for (let x = 0; x < lCut; x++) grid[x][z] = 0;
      for (let x = w - rCut; x < w; x++) grid[x][z] = 0;
    }
  } else if (cfg.shape === 'rect_or_u' && rng() < 0.5) {
    // U-shape: zero out a centre block on the +Z end
    const cutW    = Math.max(Math.floor(w * 0.4), 2);
    const cutStart = Math.floor((w - cutW) / 2);
    const cutD    = Math.max(Math.floor(d * 0.4), 2);
    for (let x = cutStart; x < cutStart + cutW; x++)
      for (let z = d - cutD; z < d; z++)
        grid[x][z] = 0;
  }

  return { grid, width: w, depth: d };
}

// Build the wall boolean grid from a footprint cell grid.
// walls.h[x][z]: wall between (x, z-1) and (x, z)   — runs along X axis
// walls.v[x][z]: wall between (x-1, z) and (x, z)   — runs along Z axis
function initWalls(grid, width, depth) {
  const h = Array.from({ length: width },     () => new Uint8Array(depth + 1));
  const v = Array.from({ length: width + 1 }, () => new Uint8Array(depth));

  for (let x = 0; x < width; x++) {
    for (let z = 0; z <= depth; z++) {
      const below = z > 0     ? grid[x][z - 1] : 0;
      const above = z < depth ? grid[x][z]     : 0;
      if (below !== above && (below >= 1 || above >= 1)) h[x][z] = 1;
    }
  }
  for (let x = 0; x <= width; x++) {
    for (let z = 0; z < depth; z++) {
      const left  = x > 0     ? grid[x - 1][z] : 0;
      const right = x < width ? grid[x][z]     : 0;
      if (left !== right && (left >= 1 || right >= 1)) v[x][z] = 1;
    }
  }
  return { h, v };
}

// ─── §2.2 BSP room partitioning ──────────────────────────────────────────────

// Returns true if the region [x0,x1) × [z0,z1) contains any interior cell.
function regionHasInterior(grid, x0, z0, x1, z1) {
  for (let x = x0; x < x1; x++)
    for (let z = z0; z < z1; z++)
      if (grid[x]?.[z] >= 1) return true;
  return false;
}

function bspSplit(grid, walls, x0, z0, x1, z1, minRoom, rng, rooms, depth) {
  // Don't split regions with no interior cells (L/T/U cutout areas)
  if (!regionHasInterior(grid, x0, z0, x1, z1)) return;

  const w = x1 - x0, d = z1 - z0;
  const canSplitH = d >= minRoom * 2;
  const canSplitV = w >= minRoom * 2;

  if ((!canSplitH && !canSplitV) || depth >= 8) {
    rooms.push({ x0, z0, x1, z1 });
    return;
  }

  // Prefer splitting the longer axis
  const splitH = canSplitH && (!canSplitV || d >= w);

  if (splitH) {
    const lo = z0 + minRoom, hi = z1 - minRoom;
    if (lo > hi) { rooms.push({ x0, z0, x1, z1 }); return; }
    const s = lo + Math.floor(rng() * (hi - lo + 1));
    // Only place wall segments where at least one adjacent cell is interior
    for (let x = x0; x < x1; x++) {
      const below = grid[x]?.[s - 1] ?? 0;
      const above = grid[x]?.[s]     ?? 0;
      if (below >= 1 || above >= 1) walls.h[x][s] = 1;
    }
    bspSplit(grid, walls, x0, z0, x1, s,  minRoom, rng, rooms, depth + 1);
    bspSplit(grid, walls, x0, s,  x1, z1, minRoom, rng, rooms, depth + 1);
  } else {
    const lo = x0 + minRoom, hi = x1 - minRoom;
    if (lo > hi) { rooms.push({ x0, z0, x1, z1 }); return; }
    const s = lo + Math.floor(rng() * (hi - lo + 1));
    for (let z = z0; z < z1; z++) {
      const left  = grid[s - 1]?.[z] ?? 0;
      const right = grid[s]?.[z]     ?? 0;
      if (left >= 1 || right >= 1) walls.v[s][z] = 1;
    }
    bspSplit(grid, walls, x0, z0, s,  z1, minRoom, rng, rooms, depth + 1);
    bspSplit(grid, walls, s,  z0, x1, z1, minRoom, rng, rooms, depth + 1);
  }
}

function partitionRooms(grid, walls, width, depth, archetype, rng) {
  const cfg  = ARCHETYPE_CFG[archetype];
  const rooms = [];

  if (cfg.hasCorridor) {
    // Carve a 1-cell corridor strip along the long axis and add walls around it
    if (width >= depth) {
      // Vertical corridor at centre column, running along Z
      const cx = Math.floor(width / 2);
      for (let z = 0; z < depth; z++) if (grid[cx][z] === 1) grid[cx][z] = 2;
      // Corridor boundary walls
      for (let z = 0; z < depth; z++) {
        walls.v[cx][z]     = 1; // left edge  (between cx-1 and cx)
        walls.v[cx + 1][z] = 1; // right edge (between cx and cx+1)
      }
      // Corridor is a room so door placement can connect adjacent rooms to it
      rooms.push({ x0: cx, z0: 0, x1: cx + 1, z1: depth, tag: 'corridor' });
      // BSP each side
      if (cx >= cfg.minRoom)
        bspSplit(grid, walls, 0, 0, cx, depth, cfg.minRoom, rng, rooms, 0);
      else
        rooms.push({ x0: 0, z0: 0, x1: cx, z1: depth });
      if (width - cx - 1 >= cfg.minRoom)
        bspSplit(grid, walls, cx + 1, 0, width, depth, cfg.minRoom, rng, rooms, 0);
      else
        rooms.push({ x0: cx + 1, z0: 0, x1: width, z1: depth });
    } else {
      // Horizontal corridor at centre row, running along X
      const cz = Math.floor(depth / 2);
      for (let x = 0; x < width; x++) if (grid[x][cz] === 1) grid[x][cz] = 2;
      for (let x = 0; x < width; x++) {
        walls.h[x][cz]     = 1;
        walls.h[x][cz + 1] = 1;
      }
      rooms.push({ x0: 0, z0: cz, x1: width, z1: cz + 1, tag: 'corridor' });
      if (cz >= cfg.minRoom)
        bspSplit(grid, walls, 0, 0, width, cz, cfg.minRoom, rng, rooms, 0);
      else
        rooms.push({ x0: 0, z0: 0, x1: width, z1: cz });
      if (depth - cz - 1 >= cfg.minRoom)
        bspSplit(grid, walls, 0, cz + 1, width, depth, cfg.minRoom, rng, rooms, 0);
      else
        rooms.push({ x0: 0, z0: cz + 1, x1: width, z1: depth });
    }
  } else {
    bspSplit(grid, walls, 0, 0, width, depth, cfg.minRoom, rng, rooms, 0);
  }

  // Tag rooms (corridors already tagged above)
  const tags = ROOM_TAGS[archetype];
  rooms.forEach((r, i) => { if (!r.tag) r.tag = tags[i % tags.length]; });

  return rooms;
}

// ─── §2.3 Door placement ─────────────────────────────────────────────────────

function sharedWallSegments(roomA, roomB, walls) {
  const segs = [];

  // Vertical boundary: roomA.x1 == roomB.x0 or vice-versa
  const xBound = roomA.x1 === roomB.x0 ? roomA.x1
               : roomB.x1 === roomA.x0 ? roomB.x1 : -1;
  if (xBound >= 0) {
    const z0 = Math.max(roomA.z0, roomB.z0);
    const z1 = Math.min(roomA.z1, roomB.z1);
    for (let z = z0; z < z1; z++)
      if (walls.v[xBound]?.[z]) segs.push({ axis: 'v', x: xBound, z });
  }

  // Horizontal boundary: roomA.z1 == roomB.z0 or vice-versa
  const zBound = roomA.z1 === roomB.z0 ? roomA.z1
               : roomB.z1 === roomA.z0 ? roomB.z1 : -1;
  if (zBound >= 0) {
    const x0 = Math.max(roomA.x0, roomB.x0);
    const x1 = Math.min(roomA.x1, roomB.x1);
    for (let x = x0; x < x1; x++)
      if (walls.h[x]?.[zBound]) segs.push({ axis: 'h', x, z: zBound });
  }

  return segs;
}

function placeDoors(floorplan, rooms, rng, isGround) {
  const { walls, doors, width, depth } = floorplan;
  const n = rooms.length;
  if (n === 0) return;

  // Build adjacency list
  const adj = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const segs = sharedWallSegments(rooms[i], rooms[j], walls);
      if (segs.length > 0) adj.push({ a: i, b: j, segs });
    }

  // MST via union-find (Kruskal's with shuffled edges)
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(x, y) { parent[find(x)] = find(y); }

  const shuffled = [...adj].sort(() => rng() - 0.5);
  const mstEdges = new Set();

  for (const edge of shuffled) {
    if (find(edge.a) !== find(edge.b)) {
      union(edge.a, edge.b);
      mstEdges.add(edge);
    }
  }

  // Returns true if this wall segment is at a corner-extension column and should
  // not receive a door or window.
  function isTerminal(seg) {
    if (seg.axis === 'h') {
      const atL = (seg.z > 0 && walls.v[seg.x]?.[seg.z - 1])    || (seg.z < depth && walls.v[seg.x]?.[seg.z]);
      const atR = (seg.z > 0 && walls.v[seg.x+1]?.[seg.z - 1])  || (seg.z < depth && walls.v[seg.x+1]?.[seg.z]);
      return atL || atR;
    } else {
      const atB = (seg.x > 0 && walls.h[seg.x-1]?.[seg.z])   || (seg.x < width && walls.h[seg.x]?.[seg.z]);
      const atT = (seg.x > 0 && walls.h[seg.x-1]?.[seg.z+1]) || (seg.x < width && walls.h[seg.x]?.[seg.z+1]);
      return atB || atT;
    }
  }

  function pickNonTerminal(segs) {
    const valid = segs.filter(s => !isTerminal(s));
    const pool = valid.length > 0 ? valid : segs; // fall back to any seg if all are terminal
    return pool[Math.floor(rng() * pool.length)];
  }

  function addDoor(seg) {
    const k = dKey(seg.axis, seg.x, seg.z);
    doors.add(k);
    // Wall bit stays set — the panel loop uses isDoor + DOOR_H to create the gap,
    // leaving one solid lintel panel above the opening.
  }

  // One door per MST edge
  for (const edge of mstEdges) {
    addDoor(pickNonTerminal(edge.segs));
  }

  // 30% extra doors per non-MST edge (creates loops)
  for (const edge of shuffled) {
    if (!mstEdges.has(edge) && rng() < 0.3) {
      const seg = pickNonTerminal(edge.segs);
      const k = dKey(seg.axis, seg.x, seg.z);
      if (!doors.has(k)) addDoor(seg);
    }
  }

  // Exterior doors on ground floor: at least 2 on different walls
  if (isGround) {
    // Collect candidate segments per wall face
    const wallFaces = [
      { segs: [], label: 'south' }, // h-wall z=0
      { segs: [], label: 'north' }, // h-wall z=depth
      { segs: [], label: 'west' },  // v-wall x=0
      { segs: [], label: 'east' },  // v-wall x=width
    ];
    for (let x = 0; x < width; x++) {
      if (walls.h[x]?.[0])     wallFaces[0].segs.push({ axis: 'h', x, z: 0 });
      if (walls.h[x]?.[depth]) wallFaces[1].segs.push({ axis: 'h', x, z: depth });
    }
    for (let z = 0; z < depth; z++) {
      if (walls.v[0]?.[z])     wallFaces[2].segs.push({ axis: 'v', x: 0, z });
      if (walls.v[width]?.[z]) wallFaces[3].segs.push({ axis: 'v', x: width, z });
    }

    // Shuffle face order, then place one door on each face that has segments
    const faceOrder = wallFaces.filter(f => f.segs.length > 0).sort(() => rng() - 0.5);
    let extDoorCount = 0;
    for (const face of faceOrder) {
      const seg = pickNonTerminal(face.segs);
      const k = dKey(seg.axis, seg.x, seg.z);
      if (!doors.has(k)) {
        addDoor(seg);
        extDoorCount++;
      }
      if (extDoorCount >= 2) break;
    }
    // Fallback: if we only placed 0-1 doors, try remaining faces
    if (extDoorCount < 2) {
      for (const face of faceOrder) {
        for (const seg of face.segs) {
          const k = dKey(seg.axis, seg.x, seg.z);
          if (!doors.has(k)) {
            addDoor(seg);
            extDoorCount++;
            break;
          }
        }
        if (extDoorCount >= 2) break;
      }
    }
  }
}

// ─── §2.4 Window placement ────────────────────────────────────────────────────

function placeWindows(floorplan, archetype, windowDensity, floorIdx, rng) {
  const { cells: grid, walls, doors, windows, width, depth } = floorplan;

  // Glass walls (office, storefront) are exempt from the no-window-next-to-door rule.
  const isGlassWallArch = archetype === 'office';

  // h-walls
  for (let x = 0; x < width; x++) {
    for (let z = 0; z <= depth; z++) {
      if (!walls.h[x][z]) continue;
      const k = dKey('h', x, z);
      if (doors.has(k)) continue;
      const below = z > 0     ? grid[x][z - 1] : 0;
      const above = z < depth ? grid[x][z]     : 0;
      if (below !== 0 && above !== 0) continue; // interior wall — no window
      // §6: no window in terminal column (adjacent to perpendicular wall junction)
      const atLeftJunction  = (z > 0 && walls.v[x]?.[z-1]) || (z < depth && walls.v[x]?.[z]);
      const atRightJunction = (z > 0 && walls.v[x+1]?.[z-1]) || (z < depth && walls.v[x+1]?.[z]);
      if (atLeftJunction || atRightJunction) continue;
      // No window next to a door (glass walls exempt)
      const isStorefront = archetype === 'strip_mall' && z === 0;
      if (!isGlassWallArch && !isStorefront) {
        if (doors.has(dKey('h', x - 1, z)) || doors.has(dKey('h', x + 1, z))) continue;
      }
      // Archetype rules
      if (archetype === 'warehouse' && floorIdx === 0) continue;
      let density = windowDensity;
      if (archetype === 'strip_mall') density = z === 0 ? 1.0 : 0.08;
      if (rng() < density) windows.add(k);
    }
  }

  // v-walls
  for (let x = 0; x <= width; x++) {
    for (let z = 0; z < depth; z++) {
      if (!walls.v[x][z]) continue;
      const k = dKey('v', x, z);
      if (doors.has(k)) continue;
      const left  = x > 0     ? grid[x - 1][z] : 0;
      const right = x < width ? grid[x][z]     : 0;
      if (left !== 0 && right !== 0) continue; // interior wall
      // §6: no window in terminal column
      const atBotJunction = (x > 0 && walls.h[x-1]?.[z]) || (x < width && walls.h[x]?.[z]);
      const atTopJunction = (x > 0 && walls.h[x-1]?.[z+1]) || (x < width && walls.h[x]?.[z+1]);
      if (atBotJunction || atTopJunction) continue;
      // No window next to a door (glass walls exempt)
      if (!isGlassWallArch) {
        if (doors.has(dKey('v', x, z - 1)) || doors.has(dKey('v', x, z + 1))) continue;
      }
      if (archetype === 'warehouse' && floorIdx === 0) continue;
      let density = windowDensity;
      if (archetype === 'strip_mall') density = 0.08;
      if (rng() < density) windows.add(k);
    }
  }
}

// ─── §2.6 Prop placement ─────────────────────────────────────────────────────

function placeProps(fp, rooms, rng) {
  const { cells: grid, doors, width, depth } = fp;

  // Build set of cells adjacent to any door (1-cell clearance zone)
  const doorAdj = new Set();
  for (const k of doors) {
    const [axis, xs, zs] = k.split(':');
    const x = Number(xs), z = Number(zs);
    if (axis === 'h') {
      // horizontal wall at z: cells (x, z-1) and (x, z)
      for (let dx = -1; dx <= 1; dx++) {
        doorAdj.add(`${x + dx}:${z - 1}`);
        doorAdj.add(`${x + dx}:${z}`);
      }
    } else {
      // vertical wall at x: cells (x-1, z) and (x, z)
      for (let dz = -1; dz <= 1; dz++) {
        doorAdj.add(`${x - 1}:${z + dz}`);
        doorAdj.add(`${x}:${z + dz}`);
      }
    }
  }

  const occupied = new Set(); // "x:z" cells already taken

  function cellFree(x, z, pw, pd) {
    const xi = Math.ceil(pw), zi = Math.ceil(pd);
    for (let dx = 0; dx < xi; dx++) {
      for (let dz = 0; dz < zi; dz++) {
        const cx2 = x + dx, cz2 = z + dz;
        if (cx2 >= width || cz2 >= depth) return false;
        if (!grid[cx2]?.[cz2]) return false;
        if (doorAdj.has(`${cx2}:${cz2}`)) return false;
        if (occupied.has(`${cx2}:${cz2}`)) return false;
      }
    }
    return true;
  }

  function markOccupied(x, z, pw, pd) {
    const xi = Math.ceil(pw), zi = Math.ceil(pd);
    for (let dx = 0; dx < xi; dx++)
      for (let dz = 0; dz < zi; dz++)
        occupied.add(`${x + dx}:${z + dz}`);
  }

  for (const room of rooms) {
    const types = PROP_TABLE[room.tag];
    if (!types || types.length === 0) continue;
    // Shuffle prop list
    const shuffled = [...types].sort(() => rng() - 0.5);
    for (const typeName of shuffled) {
      const def = PROP_DEFS[typeName];
      if (!def) continue;
      // Try a few random positions inside the room (edge-biased)
      const roomW = room.x1 - room.x0;
      const roomD = room.z1 - room.z0;
      if (roomW < 2 || roomD < 2) continue;
      let placed = false;
      for (let attempt = 0; attempt < 12 && !placed; attempt++) {
        // Bias toward edges: 50% chance try near a wall
        let px, pz;
        if (rng() < 0.6) {
          // Along an edge
          const edge = Math.floor(rng() * 4);
          if (edge === 0) { px = room.x0; pz = room.z0 + Math.floor(rng() * (roomD - 1)); }
          else if (edge === 1) { px = room.x1 - Math.ceil(def.w); pz = room.z0 + Math.floor(rng() * (roomD - 1)); }
          else if (edge === 2) { px = room.x0 + Math.floor(rng() * (roomW - 1)); pz = room.z0; }
          else { px = room.x0 + Math.floor(rng() * (roomW - 1)); pz = room.z1 - Math.ceil(def.d); }
        } else {
          px = room.x0 + Math.floor(rng() * (roomW - 1));
          pz = room.z0 + Math.floor(rng() * (roomD - 1));
        }
        px = Math.max(room.x0, Math.min(px, room.x1 - Math.ceil(def.w)));
        pz = Math.max(room.z0, Math.min(pz, room.z1 - Math.ceil(def.d)));
        if (cellFree(px, pz, def.w, def.d)) {
          fp.props.push({ x: px, z: pz, type: typeName });
          markOccupied(px, pz, def.w, def.d);
          placed = true;
        }
      }
    }
  }
}

// ─── §7 Stairwell placement ───────────────────────────────────────────────────

// Check if any wall bordering the given cells has a door.
// Glass windows are OK (stairs can overlap glass), but doors are not.
function stairCellsHaveDoor(fp, cells) {
  const { doors } = fp;
  for (const [cx, cz] of cells) {
    // H-walls south (z) and north (z+1) of cell
    if (doors.has(dKey('h', cx, cz)))     return true;
    if (doors.has(dKey('h', cx, cz + 1))) return true;
    // V-walls west (x) and east (x+1) of cell
    if (doors.has(dKey('v', cx, cz)))     return true;
    if (doors.has(dKey('v', cx + 1, cz))) return true;
  }
  return false;
}

// Find a 2×1 interior region that could host a stairwell.
// Returns {x, z, axis:'x'|'z'} where axis='x' means 2 cells along x, axis='z' means 2 cells along z.
function findStairPosition(fp, width, depth) {
  const { cells: grid } = fp;

  // Try axis-x first (2 cells in x direction)
  // x >= 1 so entry isn't against exterior wall; x+1 <= width-2 so exit has clearance
  for (let x = 1; x < width - 2; x++) {
    for (let z = 1; z < depth - 1; z++) {
      if (grid[x][z] >= 1 && grid[x][z] !== 3 &&
          grid[x + 1][z] >= 1 && grid[x + 1][z] !== 3 &&
          !stairCellsHaveDoor(fp, [[x, z], [x + 1, z]])) {
        return { x, z, axis: 'x' };
      }
    }
  }
  // Try axis-z (2 cells in z direction)
  // z >= 1 so entry isn't against exterior wall; z+1 <= depth-2 so exit has clearance
  for (let x = 1; x < width - 1; x++) {
    for (let z = 1; z < depth - 2; z++) {
      if (grid[x][z] >= 1 && grid[x][z] !== 3 &&
          grid[x][z + 1] >= 1 && grid[x][z + 1] !== 3 &&
          !stairCellsHaveDoor(fp, [[x, z], [x, z + 1]])) {
        return { x, z, axis: 'z' };
      }
    }
  }
  return null;
}

// Mark stairwell cells across all floors and record position in buildingDef.
function addStairwells(buildingDef) {
  const { floors } = buildingDef;
  if (floors.length < 2) return;

  const pos = findStairPosition(floors[0], buildingDef.footprintW, buildingDef.footprintD);
  if (!pos) return;

  const { x, z, axis } = pos;
  for (const fp of floors) {
    fp.cells[x][z] = 3;
    if (axis === 'x') fp.cells[x + 1][z] = 3;
    else              fp.cells[x][z + 1] = 3;
  }
  buildingDef.stairwells.push({ x, z, axis });
}

// Build stair step geometry for one flight (floor f → f+1).
// Returns a flat Float32Array-ready number[] of vertices (wood material).
function buildStairVerts(sx, sz, floorY, hpf, axis) {
  const STEPS   = 10;
  const stepH   = hpf / STEPS;
  const stepRun = (axis === 'x' ? 2 : 2) / STEPS; // 2 cells / 10 steps = 0.2m each
  const stepW   = 1.0; // 1 cell wide
  const verts   = [];

  for (let i = 0; i < STEPS; i++) {
    const y   = floorY + i * stepH;
    const off = i * stepRun;
    let cx, cz, w, d;
    if (axis === 'x') {
      cx = sx + off + stepRun * 0.5;
      cz = sz + stepW * 0.5;
      w = stepRun;
      d = stepW;
    } else {
      cx = sx + stepW * 0.5;
      cz = sz + off + stepRun * 0.5;
      w = stepW;
      d = stepRun;
    }
    verts.push(...solidBoxVerts(cx, y + stepH * 0.5, cz, w, stepH, d));
  }
  return verts;
}

// ─── §7.2 Ladder geometry ────────────────────────────────────────────────────

// Pick a cell index along a wall face that doesn't overlap a door.
// face 'n'|'s' → scans along x (0..width-1), checking h-walls at z=0 or z=depth.
// face 'e'|'w' → scans along z (0..depth-1), checking v-walls at x=width or x=0.
// Returns the best cell index; defaults to center if no door-free cell found.
function pickLadderCell(groundFP, face, bw, bd) {
  if (!groundFP) return (face === 'n' || face === 's') ? Math.floor(bw * 0.5) : Math.floor(bd * 0.5);
  const { doors, width, depth } = groundFP;
  if (face === 'n' || face === 's') {
    const wallZ = face === 'n' ? 0 : depth;
    const center = Math.floor(bw * 0.5);
    // Try center first, then spiral outward
    for (let offset = 0; offset < width; offset++) {
      for (const dir of [0, 1, -1]) {
        const cell = center + dir * offset;
        if (cell < 0 || cell >= width) continue;
        if (!doors.has(dKey('h', cell, wallZ))) return cell;
      }
    }
    return center;
  } else {
    const wallX = face === 'e' ? width : 0;
    const center = Math.floor(bd * 0.5);
    for (let offset = 0; offset < depth; offset++) {
      for (const dir of [0, 1, -1]) {
        const cell = center + dir * offset;
        if (cell < 0 || cell >= depth) continue;
        if (!doors.has(dKey('v', wallX, cell))) return cell;
      }
    }
    return center;
  }
}

// Build ladder geometry attached to a wall face.
// wx, wz = world-space corner of the building; bw, bd = footprint dimensions
// totalHeight = height in metres; face = 'n'|'s'|'e'|'w' (which building wall)
// cellIdx = which cell along the wall to place the ladder at
function buildLadderMesh(wx, wy, wz, bw, bd, face, totalHeight, cellIdx) {
  const verts = [];
  const RUNG_SPACING = 0.3;
  const RUNG_W = 0.4;
  const RUNG_H = 0.06;
  const RUNG_D = 0.06;
  const RAIL_W = 0.04;
  const OFFSET = 0.08; // how far from wall face

  let cx, cz, railDim; // centre of ladder (snapped to cell centre)
  if (face === 'n' || face === 's') {
    cx = wx + (cellIdx ?? Math.floor(bw * 0.5)) + 0.5;
    cz = face === 'n' ? wz - OFFSET : wz + bd + OFFSET;
    railDim = 'x';
  } else {
    cx = face === 'e' ? wx + bw + OFFSET : wx - OFFSET;
    cz = wz + (cellIdx ?? Math.floor(bd * 0.5)) + 0.5;
    railDim = 'z';
  }

  const rungs = Math.floor(totalHeight / RUNG_SPACING);
  for (let i = 0; i <= rungs; i++) {
    const y = wy + i * RUNG_SPACING;
    if (railDim === 'x')
      verts.push(...slabVerts(cx, y, cz, RUNG_W, RUNG_H, RUNG_D));
    else
      verts.push(...slabVerts(cx, y, cz, RUNG_D, RUNG_H, RUNG_W));
  }

  // Rails (two vertical boxes on either side of the rung span)
  const railH = totalHeight;
  const halfSpan = RUNG_W * 0.5 - RAIL_W * 0.5;
  if (railDim === 'x') {
    verts.push(...slabVerts(cx - halfSpan, wy + railH * 0.5, cz, RAIL_W, railH, RUNG_D));
    verts.push(...slabVerts(cx + halfSpan, wy + railH * 0.5, cz, RAIL_W, railH, RUNG_D));
  } else {
    verts.push(...slabVerts(cx, wy + railH * 0.5, cz - halfSpan, RUNG_D, railH, RAIL_W));
    verts.push(...slabVerts(cx, wy + railH * 0.5, cz + halfSpan, RUNG_D, railH, RAIL_W));
  }

  const mesh = buildMesh(verts, getPanelMat('metal'));
  return { mesh, cx, cz, face, baseY: wy, topY: wy + totalHeight };
}

// ─── §9 Archetype-specific features ─────────────────────────────────────────

// Warehouse catwalk: elevated walkway at mid-height with metal columns + ladder.
function addWarehouseCatwalk(group, buildingDef, wx, wy, wz, buildingId) {
  const { footprintW: bw, footprintD: bd, heightPerFloor: hpf } = buildingDef;
  const catY  = wy + hpf * 0.5; // 3m for 6m warehouse
  const slab  = 0.1;

  // Run catwalk along the long axis, 60% of length (centred)
  const alongZ = bd >= bw;
  const span   = alongZ ? bd : bw;
  const start  = Math.floor(span * 0.2);
  const end    = Math.floor(span * 0.8);
  const calkW  = alongZ ? bw : bd;
  const walkRow = Math.floor(calkW * 0.5); // midpoint cell (1 cell wide)

  const verts = [];
  for (let i = start; i < end; i++) {
    const cx = alongZ ? wx + walkRow + 0.5 : wx + i + 0.5;
    const cz = alongZ ? wz + i + 0.5       : wz + walkRow + 0.5;
    verts.push(...slabVerts(cx, catY + slab * 0.5, cz, 1, slab, 1));
  }
  const catMesh = buildMesh(verts, getPanelMat('concrete'));
  if (catMesh) group.add(catMesh);

  // Support columns every 3 cells
  const colMat = getPanelMat('metal');
  for (let i = start; i < end; i += 3) {
    const cx = alongZ ? wx + walkRow + 0.5 : wx + i + 0.5;
    const cz = alongZ ? wz + i + 0.5       : wz + walkRow + 0.5;
    const colGeo = new THREE.BoxGeometry(0.15, hpf * 0.5, 0.15);
    const col = new THREE.Mesh(colGeo, colMat);
    col.position.set(cx, wy + (hpf * 0.5) * 0.5, cz);
    group.add(col);
  }

  // Ladder from ground to catwalk on north face
  const groundFP = buildingDef.floors[0];
  const cellIdx = pickLadderCell(groundFP, 'n', bw, bd);
  const ladderResult = buildLadderMesh(wx, wy, wz, bw, bd, 'n', hpf * 0.5, cellIdx);
  if (ladderResult.mesh) {
    group.add(ladderResult.mesh);
    const ladId = _panelId++;
    registerProp({ id: ladId, type: 'ladder', hp: 3, maxHp: 3, buildingId });
    registerLadder(ladId, buildingId, ladderResult);
  }
}

// ─── §3 Panel instantiation ───────────────────────────────────────────────────

let _buildingId = 0;
let _panelId    = 0;

// ── Roof mesh registry (for debug toggling) ───────────────────────────────────
const _roofMeshes = [];
export function setRoofVisible(v) { for (const m of _roofMeshes) m.visible = v; }


const MAX_PANELS = 5000;

// Corner extension rule: H-walls (X-axis) extend 0.1m at the +X end to cover V-wall junctions.
// Returns Map keyed by "x,z" → { extPosX: bool }
function computeCornerExtensions(walls, width, depth) {
  const ext = new Map();
  for (let z = 0; z <= depth; z++) {
    for (let x = 0; x < width; x++) {
      if (!walls.h[x][z]) continue;
      // V-wall at right end of this H-segment (grid point x+1, z)
      const vRight = (z > 0 && walls.v[x + 1]?.[z - 1]) || (z < depth && walls.v[x + 1]?.[z]);
      if (vRight) {
        ext.set(`${x},${z}`, { extPosX: true });
      }
    }
  }
  return ext;
}

// Greedy rectangle merge for floor/ceiling slabs.
// Returns array of [x, z, w, d] rects covering all set cells in the mask.
function mergeSlabs(mask, width, depth) {
  const visited = Array.from({ length: width }, () => new Uint8Array(depth));
  const rects = [];
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      if (!mask[x][z] || visited[x][z]) continue;
      let w = 1;
      while (x + w < width && mask[x + w][z] && !visited[x + w][z]) w++;
      let d = 1;
      outer: while (z + d < depth) {
        for (let xi = x; xi < x + w; xi++)
          if (!mask[xi][z + d] || visited[xi][z + d]) break outer;
        d++;
      }
      for (let xi = x; xi < x + w; xi++)
        for (let zi = z; zi < z + d; zi++)
          visited[xi][zi] = 1;
      rects.push([x, z, w, d]);
    }
  }
  return rects;
}

// Greedy rectangle merge for typed 2D grids (wall panels).
// grid[x][y] = string type or falsy (empty). Returns array of [x, y, w, h, type].
function greedyRectMerge(grid, width, height) {
  const visited = Array.from({ length: width }, () => new Uint8Array(height));
  const rects = [];
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (!grid[x][y] || visited[x][y]) continue;
      const type = grid[x][y];
      let w = 1;
      while (x + w < width && grid[x + w][y] === type && !visited[x + w][y]) w++;
      let h = 1;
      outer: while (y + h < height) {
        for (let xi = x; xi < x + w; xi++)
          if (grid[xi][y + h] !== type || visited[xi][y + h]) break outer;
        h++;
      }
      for (let xi = x; xi < x + w; xi++)
        for (let yi = y; yi < y + h; yi++)
          visited[xi][yi] = 1;
      rects.push([x, y, w, h, type]);
    }
  }
  return rects;
}

export function instantiateBuilding(buildingDef, wx, wy, wz) {
  const group = new THREE.Group();
  const { floors, heightPerFloor, archetype } = buildingDef;
  const buildingId = _buildingId++;
  let panelCount = 0;

  for (let f = 0; f < floors.length; f++) {
    const fp = floors[f];
    const { cells: grid, walls, doors, windows, width, depth } = fp;
    const floorY    = wy + f * heightPerFloor;
    const slabThick = 0.1;

    // Vertex buffers keyed by panel material name
    const verts = {}; // typeName → number[]
    function getArr(t) { if (!verts[t]) verts[t] = []; return verts[t]; }

    // Slab panels (floor / ceiling). Origin-based bounds + face bitmask.
    // arrFn defaults to getArr; pass getRoofArr to route panels into the roof mesh.
    function addPanel(typeName, x0, y0, z0, x1, y1, z1, gridX, gridY, wallId, faceMask, arrFn = getArr) {
      if (panelCount >= MAX_PANELS) return;
      const arr = arrFn(typeName);
      const vertexStart = arr.length / 3;
      const v = slabFaceVerts(x0, y0, z0, x1, y1, z1, faceMask);
      for (const n of v) arr.push(n);
      const def = PANEL_TYPES[typeName] ?? PANEL_TYPES.concrete;
      registerPanel({
        id: _panelId++, type: typeName,
        hp: def.hp, maxHp: def.hp,
        gridX, gridY, wallId, buildingId,
        vertexStart, vertexCount: v.length / 3,
        penetrationCost: def.pen, isSupported: true,
      });
      panelCount++;
    }

    // ── Slab boundary helpers ─────────────────────────────────────────────
    // Slabs sit exactly on their grid cells. Wall panel edge faces seal the wall-slab
    // junction; open-edge reveals are handled by addOpenEdgeFaces below.
    function slabExtents(rx, rz, rw, rd) {
      // Extend +0.1m at +X / +Z edges wherever a wall exists, to cover wall tops.
      let extX = false, extZ = false;
      for (let z = rz; z < rz + rd && !extX; z++)
        if (walls.v[rx + rw]?.[z]) extX = true;
      for (let x = rx; x < rx + rw && !extZ; x++)
        if (walls.h[x]?.[rz + rd]) extZ = true;
      const sx1 = wx + rx + rw + (extX ? slabThick : 0);
      const sz1 = wz + rz + rd + (extZ ? slabThick : 0);
      return { sx0: wx + rx, sx1, sz0: wz + rz, sz1, extX, extZ };
    }
    // addSlabEdgeFaces: vertical slab-edge cap faces along the full perimeter of a merged rect.
    function addSlabEdgeFaces(range, edgePos, axis, dir, y0, y1) {
      for (const gi of range) {
        const ea = axis === 'x' ? wz + gi : wx + gi;
        getArr('concrete').push(...slabEdgeFaceVerts(edgePos, y0, y1, ea, ea + 1, axis, dir));
      }
    }

    // ── Floor slab (merged rectangles, ground floor top-face only) ───────
    {
      const mask = Array.from({ length: width }, (_, mx) => {
        const row = new Uint8Array(depth);
        for (let z = 0; z < depth; z++)
          if (grid[mx][z] && !(f > 0 && grid[mx][z] === 3)) row[z] = 1;
        return row;
      });
      const fy0 = floorY, fy1 = floorY + slabThick;
      for (const [rx, rz, rw, rd] of mergeSlabs(mask, width, depth)) {
        const { sx0, sx1, sz0, sz1, extX, extZ } = slabExtents(rx, rz, rw, rd);
        addPanel('concrete',
          sx0, fy0, sz0, sx1, fy1, sz1,
          rx, f*100, -1, f === 0 ? FACE_PY : (FACE_PY | FACE_NY));
        // Edge faces for floor slab perimeter.
        const zR = Array.from({length: rd}, (_, i) => rz+i);
        const xR = Array.from({length: rw}, (_, i) => rx+i);
        addSlabEdgeFaces(zR, sx0, 'x',-1, fy0,fy1);
        addSlabEdgeFaces(zR, sx1, 'x',+1, fy0,fy1);
        addSlabEdgeFaces(xR, sz0, 'z',-1, fy0,fy1);
        addSlabEdgeFaces(xR, sz1, 'z',+1, fy0,fy1);
        // Extra edge strips to seal extension overhang (0.1m).
        if (extX) {
          getArr('concrete').push(...slabEdgeFaceVerts(sz1, fy0, fy1, wx+rx+rw, sx1, 'z', +1));
          getArr('concrete').push(...slabEdgeFaceVerts(sz0, fy0, fy1, wx+rx+rw, sx1, 'z', -1));
        }
        if (extZ) {
          getArr('concrete').push(...slabEdgeFaceVerts(sx1, fy0, fy1, wz+rz+rd, sz1, 'x', +1));
          getArr('concrete').push(...slabEdgeFaceVerts(sx0, fy0, fy1, wz+rz+rd, sz1, 'x', -1));
        }
      }
    }

    // ── Ceiling slab (merged rectangles) ──────────────────────────────────
    const isTopFloor = f === floors.length - 1;
    // Top-floor ceiling = roof: routed into a separate mesh for debug toggling.
    const roofVerts = {};
    function getRoofArr(t) { if (!roofVerts[t]) roofVerts[t] = []; return roofVerts[t]; }
    {
      const mask = Array.from({ length: width }, (_, mx) => {
        const row = new Uint8Array(depth);
        for (let z = 0; z < depth; z++) {
          if (!grid[mx][z]) continue;
          if (!isTopFloor && (floors[f + 1]?.cells[mx]?.[z] ?? 0)) continue;
          row[z] = 1;
        }
        return row;
      });
      const ceilY = floorY + heightPerFloor;
      const cy0 = ceilY, cy1 = ceilY + slabThick;
      for (const [rx, rz, rw, rd] of mergeSlabs(mask, width, depth)) {
        const { sx0, sx1, sz0, sz1, extX, extZ } = slabExtents(rx, rz, rw, rd);
        addPanel('concrete',
          sx0, cy0, sz0, sx1, cy1, sz1,
          rx, f*100+99, -1, FACE_PY | FACE_NY,
          isTopFloor ? getRoofArr : getArr);
        // Edge faces for ceiling slab perimeter.
        const zR = Array.from({length: rd}, (_, i) => rz+i);
        const xR = Array.from({length: rw}, (_, i) => rx+i);
        addSlabEdgeFaces(zR, sx0, 'x',-1, cy0,cy1);
        addSlabEdgeFaces(zR, sx1, 'x',+1, cy0,cy1);
        addSlabEdgeFaces(xR, sz0, 'z',-1, cy0,cy1);
        addSlabEdgeFaces(xR, sz1, 'z',+1, cy0,cy1);
        // Extra edge strips to seal extension overhang (0.1m).
        const ceilArr = isTopFloor ? getRoofArr('concrete') : getArr('concrete');
        if (extX) {
          ceilArr.push(...slabEdgeFaceVerts(sz1, cy0, cy1, wx+rx+rw, sx1, 'z', +1));
          ceilArr.push(...slabEdgeFaceVerts(sz0, cy0, cy1, wx+rx+rw, sx1, 'z', -1));
        }
        if (extZ) {
          ceilArr.push(...slabEdgeFaceVerts(sx1, cy0, cy1, wz+rz+rd, sz1, 'x', +1));
          ceilArr.push(...slabEdgeFaceVerts(sx0, cy0, cy1, wz+rz+rd, sz1, 'x', -1));
        }
      }
    }

    // Walls span from top of floor slab to bottom of ceiling slab.
    // Wall base = floorY + slabThick; wall top = floorY + heightPerFloor.
    const wallBaseY = floorY + slabThick;
    const clearH  = heightPerFloor - slabThick;
    const wallRows = Math.ceil(clearH);
    const panelH  = clearH / wallRows;

    // Door/window heights measured from wall base (= floor surface).
    const DOOR_H  = 2.0;
    const WIN_BOT = 0.9, WIN_TOP = 2.1;
    const DOOR_TOP = DOOR_H;
    const WIN_BOT_R = WIN_BOT, WIN_TOP_R = WIN_TOP;

    // Corner extensions: H-walls extend 0.1m at junctions with V-walls.
    const cornerExt = computeCornerExtensions(walls, width, depth);

    // Per-panel wall geometry accumulators (vertex-colored, one mesh per floor).
    const wallPos = [], wallCol = [], wallIds = [];     // opaque
    const glassPos = [], glassCol = [], glassIds = [];  // transparent
    // Deferred panel data — meshRef set after mesh creation.
    const deferredPanels = []; // { panelId, isGlass }

    // ── Horizontal wall panels (h[x][z]) ──────────────────────────────────
    // Per-panel fixed-stride geometry: 12 triangles = 36 vertices per panel.
    // Buffer face order: +Y(6), -Y(6), +Z(6), -Z(6), +X(6), -X(6).
    for (let z = 0; z <= depth; z++) {
      const extMat = buildingDef.style.extWall;
      const intMat = buildingDef.style.intWall;
      const pz0 = wz + z, pz1 = wz + z + slabThick;
      const isStorefrontRow = archetype === 'strip_mall' && z === 0;

      // Collect per-x segment data.
      const xData = [];
      for (let x = 0; x < width; x++) {
        if (!walls.h[x][z]) continue;
        const below = z > 0     ? grid[x][z - 1] : 0;
        const above = z < depth ? grid[x][z]     : 0;
        if (below === 0 && above === 0) continue;
        const hasLeftPerp  = !!(  (z > 0 && walls.v[x]?.[z - 1])     || (z < depth && walls.v[x]?.[z])   );
        const hasRightPerp = !!(  (z > 0 && walls.v[x + 1]?.[z - 1]) || (z < depth && walls.v[x + 1]?.[z]));
        xData[x] = {
          below, above, hasLeftPerp, hasRightPerp,
          isDoor: doors.has(dKey('h', x, z)),
          isWin: windows.has(dKey('h', x, z)),
        };
      }

      // Glass suppression at/adjacent to corners.
      const noCorner = new Uint8Array(width);
      for (let x = 0; x < width; x++) {
        if (!xData[x]) continue;
        const atCorner   = xData[x].hasLeftPerp || xData[x].hasRightPerp;
        const prevCorner = xData[x - 1]?.hasRightPerp;
        const nextCorner = xData[x + 1]?.hasLeftPerp;
        noCorner[x] = (!atCorner && !prevCorner && !nextCorner) ? 1 : 0;
      }

      // Build 2D material grids: gridPZ[x][p] and gridMZ[x][p].
      const gridPZ = Array.from({ length: width }, () => new Array(wallRows).fill(null));
      const gridMZ = Array.from({ length: width }, () => new Array(wallRows).fill(null));
      for (let x = 0; x < width; x++) {
        if (!xData[x]) continue;
        const seg = xData[x];
        for (let p = 0; p < wallRows; p++) {
          const relY = panelH * p + panelH * 0.5;
          if (seg.isDoor && relY < DOOR_TOP) continue;
          const isGlass = noCorner[x] && (
            isStorefrontRow ||
            (seg.isWin && (archetype === 'office' || (relY >= WIN_BOT_R && relY <= WIN_TOP_R)))
          );
          gridPZ[x][p] = isGlass ? 'glass' : ((seg.above === 0) ? extMat : intMat);
          gridMZ[x][p] = isGlass ? 'glass' : ((seg.below === 0) ? extMat : intMat);
        }
      }

      // Per-panel geometry emission (replaces greedy merge).
      for (let x = 0; x < width; x++) {
        if (!xData[x]) continue;
        for (let p = 0; p < wallRows; p++) {
          const matPZ = gridPZ[x][p], matMZ = gridMZ[x][p];
          if (!matPZ && !matMZ) continue;
          if (panelCount >= MAX_PANELS) break;

          const rMat = matPZ || matMZ;
          const isGlassPanel = rMat === 'glass';
          const posArr = isGlassPanel ? glassPos : wallPos;
          const colArr = isGlassPanel ? glassCol : wallCol;
          const idArr  = isGlassPanel ? glassIds : wallIds;

          // Panel bounds
          let px0 = wx + x, px1 = wx + x + 1;
          const py0 = wallBaseY + panelH * p;
          const py1 = wallBaseY + panelH * (p + 1);

          // Corner extension: extend +X when V-wall meets at right edge
          const ext = cornerExt.get(`${x},${z}`);
          if (ext?.extPosX) px1 += slabThick;

          // Emit 36 verts (fixed stride) — suppress endcap faces at wall junctions
          const vertexStart = posArr.length / 3;
          let hMask = FACE_PY | FACE_NY | FACE_PZ | FACE_NZ | FACE_PX | FACE_NX;
          if (xData[x - 1] || xData[x].hasLeftPerp)  hMask &= ~FACE_NX;
          if (xData[x + 1] || xData[x].hasRightPerp) hMask &= ~FACE_PX;
          emitPanelFaces(posArr, px0, py0, pz0, px1, py1, pz1, hMask);

          // Per-face vertex colors: edge, edge, front(+Z), back(-Z), edge, edge
          const edgeRGB  = panelColorRGB(rMat);
          const frontRGB = panelColorRGB(matPZ || rMat);
          const backRGB  = panelColorRGB(matMZ || rMat);
          pushFaceColor(colArr, ...edgeRGB);   // +Y
          pushFaceColor(colArr, ...edgeRGB);   // -Y
          pushFaceColor(colArr, ...frontRGB);  // +Z (front)
          pushFaceColor(colArr, ...backRGB);   // -Z (back)
          pushFaceColor(colArr, ...edgeRGB);   // +X
          pushFaceColor(colArr, ...edgeRGB);   // -X

          const panelId = _panelId++;
          const def = PANEL_TYPES[rMat] ?? PANEL_TYPES.concrete;
          idArr.push(panelId);
          const suppressedFaces = ~hMask & (FACE_PX | FACE_NX);
          registerPanel({
            id: panelId, type: rMat, hp: def.hp, maxHp: def.hp,
            gridX: x, gridY: f * 10 + p, wallId: z * 10000 + x, buildingId,
            vertexStart, vertexCount: 36, penetrationCost: def.pen, isSupported: true,
            meshRef: null, frontMat: matPZ || rMat, backMat: matMZ || rMat, isVWall: false,
            bounds: [px0, py0, pz0, px1, py1, pz1], suppressedFaces,
          });
          deferredPanels.push({ panelId, isGlass: isGlassPanel });
          panelCount++;
        }
      }
    }

    // ── Vertical wall panels (v[x][z]) ────────────────────────────────────
    // Per-panel fixed-stride geometry. Face order: +Y(6), -Y(6), +X(6), -X(6), +Z(6), -Z(6).
    for (let x = 0; x <= width; x++) {
      const extMat = buildingDef.style.extWall;
      const intMat = buildingDef.style.intWall;
      const vx0 = wx + x, vx1 = wx + x + slabThick;

      const zData = [];
      for (let z = 0; z < depth; z++) {
        if (!walls.v[x][z]) continue;
        const left  = x > 0     ? grid[x - 1][z] : 0;
        const right = x < width ? grid[x][z]     : 0;
        if (left === 0 && right === 0) continue;
        const hasBotPerp = !!(  (x > 0 && walls.h[x - 1]?.[z])     || (x < width && walls.h[x]?.[z])   );
        const hasTopPerp = !!(  (x > 0 && walls.h[x - 1]?.[z + 1]) || (x < width && walls.h[x]?.[z + 1]));
        zData[z] = {
          left, right, hasBotPerp, hasTopPerp,
          isDoor: doors.has(dKey('v', x, z)),
          isWin: windows.has(dKey('v', x, z)),
        };
      }

      const noCorner = new Uint8Array(depth);
      for (let z = 0; z < depth; z++) {
        if (!zData[z]) continue;
        const atCorner   = zData[z].hasBotPerp || zData[z].hasTopPerp;
        const prevCorner = zData[z - 1]?.hasTopPerp;
        const nextCorner = zData[z + 1]?.hasBotPerp;
        noCorner[z] = (!atCorner && !prevCorner && !nextCorner) ? 1 : 0;
      }

      const gridPX = Array.from({ length: depth }, () => new Array(wallRows).fill(null));
      const gridMX = Array.from({ length: depth }, () => new Array(wallRows).fill(null));
      for (let z = 0; z < depth; z++) {
        if (!zData[z]) continue;
        const seg = zData[z];
        for (let p = 0; p < wallRows; p++) {
          const relY = panelH * p + panelH * 0.5;
          if (seg.isDoor && relY < DOOR_TOP) continue;
          const isGlass = noCorner[z] && seg.isWin &&
                          (archetype === 'office' || (relY >= WIN_BOT_R && relY <= WIN_TOP_R));
          gridPX[z][p] = isGlass ? 'glass' : ((seg.right === 0) ? extMat : intMat);
          gridMX[z][p] = isGlass ? 'glass' : ((seg.left  === 0) ? extMat : intMat);
        }
      }

      // Per-panel geometry emission.
      for (let z = 0; z < depth; z++) {
        if (!zData[z]) continue;
        for (let p = 0; p < wallRows; p++) {
          const matPX = gridPX[z][p], matMX = gridMX[z][p];
          if (!matPX && !matMX) continue;
          if (panelCount >= MAX_PANELS) break;

          const rMat = matPX || matMX;
          const isGlassPanel = rMat === 'glass';
          const posArr = isGlassPanel ? glassPos : wallPos;
          const colArr = isGlassPanel ? glassCol : wallCol;
          const idArr  = isGlassPanel ? glassIds : wallIds;

          // Panel bounds
          let sz0 = wz + z, sz1 = wz + z + 1;
          const py0 = wallBaseY + panelH * p;
          const py1 = wallBaseY + panelH * (p + 1);

          // Corner extension: extend +Z when H-wall meets at top edge
          if (zData[z]?.hasTopPerp) sz1 += slabThick;

          // Emit 36 verts (fixed stride) — suppress endcap faces at wall junctions
          const vertexStart = posArr.length / 3;
          let vMask = FACE_PY | FACE_NY | FACE_PZ | FACE_NZ | FACE_PX | FACE_NX;
          if (zData[z - 1] || zData[z].hasBotPerp) vMask &= ~FACE_NZ;
          if (zData[z + 1] || zData[z].hasTopPerp) vMask &= ~FACE_PZ;
          emitPanelFaces(posArr, vx0, py0, sz0, vx1, py1, sz1, vMask);

          // Per-face vertex colors.
          // slabFaceVerts order: +Y, -Y, +Z, -Z, +X, -X
          // For V-walls: +X is front (toward right cell), -X is back (toward left cell)
          const edgeRGB  = panelColorRGB(rMat);
          const frontRGB = panelColorRGB(matPX || rMat); // +X face
          const backRGB  = panelColorRGB(matMX || rMat); // -X face
          pushFaceColor(colArr, ...edgeRGB);   // +Y
          pushFaceColor(colArr, ...edgeRGB);   // -Y
          pushFaceColor(colArr, ...edgeRGB);   // +Z (end edge)
          pushFaceColor(colArr, ...edgeRGB);   // -Z (end edge)
          pushFaceColor(colArr, ...frontRGB);  // +X (front)
          pushFaceColor(colArr, ...backRGB);   // -X (back)

          const panelId = _panelId++;
          const def = PANEL_TYPES[rMat] ?? PANEL_TYPES.concrete;
          idArr.push(panelId);
          const suppressedFaces = ~vMask & (FACE_PZ | FACE_NZ);
          registerPanel({
            id: panelId, type: rMat, hp: def.hp, maxHp: def.hp,
            gridX: x, gridY: f * 10 + p, wallId: x * 10000 + z, buildingId,
            vertexStart, vertexCount: 36, penetrationCost: def.pen, isSupported: true,
            meshRef: null, frontMat: matPX || rMat, backMat: matMX || rMat, isVWall: true,
            bounds: [vx0, py0, sz0, vx1, py1, sz1], suppressedFaces,
          });
          deferredPanels.push({ panelId, isGlass: isGlassPanel });
          panelCount++;
        }
      }
    }

    // ── Props (disabled — causes AI pathing issues) ───────────────────────
    // for (const { x, z, type } of fp.props ?? []) {
    //   const def = PROP_DEFS[type];
    //   if (!def) continue;
    //   const pcx = wx + x + def.w * 0.5 + 0.05;
    //   const pcy = floorY + slabThick + def.h * 0.5;
    //   const pcz = wz + z + def.d * 0.5 + 0.05;
    //   getArr(def.mat).push(...solidBoxVerts(pcx, pcy, pcz, def.w, def.h, def.d));
    //   registerProp({ id: _panelId++, type, hp: def.hp, maxHp: def.hp, buildingId });
    // }

    // ── Build slab/prop meshes for this floor (non-wall geometry) ─────────
    for (const [typeName, arr] of Object.entries(verts)) {
      if (arr.length === 0) continue;
      const mesh = buildMesh(arr, getPanelMat(typeName));
      if (mesh) group.add(mesh);
    }

    // ── Build per-panel wall meshes for this floor ────────────────────────
    const opaqueWallMesh = buildWallMesh(wallPos, wallCol, wallIds, buildingId, false);
    if (opaqueWallMesh) {
      group.add(opaqueWallMesh);
      const wallKey = `f${f}:opaque`;
      registerWallMesh(buildingId, wallKey, opaqueWallMesh);
      // Set meshRef on all opaque panels for this floor
      for (const dp of deferredPanels) {
        if (!dp.isGlass) {
          const p = panels.get(dp.panelId);
          if (p) p.meshRef = opaqueWallMesh;
        }
      }
    }
    const glassWallMesh = buildWallMesh(glassPos, glassCol, glassIds, buildingId, true);
    if (glassWallMesh) {
      group.add(glassWallMesh);
      const wallKey = `f${f}:glass`;
      registerWallMesh(buildingId, wallKey, glassWallMesh);
      for (const dp of deferredPanels) {
        if (dp.isGlass) {
          const p = panels.get(dp.panelId);
          if (p) p.meshRef = glassWallMesh;
        }
      }
    }

    // ── Roof mesh (top floor ceiling only, separate for debug toggling) ────
    if (isTopFloor) {
      for (const [typeName, arr] of Object.entries(roofVerts)) {
        if (arr.length === 0) continue;
        const mesh = buildMesh(arr, getPanelMat(typeName));
        if (mesh) {
          mesh.userData.isRoof = true;
          group.add(mesh);
          _roofMeshes.push(mesh);
        }
      }
    }
  }

  // ── Stair geometry ────────────────────────────────────────────────────
  for (const sw of buildingDef.stairwells ?? []) {
    for (let f = 0; f < floors.length - 1; f++) {
      const floorY = wy + f * heightPerFloor;
      const verts  = buildStairVerts(wx + sw.x, wz + sw.z, floorY + 0.1, heightPerFloor, sw.axis);
      const mesh   = buildMesh(verts, getPanelMat('wood'));
      if (mesh) group.add(mesh);
      // Register each step as a prop
      const STEPS = 10;
      for (let i = 0; i < STEPS; i++) {
        registerProp({ id: _panelId++, type: 'stair_step', hp: 3, maxHp: 3, buildingId });
      }
    }
  }

  // ── Roof-access ladder (all buildings) ──────────────────────────────
  {
    const totalHeight = floors.length * heightPerFloor;
    const groundFP = floors[0];
    const cellIdx = pickLadderCell(groundFP, 'n', buildingDef.footprintW, buildingDef.footprintD);
    const ladderResult = buildLadderMesh(wx, wy, wz, buildingDef.footprintW, buildingDef.footprintD, 'n', totalHeight, cellIdx);
    if (ladderResult.mesh) {
      group.add(ladderResult.mesh);
      const ladId = _panelId++;
      registerProp({ id: ladId, type: 'ladder', hp: 3, maxHp: 3, buildingId });
      registerLadder(ladId, buildingId, ladderResult);
    }
  }

  // ── Apartment fire-escape ladder (east wall) ──────────────────────────
  if (archetype === 'apartment') {
    const totalHeight = floors.length * heightPerFloor;
    const groundFP = floors[0];
    const cellIdx = pickLadderCell(groundFP, 'e', buildingDef.footprintW, buildingDef.footprintD);
    const ladderResult = buildLadderMesh(wx, wy, wz, buildingDef.footprintW, buildingDef.footprintD, 'e', totalHeight, cellIdx);
    if (ladderResult.mesh) {
      group.add(ladderResult.mesh);
      const ladId = _panelId++;
      registerProp({ id: ladId, type: 'ladder', hp: 3, maxHp: 3, buildingId });
      registerLadder(ladId, buildingId, ladderResult);
    }
  }

  // ── Warehouse catwalk ─────────────────────────────────────────────────
  if (archetype === 'warehouse') {
    addWarehouseCatwalk(group, buildingDef, wx, wy, wz, buildingId);
  }

  // ── Generate collision data and register with CollisionWorld ──────────────
  const collisionData = generateCollisionData(buildingDef, buildingId);
  collisionWorld.addBuilding(buildingId, {
    worldX: wx, worldY: wy, worldZ: wz,
    footprintW: buildingDef.footprintW,
    footprintD: buildingDef.footprintD,
    totalH: floors.length * heightPerFloor,
    ...collisionData,
  });

  group.userData.buildingId = buildingId;
  registerBuildingGroup(buildingId, group);
  return group;
}

// ─── Collision data generation ────────────────────────────────────────────────

function generateCollisionData(buildingDef, buildingId) {
  const { floors, heightPerFloor, footprintW, footprintD } = buildingDef;
  const slabThick = 0.1;
  const wallColliders = [];
  const floorColliders = [];
  const propColliders = [];
  const stairColliders = [];

  for (let f = 0; f < floors.length; f++) {
    const fp = floors[f];
    const { cells: grid, walls, doors, width, depth } = fp;
    const wallBaseY = f * heightPerFloor + slabThick;
    const clearH = heightPerFloor - slabThick;
    const wallRows = Math.ceil(clearH);
    const panelH = clearH / wallRows;
    const DOOR_H = 2.0;

    // ── Floor collider (with void grid) ───────────────────────────────────
    const voidGrid = new Uint8Array(width * depth);
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < depth; z++) {
        // 0 = exterior, 3 = stairwell void → mark as void (1)
        if (grid[x][z] === 0 || grid[x][z] === 3) voidGrid[x * depth + z] = 1;
      }
    }
    floorColliders.push({
      aabb: { minX: 0, maxX: footprintW, minY: f * heightPerFloor, maxY: f * heightPerFloor + slabThick, minZ: 0, maxZ: footprintD },
      floor: f, voidGrid, width, depth,
    });

    // Ceiling collider (for head collision)
    floorColliders.push({
      aabb: { minX: 0, maxX: footprintW, minY: (f + 1) * heightPerFloor - slabThick, maxY: (f + 1) * heightPerFloor, minZ: 0, maxZ: footprintD },
      floor: f, voidGrid, width, depth,
    });

    // ── H-wall colliders ──────────────────────────────────────────────────
    for (let z = 0; z <= depth; z++) {
      // Find contiguous wall runs along x, breaking at doors
      let runStart = -1;
      for (let x = 0; x <= width; x++) {
        const hasWall = x < width && walls.h[x]?.[z];
        // Check if both sides are exterior (skip these walls)
        const above = z < depth ? grid[x]?.[z] : 0;
        const below = z > 0 ? grid[x]?.[z - 1] : 0;
        const isRelevant = hasWall && (above !== 0 || below !== 0);

        if (isRelevant) {
          if (runStart < 0) runStart = x;
        } else {
          if (runStart >= 0) {
            emitHWallCollider(wallColliders, runStart, x, z, f, wallBaseY, clearH, wallRows, panelH, DOOR_H, doors, buildingId);
            runStart = -1;
          }
        }
      }
    }

    // ── V-wall colliders ──────────────────────────────────────────────────
    for (let x = 0; x <= width; x++) {
      let runStart = -1;
      for (let z = 0; z <= depth; z++) {
        const hasWall = z < depth && walls.v[x]?.[z];
        const left = x > 0 ? grid[x - 1]?.[z] : 0;
        const right = x < width ? grid[x]?.[z] : 0;
        const isRelevant = hasWall && (left !== 0 || right !== 0);

        if (isRelevant) {
          if (runStart < 0) runStart = z;
        } else {
          if (runStart >= 0) {
            emitVWallCollider(wallColliders, x, runStart, z, f, wallBaseY, clearH, wallRows, panelH, DOOR_H, doors, buildingId);
            runStart = -1;
          }
        }
      }
    }

    // ── Prop colliders (disabled — props disabled for pathing) ─────────────
    // for (const { x, z, type } of fp.props ?? []) {
    //   const def = PROP_DEFS[type];
    //   if (!def) continue;
    //   propColliders.push({
    //     minX: x + 0.05, maxX: x + def.w + 0.05,
    //     minY: f * heightPerFloor + slabThick, maxY: f * heightPerFloor + slabThick + def.h,
    //     minZ: z + 0.05, maxZ: z + def.d + 0.05,
    //   });
    // }
  }

  // ── Stair colliders ───────────────────────────────────────────────────────
  for (const sw of buildingDef.stairwells ?? []) {
    for (let f = 0; f < floors.length - 1; f++) {
      const baseY = f * heightPerFloor + slabThick;
      const STEPS = 10;
      const stepH = heightPerFloor / STEPS;
      const stepRun = 2 / STEPS; // 0.2m per step
      for (let i = 0; i < STEPS; i++) {
        const y = baseY + i * stepH;
        const off = i * stepRun;
        if (sw.axis === 'x') {
          stairColliders.push({
            minX: sw.x + off, maxX: sw.x + off + stepRun,
            minY: y, maxY: y + stepH,
            minZ: sw.z, maxZ: sw.z + 1.0,
          });
        } else {
          stairColliders.push({
            minX: sw.x, maxX: sw.x + 1.0,
            minY: y, maxY: y + stepH,
            minZ: sw.z + off, maxZ: sw.z + off + stepRun,
          });
        }
      }
    }
  }

  return { wallColliders, floorColliders, propColliders, stairColliders };
}

function emitHWallCollider(out, x0, x1, z, f, wallBaseY, clearH, wallRows, panelH, doorH, doors, buildingId) {
  // H-wall at row z runs from x0 to x1 (exclusive)
  // Break into sub-runs at door positions
  let segStart = x0;
  for (let x = x0; x <= x1; x++) {
    const isDoor = x < x1 && doors.has(dKey('h', x, z));
    if (isDoor || x === x1) {
      if (x > segStart) {
        const panelsWide = x - segStart;
        const mask = new Uint8Array(panelsWide * wallRows).fill(1);
        const wallKey = 'h:' + z + ':' + segStart + '-' + x;
        out.push({
          aabb: { minX: segStart, maxX: x, minY: wallBaseY, maxY: wallBaseY + clearH, minZ: z, maxZ: z + 0.1 },
          axis: 'h', mask, gridStart: segStart, gridY0: f * wallRows,
          panelsWide, panelsHigh: wallRows, wallKey, panelRowOffset: 0, floor: f,
        });
      }
      if (isDoor) {
        // Door: emit lintel-only collider (panels above door height)
        const doorPanels = Math.floor(doorH / panelH);
        const lintelPanels = wallRows - doorPanels;
        if (lintelPanels > 0) {
          const mask = new Uint8Array(1 * lintelPanels).fill(1);
          const wallKey = 'h:' + z + ':' + x + '-' + (x + 1) + ':lintel';
          out.push({
            aabb: { minX: x, maxX: x + 1, minY: wallBaseY + doorPanels * panelH, maxY: wallBaseY + clearH, minZ: z, maxZ: z + 0.1 },
            axis: 'h', mask, gridStart: x, gridY0: f * wallRows + doorPanels,
            panelsWide: 1, panelsHigh: lintelPanels, wallKey, panelRowOffset: doorPanels, floor: f,
          });
        }
        segStart = x + 1;
      } else {
        segStart = x;
      }
    }
  }
}

function emitVWallCollider(out, x, z0, z1, f, wallBaseY, clearH, wallRows, panelH, doorH, doors, buildingId) {
  let segStart = z0;
  for (let z = z0; z <= z1; z++) {
    const isDoor = z < z1 && doors.has(dKey('v', x, z));
    if (isDoor || z === z1) {
      if (z > segStart) {
        const panelsWide = z - segStart;
        const mask = new Uint8Array(panelsWide * wallRows).fill(1);
        const wallKey = 'v:' + x + ':' + segStart + '-' + z;
        out.push({
          aabb: { minX: x, maxX: x + 0.1, minY: wallBaseY, maxY: wallBaseY + clearH, minZ: segStart, maxZ: z },
          axis: 'v', mask, gridStart: segStart, gridY0: f * wallRows,
          panelsWide, panelsHigh: wallRows, wallKey, panelRowOffset: 0, floor: f,
        });
      }
      if (isDoor) {
        const doorPanels = Math.floor(doorH / panelH);
        const lintelPanels = wallRows - doorPanels;
        if (lintelPanels > 0) {
          const mask = new Uint8Array(1 * lintelPanels).fill(1);
          const wallKey = 'v:' + x + ':' + z + '-' + (z + 1) + ':lintel';
          out.push({
            aabb: { minX: x, maxX: x + 0.1, minY: wallBaseY + doorPanels * panelH, maxY: wallBaseY + clearH, minZ: z, maxZ: z + 1 },
            axis: 'v', mask, gridStart: z, gridY0: f * wallRows + doorPanels,
            panelsWide: 1, panelsHigh: lintelPanels, wallKey, panelRowOffset: doorPanels, floor: f,
          });
        }
        segStart = z + 1;
      } else {
        segStart = z;
      }
    }
  }
}

// rebuildMergedSlab is no longer needed — per-panel geometry uses vertex
// zeroing for destruction instead of re-merging.

// ─── Entry points ─────────────────────────────────────────────────────────────

export function generateBuilding(archetype, rng, styleOverrides = {}, maxW = 999, maxD = 999) {
  const cfg = ARCHETYPE_CFG[archetype];

  // Step 2: footprint
  const { grid, width, depth } = generateFootprint(archetype, rng, maxW, maxD);

  // Initialise outer walls from footprint
  const rawWalls = initWalls(grid, width, depth);

  // Determine floor count
  const numFloors = cfg.minFloors + Math.floor(rng() * (cfg.maxFloors - cfg.minFloors + 1));
  const style     = Object.assign({}, cfg.style, styleOverrides);

  // Generate one floorplan (shared layout for all floors for MVP)
  function makeFloor(floorIdx) {
    const fp = makeFloorPlan(width, depth);
    // Copy cells from footprint
    for (let x = 0; x < width; x++)
      for (let z = 0; z < depth; z++)
        fp.cells[x][z] = grid[x][z];

    // Copy outer walls; BSP will add interior walls
    for (let x = 0; x < width; x++)
      for (let z = 0; z <= depth; z++)
        fp.walls.h[x][z] = rawWalls.h[x][z];
    for (let x = 0; x <= width; x++)
      for (let z = 0; z < depth; z++)
        fp.walls.v[x][z] = rawWalls.v[x][z];

    // Step 3: room partitioning (interior walls + room list)
    // Office lobby: ground floor of tall office buildings stays open (no BSP)
    const isLobby = archetype === 'office' && floorIdx === 0 && numFloors >= 4;
    let rooms;
    if (isLobby) {
      rooms = [{ x0: 0, z0: 0, x1: width, z1: depth, tag: 'lobby' }];
    } else {
      rooms = partitionRooms(fp.cells, fp.walls, width, depth, archetype, rng);
    }

    // Step 4: doors
    placeDoors(fp, rooms, rng, floorIdx === 0);

    // Step 5: windows
    placeWindows(fp, archetype, style.windowDensity, floorIdx, rng);

    // Step 6 (part of step 8): props
    if (!isLobby) placeProps(fp, rooms, rng);

    return { fp, rooms };
  }

  const floors = [];
  for (let f = 0; f < numFloors; f++) floors.push(makeFloor(f).fp);

  const buildingDef = {
    archetype,
    style,
    floors,
    heightPerFloor: cfg.floorH,
    footprintW: width,
    footprintD: depth,
    stairwells: [],
  };

  // Step 7: stairwells (multi-floor buildings only)
  addStairwells(buildingDef);

  return buildingDef;
}

export function spawnBuilding(buildingDef, wx, wy, wz) {
  return instantiateBuilding(buildingDef, wx, wy, wz);
}
