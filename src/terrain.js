import * as THREE from 'three';
import { CHUNK_SIZE } from './state.js';
import { createPerlin } from './utils.js';

// ─── NOISE SETUP ────────────────────────────────────────────
let perlin = createPerlin(42317);

export function reseedTerrain(seed) {
  perlin = createPerlin(seed);
}

// ─── CONSTANTS ──────────────────────────────────────────────
const SEGMENTS = 32;                   // quads per side → 33×33 vertices
const CELL = CHUNK_SIZE / SEGMENTS;    // ≈ 1.875 units per cell

// ─── HEIGHT FUNCTION ────────────────────────────────────────
// Pure world-coord function — chunk edges stitch automatically.
export function getHeight(wx, wz) {
  let h  = perlin(wx * 0.007, wz * 0.007) * 10; // large hills ±10u
      h += perlin(wx * 0.025, wz * 0.025) * 3;  // medium rolls
      h += perlin(wx * 0.08,  wz * 0.08)  * 0.8; // fine detail
  return h;
}

// ─── TERRAIN CHUNK MESH ─────────────────────────────────────
export function generateTerrainChunk(cx, cz) {
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const verts = SEGMENTS + 1; // 33

  // Sample heights for the full grid
  const heights = new Float32Array(verts * verts);
  for (let iz = 0; iz < verts; iz++) {
    for (let ix = 0; ix < verts; ix++) {
      heights[iz * verts + ix] = getHeight(ox + ix * CELL, oz + iz * CELL);
    }
  }

  // Height range for color normalization (approximate global range ±13.8)
  const H_MIN = -14, H_RANGE = 28;

  const positions = new Float32Array(verts * verts * 3);
  const colors    = new Float32Array(verts * verts * 3);

  for (let iz = 0; iz < verts; iz++) {
    for (let ix = 0; ix < verts; ix++) {
      const idx = iz * verts + ix;
      const h = heights[idx];

      // Position
      const pi = idx * 3;
      positions[pi]     = ox + ix * CELL;
      positions[pi + 1] = h;
      positions[pi + 2] = oz + iz * CELL;

      // Vertex AO — sum how much higher neighbors are (concavity measure)
      let sumAbove = 0, count = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = ix + dx, nz = iz + dz;
          if (nx >= 0 && nx < verts && nz >= 0 && nz < verts) {
            sumAbove += Math.max(0, heights[nz * verts + nx] - h);
            count++;
          }
        }
      }
      const avgAbove = count > 0 ? sumAbove / count : 0;
      const ao = 1.0 - Math.min(0.65, avgAbove * 0.08);

      // Height-based color: dark earth valley → earthy mid-grass → dry ridge
      const t = Math.max(0, Math.min(1, (h - H_MIN) / H_RANGE));
      const r = (0.10 + t * 0.38) * ao;
      const g = (0.13 + t * 0.30) * ao;
      const b = (0.07 + t * 0.18) * ao;

      colors[pi]     = r;
      colors[pi + 1] = g;
      colors[pi + 2] = b;
    }
  }

  // Index buffer for the quad grid
  const indexCount = SEGMENTS * SEGMENTS * 6;
  const indices = new Uint16Array(indexCount);
  let ii = 0;
  for (let iz = 0; iz < SEGMENTS; iz++) {
    for (let ix = 0; ix < SEGMENTS; ix++) {
      const a = iz * verts + ix;
      const b = iz * verts + ix + 1;
      const c = (iz + 1) * verts + ix;
      const d = (iz + 1) * verts + ix + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}
