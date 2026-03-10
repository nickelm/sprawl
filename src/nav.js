// ─── NAV / PATHFINDING ─────────────────────────────────────
const CELL    = 1.5;   // world units per grid cell
const MARGIN  = 10;    // padding around path bounding box (world units)
const ENEMY_R = 0.45;  // obstacle inflation radius
const MAX_ITER = 4000; // A* iteration cap before giving up

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

// ─── PUBLIC API ────────────────────────────────────────────

// buildNavGrid: grid is built lazily per findPath call.
// Kept for API compatibility / future precomputed upgrade.
export function buildNavGrid(colliders) {
  return colliders;
}

// findPath: returns array of {x,z} world-space waypoints, or null if no path.
// from / to: objects with .x and .z (or THREE.Vector3)
export function findPath(from, to, colliders) {
  if (!colliders || colliders.length === 0) {
    return [{ x: to.x, z: to.z }];
  }

  // ── build local grid bounding box ──
  const minX = Math.min(from.x, to.x) - MARGIN;
  const minZ = Math.min(from.z, to.z) - MARGIN;
  const maxX = Math.max(from.x, to.x) + MARGIN;
  const maxZ = Math.max(from.z, to.z) + MARGIN;

  const cols = Math.ceil((maxX - minX) / CELL) + 1;
  const rows = Math.ceil((maxZ - minZ) / CELL) + 1;

  // ── mark blocked cells ──
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

  // ── grid coords ──
  const fx = Math.max(0, Math.min(cols - 1, Math.floor((from.x - minX) / CELL)));
  const fz = Math.max(0, Math.min(rows - 1, Math.floor((from.z - minZ) / CELL)));
  const tx = Math.max(0, Math.min(cols - 1, Math.floor((to.x - minX) / CELL)));
  const tz = Math.max(0, Math.min(rows - 1, Math.floor((to.z - minZ) / CELL)));

  // clear start/end in case they're on a building edge
  const startIdx = fz * cols + fx;
  const endIdx   = tz * cols + tx;
  blocked[startIdx] = 0;
  blocked[endIdx]   = 0;

  if (startIdx === endIdx) return [{ x: to.x, z: to.z }];

  // ── A* ──
  const g    = new Float32Array(cols * rows).fill(Infinity);
  const prev = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);

  g[startIdx] = 0;
  const heap = new MinHeap();
  heap.push(0, startIdx);

  // 8-directional offsets [dcol, drow, cost]
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

  // ── reconstruct raw path ──
  const raw = [];
  let cur = endIdx;
  while (cur !== -1) {
    raw.push(cur);
    cur = prev[cur];
  }
  raw.reverse();

  // ── line-of-sight smoothing ──
  // Walk forward; skip intermediate nodes when we have clear LOS to a further node.
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

  // ── convert to world coords ──
  return smoothed.map(idx => ({
    x: minX + (idx % cols + 0.5) * CELL,
    z: minZ + ((idx / cols | 0) + 0.5) * CELL,
  }));
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
