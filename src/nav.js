// ─── NAV / PATHFINDING ─────────────────────────────────────
// Exterior grid-based A* + persistent interior building nav graph.
// Interior nodes registered per building; portal nodes at doors bridge
// the dynamic exterior grid to the interior graph.

import { ladderDefs } from './buildings.js';

const CELL    = 1.5;   // world units per grid cell
const MARGIN  = 10;    // padding around path bounding box (world units)
const ENEMY_R = 0.45;  // obstacle inflation radius
const MAX_ITER = 4000; // A* iteration cap (exterior-only)
const MAX_ITER_HYBRID = 6000; // A* iteration cap when interior nodes involved
const MAX_INTERIOR_NODES = 200; // per-building node cap (spec §8)

// ─── BINARY MIN-HEAP ───────────────────────────────────────
// Stores [f, idx] pairs interleaved: d = [f0,idx0, f1,idx1, ...]
class MinHeap {
  constructor() { this.d = []; }
  get size() { return this.d.length >> 1; }

  push(f, idx) {
    this.d.push(f, idx);
    this._up(this.size - 1);
  }

  pop() {
    const topF = this.d[0], topI = this.d[1];
    const last = this.size - 1;
    if (last === 0) { this.d.length = 0; return [topF, topI]; }
    this.d[0] = this.d[last * 2];
    this.d[1] = this.d[last * 2 + 1];
    this.d.length -= 2;
    this._down(0);
    return [topF, topI];
  }

  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.d[p*2] <= this.d[i*2]) break;
      this._swap(p, i);
      i = p;
    }
  }

  _down(i) {
    const n = this.size;
    for (;;) {
      let m = i;
      const l = 2*i + 1, r = 2*i + 2;
      if (l < n && this.d[l*2] < this.d[m*2]) m = l;
      if (r < n && this.d[r*2] < this.d[m*2]) m = r;
      if (m === i) break;
      this._swap(i, m);
      i = m;
    }
  }

  _swap(a, b) {
    const tf = this.d[a*2], ti = this.d[a*2+1];
    this.d[a*2] = this.d[b*2]; this.d[a*2+1] = this.d[b*2+1];
    this.d[b*2] = tf;          this.d[b*2+1] = ti;
  }
}

// ─── INTERIOR NAV GRAPH ──────────────────────────────────────
// Persistent graph of interior building nodes, edges, and portal connections.

const _interiorNodes   = new Map(); // nodeId → { x, y, z, floor, buildingId }
const _interiorEdges   = new Map(); // nodeId → [{ target: nodeId, cost }]
const _portalNodes     = new Map(); // nodeId → { x, y, z, buildingId, interiorNodeId }
const _buildingNavData = new Map(); // buildingId → { nodeIds: Set, portalIds: Set }

// ─── HELPERS ─────────────────────────────────────────────────

function interiorNodeId(buildingId, floor, cx, cz) {
  return 'B' + buildingId + ':' + floor + ':' + cx + ':' + cz;
}

function portalNodeId(buildingId, doorKey) {
  return 'P' + buildingId + ':' + doorKey;
}

function addEdge(nodeA, nodeB, cost) {
  let listA = _interiorEdges.get(nodeA);
  if (!listA) { listA = []; _interiorEdges.set(nodeA, listA); }
  listA.push({ target: nodeB, cost });

  let listB = _interiorEdges.get(nodeB);
  if (!listB) { listB = []; _interiorEdges.set(nodeB, listB); }
  listB.push({ target: nodeA, cost });
}

/** Returns true if wall exists and no door opens it. */
function isWallBlocked(fp, axis, x, z) {
  if (axis === 'h') {
    return fp.walls.h[x] && fp.walls.h[x][z] && !fp.doors.has('h:' + x + ':' + z);
  }
  return fp.walls.v[x] && fp.walls.v[x][z] && !fp.doors.has('v:' + x + ':' + z);
}

// ─── REGISTER BUILDING INTERIOR ──────────────────────────────

export function registerBuildingInterior(buildingId, buildingDef, wx, wy, wz) {
  const { floors, heightPerFloor, footprintW, footprintD, stairwells } = buildingDef;
  const navData = { nodeIds: new Set(), portalIds: new Set() };
  _buildingNavData.set(buildingId, navData);

  let nodeCount = 0;

  function addNode(f, cx, cz) {
    const nid = interiorNodeId(buildingId, f, cx, cz);
    if (navData.nodeIds.has(nid)) return;
    _interiorNodes.set(nid, {
      x: wx + cx + 0.5,
      y: wy + f * heightPerFloor + 0.1,
      z: wz + cz + 0.5,
      floor: f,
      buildingId,
    });
    navData.nodeIds.add(nid);
    nodeCount++;
  }

  // ── Step 1: Generate nodes ──
  // Priority pass: stairwell cells on ALL floors (ensures vertical connectivity)
  for (const sw of stairwells ?? []) {
    const swCells = [{ x: sw.x, z: sw.z }];
    if (sw.axis === 'x') swCells.push({ x: sw.x + 1, z: sw.z });
    else swCells.push({ x: sw.x, z: sw.z + 1 });
    for (let f = 0; f < floors.length; f++) {
      for (const cell of swCells) addNode(f, cell.x, cell.z);
    }
  }

  // Main pass: remaining interior cells
  for (let f = 0; f < floors.length; f++) {
    const fp = floors[f];
    for (let cx = 0; cx < footprintW; cx++) {
      for (let cz = 0; cz < footprintD; cz++) {
        if (fp.cells[cx][cz] === 0) continue; // exterior void
        if (nodeCount >= MAX_INTERIOR_NODES) break;
        addNode(f, cx, cz);
      }
      if (nodeCount >= MAX_INTERIOR_NODES) break;
    }
    if (nodeCount >= MAX_INTERIOR_NODES) break;
  }

  // ── Step 2: Horizontal edges ──
  for (const nid of navData.nodeIds) {
    const node = _interiorNodes.get(nid);
    const f = node.floor;
    const fp = floors[f];
    const cx = Math.floor(node.x - wx);
    const cz = Math.floor(node.z - wz);

    // Cardinal directions: [dx, dz, wallAxis, wallX, wallZ]
    const cardinals = [
      [1,  0, 'v', cx + 1, cz],  // +X: v-wall at cx+1
      [-1, 0, 'v', cx,     cz],  // -X: v-wall at cx
      [0,  1, 'h', cx, cz + 1],  // +Z: h-wall at cz+1
      [0, -1, 'h', cx,     cz],  // -Z: h-wall at cz
    ];

    const passable = [false, false, false, false]; // track cardinal passability for diagonal check

    for (let ci = 0; ci < 4; ci++) {
      const [dx, dz, axis, wallX, wallZ] = cardinals[ci];
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= footprintW || nz < 0 || nz >= footprintD) continue;

      const neighborId = interiorNodeId(buildingId, f, nx, nz);
      if (!navData.nodeIds.has(neighborId)) continue;
      if (isWallBlocked(fp, axis, wallX, wallZ)) continue;

      passable[ci] = true;

      // Only add edge from the lower-ID node to avoid duplicates
      if (nid < neighborId) {
        addEdge(nid, neighborId, 1.0);
      }
    }

    // Diagonal directions
    // Diagonals: [dx, dz, cardinal index A, cardinal index B]
    const diagonals = [
      [1,  1,  0, 2], // +X +Z: needs +X passable AND +Z passable
      [1, -1,  0, 3], // +X -Z
      [-1, 1,  1, 2], // -X +Z
      [-1,-1,  1, 3], // -X -Z
    ];

    for (const [dx, dz, ciA, ciB] of diagonals) {
      if (!passable[ciA] || !passable[ciB]) continue;
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= footprintW || nz < 0 || nz >= footprintD) continue;

      const neighborId = interiorNodeId(buildingId, f, nx, nz);
      if (!navData.nodeIds.has(neighborId)) continue;

      // Also check the two walls that border the diagonal cell
      // Moving (+1,+1): check wall between (cx+1,cz) and (cx+1,cz+1), and between (cx,cz+1) and (cx+1,cz+1)
      const midA = interiorNodeId(buildingId, f, cx + dx, cz);
      const midB = interiorNodeId(buildingId, f, cx, cz + dz);
      if (!navData.nodeIds.has(midA) || !navData.nodeIds.has(midB)) continue;

      if (nid < neighborId) {
        addEdge(nid, neighborId, 1.414);
      }
    }
  }

  // ── Step 3: Vertical edges — stairs ──
  for (const sw of stairwells ?? []) {
    const cells = [{ x: sw.x, z: sw.z }];
    if (sw.axis === 'x') cells.push({ x: sw.x + 1, z: sw.z });
    else cells.push({ x: sw.x, z: sw.z + 1 });

    for (const cell of cells) {
      for (let f = 0; f < floors.length - 1; f++) {
        const lower = interiorNodeId(buildingId, f, cell.x, cell.z);
        const upper = interiorNodeId(buildingId, f + 1, cell.x, cell.z);
        if (navData.nodeIds.has(lower) && navData.nodeIds.has(upper)) {
          addEdge(lower, upper, 3.0);
        }
      }
    }
  }

  // ── Step 4: Vertical edges — ladders ──
  for (const lad of ladderDefs) {
    if (lad.buildingId !== buildingId) continue;

    // Ladder is at world position (lad.cx, lad.cz) with face direction lad.normal
    // The adjacent interior cell is one cell inward from the ladder face
    const localX = Math.floor(lad.cx - wx);
    const localZ = Math.floor(lad.cz - wz);
    // Move inward: opposite of normal direction
    const interiorCX = localX - Math.round(lad.normal.x);
    const interiorCZ = localZ - Math.round(lad.normal.z);

    if (interiorCX < 0 || interiorCX >= footprintW || interiorCZ < 0 || interiorCZ >= footprintD) continue;

    for (let f = 0; f < floors.length - 1; f++) {
      const lower = interiorNodeId(buildingId, f, interiorCX, interiorCZ);
      const upper = interiorNodeId(buildingId, f + 1, interiorCX, interiorCZ);
      if (navData.nodeIds.has(lower) && navData.nodeIds.has(upper)) {
        addEdge(lower, upper, 5.0);
      }
    }
  }

  // ── Step 5: Portal edges ──
  const gfp = floors[0]; // ground floor
  if (!gfp || !gfp.doors) return;

  for (const dk of gfp.doors) {
    const parts = dk.split(':');
    const axis = parts[0];
    const dx = parseInt(parts[1], 10);
    const dz = parseInt(parts[2], 10);

    // Is this door on the perimeter?
    let outDirX = 0, outDirZ = 0;
    if (axis === 'h') {
      if (dz === 0) outDirZ = -1;
      else if (dz === footprintD) outDirZ = 1;
      else continue; // interior door
    } else {
      if (dx === 0) outDirX = -1;
      else if (dx === footprintW) outDirX = 1;
      else continue; // interior door
    }

    // Interior cell adjacent to this door
    let interiorCX, interiorCZ;
    if (axis === 'h') {
      interiorCX = dx;
      interiorCZ = outDirZ < 0 ? 0 : footprintD - 1;
    } else {
      interiorCX = outDirX < 0 ? 0 : footprintW - 1;
      interiorCZ = dz;
    }

    const interiorNid = interiorNodeId(buildingId, 0, interiorCX, interiorCZ);
    if (!navData.nodeIds.has(interiorNid)) continue;

    // World position just outside the door
    let portalX, portalZ;
    if (axis === 'h') {
      portalX = wx + dx + 0.5;
      portalZ = wz + dz + (outDirZ < 0 ? -0.5 : 0.5);
    } else {
      portalX = wx + dx + (outDirX < 0 ? -0.5 : 0.5);
      portalZ = wz + dz + 0.5;
    }

    const pid = portalNodeId(buildingId, dk);
    _portalNodes.set(pid, {
      x: portalX,
      y: wy + 0.1,
      z: portalZ,
      buildingId,
      interiorNodeId: interiorNid,
    });
    navData.portalIds.add(pid);

    // Bidirectional edge: portal ↔ interior door node, cost 1.5
    addEdge(pid, interiorNid, 1.5);
  }
}

// ─── UNREGISTER BUILDING INTERIOR ────────────────────────────

export function unregisterBuildingInterior(buildingId) {
  const navData = _buildingNavData.get(buildingId);
  if (!navData) return;

  // Remove all interior nodes and their edges
  for (const nid of navData.nodeIds) {
    _interiorNodes.delete(nid);
    // Remove edges from this node
    const edges = _interiorEdges.get(nid);
    if (edges) {
      // Remove reverse edges pointing to this node
      for (const e of edges) {
        const targetEdges = _interiorEdges.get(e.target);
        if (targetEdges) {
          const idx = targetEdges.findIndex(te => te.target === nid);
          if (idx !== -1) targetEdges.splice(idx, 1);
        }
      }
      _interiorEdges.delete(nid);
    }
  }

  // Remove portal nodes and their edges
  for (const pid of navData.portalIds) {
    _portalNodes.delete(pid);
    const edges = _interiorEdges.get(pid);
    if (edges) {
      for (const e of edges) {
        const targetEdges = _interiorEdges.get(e.target);
        if (targetEdges) {
          const idx = targetEdges.findIndex(te => te.target === pid);
          if (idx !== -1) targetEdges.splice(idx, 1);
        }
      }
      _interiorEdges.delete(pid);
    }
  }

  _buildingNavData.delete(buildingId);
}

// ─── PUBLIC API ────────────────────────────────────────────

// buildNavGrid: grid is built lazily per findPath call.
// Kept for API compatibility / future precomputed upgrade.
export function buildNavGrid(colliders) {
  return colliders;
}

// findPath: returns array of {x,z} or {x,y,z} world-space waypoints, or null.
// Interior waypoints include y for vertical positioning.
// from / to: objects with .x and .z (or THREE.Vector3)
export function findPath(from, to, colliders, insideBuildingId) {
  if (!colliders || colliders.length === 0) {
    return [{ x: to.x, z: to.z }];
  }

  // ── build local grid bounding box ──
  let minX = Math.min(from.x, to.x) - MARGIN;
  let minZ = Math.min(from.z, to.z) - MARGIN;
  let maxX = Math.max(from.x, to.x) + MARGIN;
  let maxZ = Math.max(from.z, to.z) + MARGIN;

  // When starting inside a building, expand bbox to include its portals
  if (insideBuildingId != null) {
    const navData = _buildingNavData.get(insideBuildingId);
    if (navData) {
      for (const pid of navData.portalIds) {
        const pdata = _portalNodes.get(pid);
        if (pdata) {
          minX = Math.min(minX, pdata.x - MARGIN);
          minZ = Math.min(minZ, pdata.z - MARGIN);
          maxX = Math.max(maxX, pdata.x + MARGIN);
          maxZ = Math.max(maxZ, pdata.z + MARGIN);
        }
      }
    }
  }

  // ── Find portals in query region ──
  const regionPortals = [];
  for (const [pid, pdata] of _portalNodes) {
    if (pdata.x >= minX && pdata.x <= maxX && pdata.z >= minZ && pdata.z <= maxZ) {
      regionPortals.push({ pid, pdata });
    }
  }

  // Fast path: no portals, use original grid-only A*
  if (regionPortals.length === 0) {
    return _findPathGridOnly(from, to, colliders, minX, minZ, maxX, maxZ);
  }

  // ── Hybrid A* with interior nodes ──
  return _findPathHybrid(from, to, colliders, minX, minZ, maxX, maxZ, regionPortals, insideBuildingId);
}

// ─── GRID-ONLY A* (original implementation) ─────────────────

function _findPathGridOnly(from, to, colliders, minX, minZ, maxX, maxZ) {
  const cols = Math.ceil((maxX - minX) / CELL) + 1;
  const rows = Math.ceil((maxZ - minZ) / CELL) + 1;

  const blocked = new Uint8Array(cols * rows);
  for (const c of colliders) {
    const c0 = Math.max(0, Math.floor((c.minX - ENEMY_R - minX) / CELL));
    const c1 = Math.min(cols - 1, Math.ceil((c.maxX + ENEMY_R - minX) / CELL));
    const r0 = Math.max(0, Math.floor((c.minZ - ENEMY_R - minZ) / CELL));
    const r1 = Math.min(rows - 1, Math.ceil((c.maxZ + ENEMY_R - minZ) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        blocked[r * cols + cc] = 1;
      }
    }
  }

  const fx = Math.max(0, Math.min(cols - 1, Math.floor((from.x - minX) / CELL)));
  const fz = Math.max(0, Math.min(rows - 1, Math.floor((from.z - minZ) / CELL)));
  const tx = Math.max(0, Math.min(cols - 1, Math.floor((to.x - minX) / CELL)));
  const tz = Math.max(0, Math.min(rows - 1, Math.floor((to.z - minZ) / CELL)));

  const startIdx = fz * cols + fx;
  const endIdx   = tz * cols + tx;
  blocked[startIdx] = 0;
  blocked[endIdx]   = 0;

  if (startIdx === endIdx) return [{ x: to.x, z: to.z }];

  const g    = new Float32Array(cols * rows).fill(Infinity);
  const prev = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);

  g[startIdx] = 0;
  const heap = new MinHeap();
  heap.push(0, startIdx);

  const DIRS = [
    [1,0,1],[-1,0,1],[0,1,1],[0,-1,1],
    [1,1,1.414],[-1,1,1.414],[1,-1,1.414],[-1,-1,1.414],
  ];

  let found = false;
  let iters = 0;

  while (heap.size > 0 && iters < MAX_ITER) {
    iters++;
    const [, cur] = heap.pop();
    if (cur === endIdx) { found = true; break; }
    if (closed[cur]) continue;
    closed[cur] = 1;

    const curCol = cur % cols;
    const curRow = (cur / cols) | 0;

    for (const [dc, dr, cost] of DIRS) {
      const nc = curCol + dc;
      const nr = curRow + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const nIdx = nr * cols + nc;
      if (blocked[nIdx] || closed[nIdx]) continue;

      const ng = g[cur] + cost;
      if (ng < g[nIdx]) {
        g[nIdx] = ng;
        prev[nIdx] = cur;
        const dxh = nc - tx, dzh = nr - tz;
        heap.push(ng + Math.sqrt(dxh*dxh + dzh*dzh), nIdx);
      }
    }
  }

  if (!found) return null;

  const raw = [];
  let cur = endIdx;
  while (cur !== -1) {
    raw.push(cur);
    cur = prev[cur];
  }
  raw.reverse();

  const smoothed = [raw[0]];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1) {
      if (hasLOS(raw[i], raw[j], cols, blocked)) break;
      j--;
    }
    smoothed.push(raw[j]);
    i = j;
  }

  return smoothed.map(idx => ({
    x: minX + (idx % cols + 0.5) * CELL,
    z: minZ + ((idx / cols | 0) + 0.5) * CELL,
  }));
}

// ─── HYBRID A* (exterior grid + interior graph) ──────────────

function _findPathHybrid(from, to, colliders, minX, minZ, maxX, maxZ, regionPortals, insideBuildingId) {
  const cols = Math.ceil((maxX - minX) / CELL) + 1;
  const rows = Math.ceil((maxZ - minZ) / CELL) + 1;
  const gridSize = cols * rows;

  // ── Build blocked grid ──
  const blocked = new Uint8Array(gridSize);
  for (const c of colliders) {
    const c0 = Math.max(0, Math.floor((c.minX - ENEMY_R - minX) / CELL));
    const c1 = Math.min(cols - 1, Math.ceil((c.maxX + ENEMY_R - minX) / CELL));
    const r0 = Math.max(0, Math.floor((c.minZ - ENEMY_R - minZ) / CELL));
    const r1 = Math.min(rows - 1, Math.ceil((c.maxZ + ENEMY_R - minZ) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        blocked[r * cols + cc] = 1;
      }
    }
  }

  // ── Collect relevant interior nodes ──
  // Gather all interior nodes for buildings that have portals in this region
  const relevantBuildings = new Set();
  for (const { pdata } of regionPortals) {
    relevantBuildings.add(pdata.buildingId);
  }

  // Assign temporary integer IDs to interior+portal nodes
  // Grid nodes: 0 .. gridSize-1
  // Extended nodes: gridSize .. gridSize+N-1
  const extNodeIds = [];      // index → string nodeId
  const extNodeIdMap = new Map(); // string nodeId → temp integer ID

  // Add portal nodes
  for (const { pid } of regionPortals) {
    const tempId = gridSize + extNodeIds.length;
    extNodeIds.push(pid);
    extNodeIdMap.set(pid, tempId);
  }

  // Add interior nodes for relevant buildings
  for (const bid of relevantBuildings) {
    const navData = _buildingNavData.get(bid);
    if (!navData) continue;
    for (const nid of navData.nodeIds) {
      if (extNodeIdMap.has(nid)) continue;
      const tempId = gridSize + extNodeIds.length;
      extNodeIds.push(nid);
      extNodeIdMap.set(nid, tempId);
    }
  }

  // ── Map portal nodes to grid cells ──
  // portalGridMap: grid cell index → [tempId of portal node]
  const portalGridMap = new Map();
  for (const { pid, pdata } of regionPortals) {
    const gc = Math.floor((pdata.x - minX) / CELL);
    const gr = Math.floor((pdata.z - minZ) / CELL);
    if (gc >= 0 && gc < cols && gr >= 0 && gr < rows) {
      const gridIdx = gr * cols + gc;
      // Unblock the portal's grid cell so enemies can reach the door
      blocked[gridIdx] = 0;
      let list = portalGridMap.get(gridIdx);
      if (!list) { list = []; portalGridMap.set(gridIdx, list); }
      list.push(extNodeIdMap.get(pid));
    }
  }

  // ── Grid coords for start/end ──
  const fx = Math.max(0, Math.min(cols - 1, Math.floor((from.x - minX) / CELL)));
  const fz = Math.max(0, Math.min(rows - 1, Math.floor((from.z - minZ) / CELL)));
  const tx = Math.max(0, Math.min(cols - 1, Math.floor((to.x - minX) / CELL)));
  const tz = Math.max(0, Math.min(rows - 1, Math.floor((to.z - minZ) / CELL)));

  const startIdx = fz * cols + fx;
  const endIdx   = tz * cols + tx;
  blocked[startIdx] = 0;
  blocked[endIdx]   = 0;

  if (startIdx === endIdx) return [{ x: to.x, z: to.z }];

  // ── Target world position (for heuristic) ──
  const toX = to.x, toZ = to.z, toY = to.y || 0;

  // ── A* with Map-based storage for extended nodes ──
  // Grid nodes use typed arrays, extended nodes use Maps
  const gGrid    = new Float32Array(gridSize).fill(Infinity);
  const prevGrid = new Int32Array(gridSize).fill(-1);
  const closedGrid = new Uint8Array(gridSize);

  const gExt    = new Map(); // tempId → g-cost
  const prevExt = new Map(); // tempId → prev tempId
  const closedExt = new Set();

  function getG(id) {
    return id < gridSize ? gGrid[id] : (gExt.get(id) ?? Infinity);
  }
  function setG(id, val) {
    if (id < gridSize) gGrid[id] = val;
    else gExt.set(id, val);
  }
  function getPrev(id) {
    return id < gridSize ? prevGrid[id] : (prevExt.get(id) ?? -1);
  }
  function setPrev(id, val) {
    if (id < gridSize) prevGrid[id] = val;
    else prevExt.set(id, val);
  }
  function isClosed(id) {
    return id < gridSize ? closedGrid[id] : closedExt.has(id);
  }
  function setClosed(id) {
    if (id < gridSize) closedGrid[id] = 1;
    else closedExt.add(id);
  }

  // ── Node position lookup for heuristic ──
  function nodeWorldPos(id) {
    if (id < gridSize) {
      const c = id % cols, r = (id / cols) | 0;
      return { x: minX + (c + 0.5) * CELL, y: 0, z: minZ + (r + 0.5) * CELL };
    }
    const nid = extNodeIds[id - gridSize];
    const inode = _interiorNodes.get(nid) || _portalNodes.get(nid);
    return inode || { x: 0, y: 0, z: 0 };
  }

  function heuristic(id) {
    const p = nodeWorldPos(id);
    const dx = p.x - toX, dz = p.z - toZ, dy = (p.y || 0) - toY;
    return Math.sqrt(dx*dx + dz*dz + dy*dy);
  }

  // When starting inside a building, seed from the nearest interior node
  // instead of the (blocked) grid cell
  let actualStart = startIdx;
  if (insideBuildingId != null) {
    const navData = _buildingNavData.get(insideBuildingId);
    if (navData) {
      let bestDist = Infinity;
      let bestTempId = -1;
      for (const nid of navData.nodeIds) {
        const tempId = extNodeIdMap.get(nid);
        if (tempId === undefined) continue;
        const node = _interiorNodes.get(nid);
        if (!node) continue;
        const dx = node.x - from.x, dz = node.z - from.z;
        const d = dx * dx + dz * dz;
        if (d < bestDist) { bestDist = d; bestTempId = tempId; }
      }
      if (bestTempId !== -1) actualStart = bestTempId;
    }
  }

  setG(actualStart, 0);
  const heap = new MinHeap();
  heap.push(heuristic(actualStart), actualStart);

  const DIRS = [
    [1,0,1],[-1,0,1],[0,1,1],[0,-1,1],
    [1,1,1.414],[-1,1,1.414],[1,-1,1.414],[-1,-1,1.414],
  ];

  let found = false;
  let iters = 0;

  while (heap.size > 0 && iters < MAX_ITER_HYBRID) {
    iters++;
    const [, cur] = heap.pop();
    if (cur === endIdx) { found = true; break; }
    if (isClosed(cur)) continue;
    setClosed(cur);

    const curG = getG(cur);

    if (cur < gridSize) {
      // ── Expand grid node ──
      const curCol = cur % cols;
      const curRow = (cur / cols) | 0;

      for (const [dc, dr, cost] of DIRS) {
        const nc = curCol + dc;
        const nr = curRow + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const nIdx = nr * cols + nc;
        if (blocked[nIdx] || isClosed(nIdx)) continue;

        const ng = curG + cost;
        if (ng < getG(nIdx)) {
          setG(nIdx, ng);
          setPrev(nIdx, cur);
          heap.push(ng + heuristic(nIdx), nIdx);
        }
      }

      // ── Expand to portal nodes at this grid cell ──
      const portals = portalGridMap.get(cur);
      if (portals) {
        for (const ptId of portals) {
          if (isClosed(ptId)) continue;
          const ng = curG + 1.0; // cost to step from grid cell to portal position
          if (ng < getG(ptId)) {
            setG(ptId, ng);
            setPrev(ptId, cur);
            heap.push(ng + heuristic(ptId), ptId);
          }
        }
      }
    } else {
      // ── Expand interior/portal node ──
      const nid = extNodeIds[cur - gridSize];
      const edges = _interiorEdges.get(nid);
      if (edges) {
        for (const edge of edges) {
          const targetTempId = extNodeIdMap.get(edge.target);
          if (targetTempId === undefined || isClosed(targetTempId)) continue;
          const ng = curG + edge.cost;
          if (ng < getG(targetTempId)) {
            setG(targetTempId, ng);
            setPrev(targetTempId, cur);
            heap.push(ng + heuristic(targetTempId), targetTempId);
          }
        }
      }

      // ── Portal node → expand back to grid ──
      if (_portalNodes.has(nid)) {
        const pdata = _portalNodes.get(nid);
        const gc = Math.floor((pdata.x - minX) / CELL);
        const gr = Math.floor((pdata.z - minZ) / CELL);
        if (gc >= 0 && gc < cols && gr >= 0 && gr < rows) {
          const gridIdx = gr * cols + gc;
          if (!isClosed(gridIdx)) {
            const ng = curG + 1.0;
            if (ng < getG(gridIdx)) {
              setG(gridIdx, ng);
              setPrev(gridIdx, cur);
              heap.push(ng + heuristic(gridIdx), gridIdx);
            }
          }
        }
      }
    }
  }

  if (!found) return null;

  // ── Reconstruct path ──
  const rawIds = [];
  let cur = endIdx;
  while (cur !== -1) {
    rawIds.push(cur);
    cur = getPrev(cur);
  }
  rawIds.reverse();

  // ── Convert to world coords with portal awareness ──
  // Segment the path into exterior and interior runs for LOS smoothing
  const waypoints = [];

  for (let i = 0; i < rawIds.length; i++) {
    const id = rawIds[i];

    if (id >= gridSize) {
      const nid = extNodeIds[id - gridSize];
      const node = _interiorNodes.get(nid) || _portalNodes.get(nid);
      if (node) {
        const wp = { x: node.x, z: node.z };
        if (node.y !== undefined) wp.y = node.y;
        if (_portalNodes.has(nid)) wp._portal = true;
        wp._buildingId = node.buildingId;
        waypoints.push(wp);
      }
    } else {
      waypoints.push({
        x: minX + (id % cols + 0.5) * CELL,
        z: minZ + ((id / cols | 0) + 0.5) * CELL,
      });
    }
  }

  // ── Smooth exterior segments only ──
  // Don't smooth across portal boundaries — interior paths need exact waypoints
  return _smoothHybridPath(waypoints, colliders);
}

/** Smooth a hybrid path: LOS-smooth contiguous exterior segments,
 *  keep interior/portal waypoints intact. */
function _smoothHybridPath(waypoints, colliders) {
  if (waypoints.length <= 2) return waypoints;

  const result = [];
  let segStart = 0;

  while (segStart < waypoints.length) {
    const isInterior = waypoints[segStart].y !== undefined;

    // Find end of contiguous segment (same type)
    let segEnd = segStart;
    while (segEnd + 1 < waypoints.length) {
      const next = waypoints[segEnd + 1];
      const nextIsInterior = next.y !== undefined;
      if (nextIsInterior !== isInterior) break;
      segEnd++;
    }

    if (isInterior || segEnd - segStart < 2) {
      // Interior segments or short segments: keep all waypoints
      for (let i = segStart; i <= segEnd; i++) {
        result.push(waypoints[i]);
      }
    } else {
      // Exterior segment: apply LOS smoothing
      const segment = waypoints.slice(segStart, segEnd + 1);
      const smoothed = _smoothExteriorSegment(segment, colliders);
      for (const wp of smoothed) result.push(wp);
    }

    segStart = segEnd + 1;
  }

  return result;
}

/** LOS-smooth an array of exterior-only waypoints. */
function _smoothExteriorSegment(waypoints, colliders) {
  if (waypoints.length <= 2) return waypoints;
  const smoothed = [waypoints[0]];
  let i = 0;
  while (i < waypoints.length - 1) {
    let j = waypoints.length - 1;
    while (j > i + 1) {
      if (hasLineOfSight(waypoints[i].x, waypoints[i].z, waypoints[j].x, waypoints[j].z, colliders)) break;
      j--;
    }
    smoothed.push(waypoints[j]);
    i = j;
  }
  return smoothed;
}

// ─── RANDOM INTERIOR POSITIONS (for indoor spawn testing) ──
export function getRandomInteriorPositions(count) {
  // Collect ground-floor interior nodes
  const candidates = [];
  for (const [nid, node] of _interiorNodes) {
    if (node.floor === 0) candidates.push(node);
  }
  if (candidates.length === 0) return [];

  const result = [];
  const used = new Set();
  const n = Math.min(count, candidates.length);
  for (let i = 0; i < n; i++) {
    let idx;
    let attempts = 0;
    do {
      idx = Math.floor(Math.random() * candidates.length);
      attempts++;
    } while (used.has(idx) && attempts < 50);
    if (used.has(idx)) break;
    used.add(idx);
    const c = candidates[idx];
    result.push({ x: c.x, y: c.y, z: c.z, buildingId: c.buildingId });
  }
  return result;
}

// ─── WORLD-SPACE LINE OF SIGHT ────────────────────────────
// 2D ray-vs-AABB: returns true if clear LOS between two world-space points.
export function hasLineOfSight(ox, oz, tx, tz, colliders) {
  const dx = tx - ox;
  const dz = tz - oz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.01) return true;
  const ndx = dx / dist;
  const ndz = dz / dist;

  for (const c of colliders) {
    let tmin = -Infinity, tmax = Infinity;

    if (Math.abs(ndx) > 1e-8) {
      let t1 = (c.minX - ox) / ndx;
      let t2 = (c.maxX - ox) / ndx;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
    } else {
      if (ox < c.minX || ox > c.maxX) continue;
    }

    if (Math.abs(ndz) > 1e-8) {
      let t1 = (c.minZ - oz) / ndz;
      let t2 = (c.maxZ - oz) / ndz;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
    } else {
      if (oz < c.minZ || oz > c.maxZ) continue;
    }

    if (tmin <= tmax && tmax > 0 && tmin < dist) {
      return false;
    }
  }
  return true;
}

// ── line-of-sight check between two grid indices ──
function hasLOS(a, b, cols, blocked) {
  let x0 = a % cols, y0 = (a / cols) | 0;
  const x1 = b % cols, y1 = (b / cols) | 0;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (blocked[y0 * cols + x0]) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 <  dx) { err += dx; y0 += sy; }
  }
}
