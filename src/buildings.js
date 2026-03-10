// ─── buildings.js ────────────────────────────────────────────────────────────
// Procedural building generation — steps 1–6 of building-generation-spec.md
// Pipeline: Footprint → Rooms (BSP) → Doors → Windows → Panel Instantiation
import * as THREE from 'three';
import { registerPanel, registerProp } from './destruction.js';

// ─── §4 Panel types ──────────────────────────────────────────────────────────
export const PANEL_TYPES = {
  concrete:  { hp: 5, pen: 1.0, color: 0x6b6b6b },
  brick:     { hp: 3, pen: 0.8, color: 0x8b4513 },
  wood:      { hp: 2, pen: 0.5, color: 0xc4a86b },
  glass:     { hp: 1, pen: 0.1, color: 0xaad4e6, opacity: 0.3 },
  metal:     { hp: 4, pen: 0.9, color: 0x4a4a4a },
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
    minRoom: 2,
    shape: 'rect_or_l',      // 60% L-shape
    style: { extWall: 'brick', intWall: 'wood', floorMat: 'wood', windowDensity: 0.5 },
  },
  apartment: {
    minW: 10, maxW: 15, minD: 15, maxD: 25,
    minFloors: 3, maxFloors: 6, floorH: 3,
    minRoom: 2,
    shape: 'rect_or_u',     // 50% U-shape
    hasCorridor: true,
    style: { extWall: 'concrete', intWall: 'wood', floorMat: 'concrete', windowDensity: 0.6 },
  },
  office: {
    minW: 12, maxW: 20, minD: 12, maxD: 20,
    minFloors: 3, maxFloors: 8, floorH: 3,
    minRoom: 3,
    shape: 'rect_or_t',     // 50% T-shape
    hasCorridor: true,
    style: { extWall: 'concrete', intWall: 'wood', floorMat: 'concrete', windowDensity: 0.82 },
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

// ─── Geometry helpers ─────────────────────────────────────────────────────────

// Slab: ±Y faces only. Side faces omitted — they're always hidden by wall panels
// and would z-fight at seams between adjacent merged rectangles.
function slabVerts(cx, cy, cz, w, h, d) {
  const hx=w*0.5, hy=h*0.5, hz=d*0.5;
  const x0=cx-hx, x1=cx+hx, y0=cy-hy, y1=cy+hy, z0=cz-hz, z1=cz+hz;
  return [
    x0,y1,z0, x0,y1,z1, x1,y1,z1,  x0,y1,z0, x1,y1,z1, x1,y1,z0, // +Y
    x0,y0,z1, x0,y0,z0, x1,y0,z0,  x0,y0,z1, x1,y0,z0, x1,y0,z1, // -Y
  ];
}

// Ground-floor slab: +Y face only (no -Y to avoid Z-fight with terrain, no sides)
function topSlabVerts(cx, cy, cz, w, h, d) {
  const hx=w*0.5, hy=h*0.5, hz=d*0.5;
  const x0=cx-hx, x1=cx+hx, y1=cy+hy, z0=cz-hz, z1=cz+hz;
  return [
    x0,y1,z0, x0,y1,z1, x1,y1,z1,  x0,y1,z0, x1,y1,z1, x1,y1,z0, // +Y
  ];
}

// Single-face helpers for per-side material assignment on wall panels
function hFacePZ(cx, cy, cz, w, h, d) { // h-wall face toward +Z (faces 'above' cell)
  const hx=w*0.5, hy=h*0.5, hz=d*0.5;
  const x0=cx-hx, x1=cx+hx, y0=cy-hy, y1=cy+hy, z1=cz+hz;
  return [x0,y0,z1, x1,y0,z1, x1,y1,z1,  x0,y0,z1, x1,y1,z1, x0,y1,z1];
}
function hFaceMZ(cx, cy, cz, w, h, d) { // h-wall face toward -Z (faces 'below' cell)
  const hx=w*0.5, hy=h*0.5, hz=d*0.5;
  const x0=cx-hx, x1=cx+hx, y0=cy-hy, y1=cy+hy, z0=cz-hz;
  return [x1,y0,z0, x0,y0,z0, x0,y1,z0,  x1,y0,z0, x0,y1,z0, x1,y1,z0];
}
function vFacePX(cx, cy, cz, w, h, d) { // v-wall face toward +X (faces 'right' cell)
  const hx=w*0.5, hy=h*0.5, hz=d*0.5;
  const x1=cx+hx, y0=cy-hy, y1=cy+hy, z0=cz-hz, z1=cz+hz;
  return [x1,y0,z0, x1,y1,z0, x1,y1,z1,  x1,y0,z0, x1,y1,z1, x1,y0,z1];
}
function vFaceMX(cx, cy, cz, w, h, d) { // v-wall face toward -X (faces 'left' cell)
  const hx=w*0.5, hy=h*0.5, hz=d*0.5;
  const x0=cx-hx, y0=cy-hy, y1=cy+hy, z0=cz-hz, z1=cz+hz;
  return [x0,y0,z1, x0,y1,z1, x0,y1,z0,  x0,y0,z1, x0,y1,z0, x0,y0,z0];
}

// 4 edge faces for a horizontal-wall panel (thickness in Z = 0.1m, width in X = 1m).
// cx,cy,cz = panel center. Returns 24 verts (4 faces × 6 verts).
function hPanelEdges(cx, cy, cz, panelH) {
  const hx=0.5, hy=panelH*0.5, hz=0.05;
  const x0=cx-hx, x1=cx+hx, y0=cy-hy, y1=cy+hy, z0=cz-hz, z1=cz+hz;
  return [
    x0,y0,z0, x0,y0,z1, x0,y1,z1,  x0,y0,z0, x0,y1,z1, x0,y1,z0, // left  (-X)
    x1,y0,z1, x1,y0,z0, x1,y1,z0,  x1,y0,z1, x1,y1,z0, x1,y1,z1, // right (+X)
    x0,y1,z0, x0,y1,z1, x1,y1,z1,  x0,y1,z0, x1,y1,z1, x1,y1,z0, // top   (+Y)
    x0,y0,z1, x0,y0,z0, x1,y0,z0,  x0,y0,z1, x1,y0,z0, x1,y0,z1, // bot   (-Y)
  ];
}

// 4 edge faces for a vertical-wall panel (thickness in X = 0.1m, depth in Z = 1m).
// cx,cy,cz = panel center. Returns 24 verts.
function vPanelEdges(cx, cy, cz, panelH) {
  const hx=0.05, hy=panelH*0.5, hz=0.5;
  const x0=cx-hx, x1=cx+hx, y0=cy-hy, y1=cy+hy, z0=cz-hz, z1=cz+hz;
  return [
    x1,y0,z0, x0,y0,z0, x0,y1,z0,  x1,y0,z0, x0,y1,z0, x1,y1,z0, // front (-Z)
    x0,y0,z1, x1,y0,z1, x1,y1,z1,  x0,y0,z1, x1,y1,z1, x0,y1,z1, // back  (+Z)
    x0,y1,z0, x1,y1,z0, x1,y1,z1,  x0,y1,z0, x1,y1,z1, x0,y1,z1, // top   (+Y)
    x0,y0,z1, x1,y0,z1, x1,y0,z0,  x0,y0,z1, x1,y0,z0, x0,y0,z0, // bot   (-Y)
  ];
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

  function addDoor(seg) {
    const k = dKey(seg.axis, seg.x, seg.z);
    doors.add(k);
    if (seg.axis === 'h') walls.h[seg.x][seg.z] = 0;
    else                  walls.v[seg.x][seg.z]  = 0;
  }

  // One door per MST edge
  for (const edge of mstEdges) {
    const seg = edge.segs[Math.floor(rng() * edge.segs.length)];
    addDoor(seg);
  }

  // 30% extra doors per non-MST edge (creates loops)
  for (const edge of shuffled) {
    if (!mstEdges.has(edge) && rng() < 0.3) {
      const seg = edge.segs[Math.floor(rng() * edge.segs.length)];
      const k = dKey(seg.axis, seg.x, seg.z);
      if (!doors.has(k)) addDoor(seg);
    }
  }

  // Exterior door on ground floor: pick a random south-wall segment
  if (isGround) {
    const southSegs = [];
    for (let x = 0; x < width; x++)
      if (walls.h[x]?.[0]) southSegs.push({ axis: 'h', x, z: 0 });
    // Fallback: west wall
    if (southSegs.length === 0)
      for (let z = 0; z < depth; z++)
        if (walls.v[0]?.[z]) southSegs.push({ axis: 'v', x: 0, z });
    if (southSegs.length > 0)
      addDoor(southSegs[Math.floor(rng() * southSegs.length)]);
  }
}

// ─── §2.4 Window placement ────────────────────────────────────────────────────

function placeWindows(floorplan, archetype, windowDensity, floorIdx, rng) {
  const { cells: grid, walls, doors, windows, width, depth } = floorplan;

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
      // Archetype rules
      if (archetype === 'warehouse' && floorIdx === 0) continue;
      let density = windowDensity;
      if (archetype === 'strip_mall') density = (z === 0 || z === depth) ? 0.85 : 0.08;
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

// Find a 2×1 interior region that could host a stairwell.
// Returns {x, z, axis:'x'|'z'} where axis='x' means 2 cells along x, axis='z' means 2 cells along z.
function findStairPosition(fp, width, depth) {
  const { cells: grid } = fp;

  // Try axis-x first (2 cells in x direction)
  for (let x = 0; x < width - 1; x++) {
    for (let z = 1; z < depth - 1; z++) {
      if (grid[x][z] >= 1 && grid[x][z] !== 3 &&
          grid[x + 1][z] >= 1 && grid[x + 1][z] !== 3) {
        return { x, z, axis: 'x' };
      }
    }
  }
  // Try axis-z (2 cells in z direction)
  for (let x = 1; x < width - 1; x++) {
    for (let z = 0; z < depth - 1; z++) {
      if (grid[x][z] >= 1 && grid[x][z] !== 3 &&
          grid[x][z + 1] >= 1 && grid[x][z + 1] !== 3) {
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
    verts.push(...slabVerts(cx, y + stepH * 0.5, cz, w, stepH, d));
  }
  return verts;
}

// ─── §7.2 Ladder geometry ────────────────────────────────────────────────────

// Build ladder geometry attached to a wall face.
// wx, wz = world-space corner of the building face; x, z = cell position on that face
// totalHeight = height in metres; face = 'n'|'s'|'e'|'w' (which building wall)
function buildLadderMesh(wx, wy, wz, bw, bd, face, totalHeight) {
  const verts = [];
  const RUNG_SPACING = 0.3;
  const RUNG_W = 0.4;
  const RUNG_H = 0.06;
  const RUNG_D = 0.06;
  const RAIL_W = 0.04;
  const OFFSET = 0.08; // how far from wall face

  let cx, cz, railDim; // centre of ladder
  if (face === 'n') { cx = wx + bw * 0.5; cz = wz - OFFSET; railDim = 'x'; }
  else if (face === 's') { cx = wx + bw * 0.5; cz = wz + bd + OFFSET; railDim = 'x'; }
  else if (face === 'e') { cx = wx + bw + OFFSET; cz = wz + bd * 0.5; railDim = 'z'; }
  else { cx = wx - OFFSET; cz = wz + bd * 0.5; railDim = 'z'; } // west

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

  return buildMesh(verts, getPanelMat('metal'));
}

// ─── §9 Archetype-specific features ─────────────────────────────────────────

// Warehouse catwalk: elevated walkway at mid-height with metal columns + ladder.
function addWarehouseCatwalk(group, buildingDef, wx, wy, wz) {
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
  const ladderMesh = buildLadderMesh(wx, wy, wz, bw, bd, 'n', hpf * 0.5);
  if (ladderMesh) group.add(ladderMesh);
}

// ─── §3 Panel instantiation ───────────────────────────────────────────────────

let _buildingId = 0;
let _panelId    = 0;

// Returns 0.05m extension amounts for an h-wall segment at (x, z).
// leftExt: extend left face (−X) if a perpendicular v-wall meets the left endpoint.
// rightExt: extend right face (+X) if a perpendicular v-wall meets the right endpoint.
function hWallExtensions(walls, x, z, width, depth) {
  const v = walls.v;
  const leftPerp  = (z > 0 && v[x]?.[z - 1]) || (z < depth && v[x]?.[z]);
  const rightPerp = (z > 0 && v[x + 1]?.[z - 1]) || (z < depth && v[x + 1]?.[z]);
  return { leftExt: leftPerp ? 0.05 : 0, rightExt: rightPerp ? 0.05 : 0 };
}

// Returns 0.05m extension amounts for a v-wall segment at (x, z).
// botExt: extend bottom face (−Z) if a perpendicular h-wall meets the bottom endpoint.
// topExt: extend top face (+Z) if a perpendicular h-wall meets the top endpoint.
function vWallExtensions(walls, x, z, width, depth) {
  const h = walls.h;
  const botPerp = (x > 0 && h[x - 1]?.[z]) || (x < width && h[x]?.[z]);
  const topPerp = (x > 0 && h[x - 1]?.[z + 1]) || (x < width && h[x]?.[z + 1]);
  return { botExt: botPerp ? 0.05 : 0, topExt: topPerp ? 0.05 : 0 };
}

const MAX_PANELS = 5000;

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

    // Slab panels (floor / ceiling)
    function addPanel(typeName, cx, cy, cz, pw, ph, pd, gridX, gridY, wallId, faceType) {
      if (panelCount >= MAX_PANELS) return;
      const arr = getArr(typeName);
      const vertexStart = arr.length / 3;
      const v = faceType === 'st' ? topSlabVerts(cx, cy, cz, pw, ph, pd)
              :                     slabVerts(cx, cy, cz, pw, ph, pd);
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

    // ── Floor slab (merged rectangles, ground floor top-face only) ───────
    {
      const mask = Array.from({ length: width }, (_, mx) => {
        const row = new Uint8Array(depth);
        for (let z = 0; z < depth; z++)
          if (grid[mx][z] && !(f > 0 && grid[mx][z] === 3)) row[z] = 1;
        return row;
      });
      for (const [rx, rz, rw, rd] of mergeSlabs(mask, width, depth)) {
        const inset = slabThick * 0.5; // 0.05m — half wall thickness
        const hasMinX = walls.v[rx]?.slice(rz, rz + rd).some(Boolean) ?? false;
        const hasMaxX = walls.v[rx + rw]?.slice(rz, rz + rd).some(Boolean) ?? false;
        const hasMinZ = Array.from({ length: rw }, (_, i) => walls.h[rx + i]?.[rz]).some(Boolean);
        const hasMaxZ = Array.from({ length: rw }, (_, i) => walls.h[rx + i]?.[rz + rd]).some(Boolean);
        const sx0 = wx + rx      - (hasMinX ? inset : 0);
        const sx1 = wx + rx + rw + (hasMaxX ? inset : 0);
        const sz0 = wz + rz      - (hasMinZ ? inset : 0);
        const sz1 = wz + rz + rd + (hasMaxZ ? inset : 0);
        addPanel('concrete',
          (sx0 + sx1) * 0.5, floorY + slabThick * 0.5, (sz0 + sz1) * 0.5,
          sx1 - sx0, slabThick, sz1 - sz0, rx, f * 100, -1, f === 0 ? 'st' : 's');
      }
    }

    // ── Ceiling slab (merged rectangles) ──────────────────────────────────
    const isTopFloor = f === floors.length - 1;
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
      for (const [rx, rz, rw, rd] of mergeSlabs(mask, width, depth)) {
        const inset = slabThick * 0.5;
        const hasMinX = walls.v[rx]?.slice(rz, rz + rd).some(Boolean) ?? false;
        const hasMaxX = walls.v[rx + rw]?.slice(rz, rz + rd).some(Boolean) ?? false;
        const hasMinZ = Array.from({ length: rw }, (_, i) => walls.h[rx + i]?.[rz]).some(Boolean);
        const hasMaxZ = Array.from({ length: rw }, (_, i) => walls.h[rx + i]?.[rz + rd]).some(Boolean);
        const sx0 = wx + rx      - (hasMinX ? inset : 0);
        const sx1 = wx + rx + rw + (hasMaxX ? inset : 0);
        const sz0 = wz + rz      - (hasMinZ ? inset : 0);
        const sz1 = wz + rz + rd + (hasMaxZ ? inset : 0);
        addPanel('concrete',
          (sx0 + sx1) * 0.5, floorY + heightPerFloor - slabThick * 0.5, (sz0 + sz1) * 0.5,
          sx1 - sx0, slabThick, sz1 - sz0, rx, f * 100 + 99, -1, 's');
      }
    }

    // Clear height between slabs (for walls)
    const clearH   = heightPerFloor - slabThick;  // wall extends from floor surface to ceiling top
    const wallRows  = Math.ceil(clearH);               // panels per wall segment
    const panelH   = clearH / wallRows;                // height of each panel

    // Door opening height and window band (metres above floor surface)
    const DOOR_H  = 2.0;
    const WIN_BOT = 0.9, WIN_TOP = 2.1;

    // ── Horizontal wall panels (h[x][z]) ──────────────────────────────────
    // walls.h[x][z] separates cell (x, z-1) [below] from cell (x, z) [above].
    // +Z face looks toward "above" cell; -Z face looks toward "below" cell.
    // Outer loop over z rows then height rows p. Adjacent same-material segments
    // in each row are merged into a single quad to minimise triangle count.
    for (let z = 0; z <= depth; z++) {
      const extMat = buildingDef.style.extWall;
      const intMat = buildingDef.style.intWall;
      for (let p = 0; p < wallRows; p++) {
        const relY = panelH * p + panelH * 0.5;
        const cy   = floorY + slabThick + relY;

        // Collect active segments for this (z, p) row
        const segs = []; // { x, matPZ, matMZ, hShift, leftExt, rightExt }
        for (let x = 0; x < width; x++) {
          if (!walls.h[x][z]) continue;
          const below = z > 0     ? grid[x][z - 1] : 0;
          const above = z < depth ? grid[x][z]     : 0;
          if (below === 0 && above === 0) continue;
          const isDoor  = doors.has(dKey('h', x, z));
          if (isDoor && relY < DOOR_H) continue;  // door gap — skip this panel row
          const isExt   = (below === 0 || above === 0);
          const isWin   = windows.has(dKey('h', x, z));
          const isGlass = isWin && relY >= WIN_BOT && relY <= WIN_TOP;
          const hShift  = isExt ? (below === 0 ? -slabThick * 0.5 : slabThick * 0.5) : 0;
          const { leftExt, rightExt } = hWallExtensions(walls, x, z, width, depth);
          segs.push({
            x,
            matPZ: isGlass ? 'glass' : ((above === 0) ? extMat : intMat),
            matMZ: isGlass ? 'glass' : ((below === 0) ? extMat : intMat),
            hShift, leftExt, rightExt,
          });
        }

        // Emit merged quads for each face direction independently.
        // A run breaks when: x is non-consecutive, material changes, or hShift changes.
        for (const faceDir of ['pz', 'mz']) {
          const matKey   = faceDir === 'pz' ? 'matPZ' : 'matMZ';
          const emitFace = faceDir === 'pz' ? hFacePZ  : hFaceMZ;
          let i = 0;
          while (i < segs.length) {
            let j = i;
            while (j + 1 < segs.length &&
                   segs[j + 1].x === segs[j].x + 1 &&
                   segs[j + 1][matKey] === segs[j][matKey] &&
                   segs[j + 1].hShift === segs[j].hShift) { j++; }
            // Merged quad spans [segs[i].x .. segs[j].x].
            // Terminal extensions apply only to the actual run endpoints.
            const leftX  = wx + segs[i].x - segs[i].leftExt;
            const rightX = wx + segs[j].x + 1 + segs[j].rightExt;
            const hw     = rightX - leftX;
            const cx     = (leftX + rightX) * 0.5;
            const cz     = wz + z + segs[i].hShift;
            getArr(segs[i][matKey]).push(...emitFace(cx, cy, cz, hw, panelH, 0.1));
            i = j + 1;
          }
        }

        // Register individual panels + emit 4 edge faces (Option A: always emit)
        for (const seg of segs) {
          if (panelCount >= MAX_PANELS) break;
          const rMat = seg.matPZ;
          const def  = PANEL_TYPES[rMat] ?? PANEL_TYPES.concrete;
          const arr  = getArr(rMat);
          const pcx  = wx + seg.x + 0.5;
          const pcz  = wz + z + seg.hShift;
          const vertexStart = arr.length / 3;
          arr.push(...hPanelEdges(pcx, cy, pcz, panelH));
          registerPanel({
            id: _panelId++, type: rMat, hp: def.hp, maxHp: def.hp,
            gridX: seg.x, gridY: f * 10 + p, wallId: z * 10000 + seg.x, buildingId,
            vertexStart, vertexCount: 24, penetrationCost: def.pen, isSupported: true,
          });
          panelCount++;
        }
      }
    }

    // ── Vertical wall panels (v[x][z]) ────────────────────────────────────
    // walls.v[x][z] separates cell (x-1, z) [left] from cell (x, z) [right].
    // +X face looks toward "right" cell; -X face looks toward "left" cell.
    // Outer loop over x columns then height rows p. Adjacent same-material segments
    // in each column are merged into a single quad.
    for (let x = 0; x <= width; x++) {
      const extMat = buildingDef.style.extWall;
      const intMat = buildingDef.style.intWall;
      for (let p = 0; p < wallRows; p++) {
        const relY = panelH * p + panelH * 0.5;
        const cy   = floorY + slabThick + relY;

        const segs = []; // { z, matPX, matMX, vShift, botExt, topExt }
        for (let z = 0; z < depth; z++) {
          if (!walls.v[x][z]) continue;
          const left  = x > 0     ? grid[x - 1][z] : 0;
          const right = x < width ? grid[x][z]     : 0;
          if (left === 0 && right === 0) continue;
          const isDoor  = doors.has(dKey('v', x, z));
          if (isDoor && relY < DOOR_H) continue;
          const isExt   = (left === 0 || right === 0);
          const isWin   = windows.has(dKey('v', x, z));
          const isGlass = isWin && relY >= WIN_BOT && relY <= WIN_TOP;
          const vShift  = isExt ? (left === 0 ? -slabThick * 0.5 : slabThick * 0.5) : 0;
          const { botExt, topExt } = vWallExtensions(walls, x, z, width, depth);
          segs.push({
            z,
            matPX: isGlass ? 'glass' : ((right === 0) ? extMat : intMat),
            matMX: isGlass ? 'glass' : ((left  === 0) ? extMat : intMat),
            vShift, botExt, topExt,
          });
        }

        for (const faceDir of ['px', 'mx']) {
          const matKey   = faceDir === 'px' ? 'matPX' : 'matMX';
          const emitFace = faceDir === 'px' ? vFacePX  : vFaceMX;
          let i = 0;
          while (i < segs.length) {
            let j = i;
            while (j + 1 < segs.length &&
                   segs[j + 1].z === segs[j].z + 1 &&
                   segs[j + 1][matKey] === segs[j][matKey] &&
                   segs[j + 1].vShift === segs[j].vShift) { j++; }
            const botZ  = wz + segs[i].z - segs[i].botExt;
            const topZ  = wz + segs[j].z + 1 + segs[j].topExt;
            const vd    = topZ - botZ;
            const cz    = (botZ + topZ) * 0.5;
            const cx    = wx + x + segs[i].vShift;
            getArr(segs[i][matKey]).push(...emitFace(cx, cy, cz, 0.1, panelH, vd));
            i = j + 1;
          }
        }

        for (const seg of segs) {
          if (panelCount >= MAX_PANELS) break;
          const rMat = seg.matPX;
          const def  = PANEL_TYPES[rMat] ?? PANEL_TYPES.concrete;
          const arr  = getArr(rMat);
          const pcx  = wx + x + seg.vShift;
          const pcz  = wz + seg.z + 0.5;
          const vertexStart = arr.length / 3;
          arr.push(...vPanelEdges(pcx, cy, pcz, panelH));
          registerPanel({
            id: _panelId++, type: rMat, hp: def.hp, maxHp: def.hp,
            gridX: x, gridY: f * 10 + p, wallId: x * 10000 + seg.z, buildingId,
            vertexStart, vertexCount: 24, penetrationCost: def.pen, isSupported: true,
          });
          panelCount++;
        }
      }
    }

    // ── Props ─────────────────────────────────────────────────────────────
    for (const { x, z, type } of fp.props ?? []) {
      const def = PROP_DEFS[type];
      if (!def) continue;
      const pMesh = new THREE.Mesh(
        new THREE.BoxGeometry(def.w, def.h, def.d),
        getPanelMat(def.mat),
      );
      pMesh.position.set(
        wx + x + def.w * 0.5,
        floorY + slabThick + def.h * 0.5,
        wz + z + def.d * 0.5,
      );
      pMesh.castShadow = true;
      group.add(pMesh);
      registerProp({ id: _panelId++, type, hp: def.hp, maxHp: def.hp, buildingId });
    }

    // ── Build merged meshes for this floor ────────────────────────────────
    for (const [typeName, arr] of Object.entries(verts)) {
      if (arr.length === 0) continue;
      const mesh = buildMesh(arr, getPanelMat(typeName));
      if (mesh) group.add(mesh);
    }
  }

  // ── Stair geometry ────────────────────────────────────────────────────
  for (const sw of buildingDef.stairwells ?? []) {
    for (let f = 0; f < floors.length - 1; f++) {
      const floorY = wy + f * heightPerFloor;
      const verts  = buildStairVerts(wx + sw.x, wz + sw.z, floorY, heightPerFloor, sw.axis);
      const mesh   = buildMesh(verts, getPanelMat('wood'));
      if (mesh) group.add(mesh);
      // Register each step as a prop
      const STEPS = 10;
      for (let i = 0; i < STEPS; i++) {
        registerProp({ id: _panelId++, type: 'stair_step', hp: 3, maxHp: 3, buildingId });
      }
    }
  }

  // ── Roof-access ladder (single-floor or no-stairwell buildings) ───────
  const needsLadder = (archetype === 'warehouse' || archetype === 'strip_mall') ||
                      (floors.length > 1 && (buildingDef.stairwells ?? []).length === 0);
  if (needsLadder) {
    const totalHeight = floors.length * heightPerFloor;
    const ladder = buildLadderMesh(wx, wy, wz, buildingDef.footprintW, buildingDef.footprintD, 'n', totalHeight);
    if (ladder) group.add(ladder);
    registerProp({ id: _panelId++, type: 'ladder', hp: 3, maxHp: 3, buildingId });
  }

  // ── Apartment fire-escape ladder (east wall) ──────────────────────────
  if (archetype === 'apartment') {
    const totalHeight = floors.length * heightPerFloor;
    const ladder = buildLadderMesh(wx, wy, wz, buildingDef.footprintW, buildingDef.footprintD, 'e', totalHeight);
    if (ladder) group.add(ladder);
    registerProp({ id: _panelId++, type: 'ladder', hp: 3, maxHp: 3, buildingId });
  }

  // ── Warehouse catwalk ─────────────────────────────────────────────────
  if (archetype === 'warehouse') {
    addWarehouseCatwalk(group, buildingDef, wx, wy, wz);
  }

  return group;
}

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
