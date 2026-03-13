#!/usr/bin/env node

// ─── MODEL DECOMPOSER ───────────────────────────────────────────────────────
//
// Node.js CLI that takes a 3D model (GLB/glTF/OBJ), uses V-HACD to
// oversegment it into convex hulls, fits an AABB primitive to each hull,
// samples colors from source mesh, merges adjacent primitives down to a
// budget with strict constraints, and outputs a JSON recipe.
//
// Usage:
//   node tools/decompose.js input.glb --category weapon --archetype dmr \
//     --output recipes/mk14.json --budget 25
//   node tools/decompose.js chair.obj --category furniture --budget 15 \
//     --output recipes/chair.json
//
// See docs/weapons-tool-spec.md §2 for full specification.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { ConvexMeshDecomposition } from 'vhacd-js/lib/vhacd.js';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';

// ─── ARGUMENT PARSING ────────────────────────────────────────────────────────

const VALID_ARCHETYPES = [
  'pistol', 'revolver', 'smg', 'carbine', 'ar',
  'battle_rifle', 'lmg', 'dmr', 'sniper', 'shotgun'
];

const VALID_CATEGORIES = ['weapon', 'attachment', 'prop', 'vehicle', 'furniture'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    input: null,
    output: null,
    budget: 25,
    maxHulls: 80,
    vhacdResolution: 400000,
    category: 'prop',
    archetype: null,
    minVolume: 0.5,
    noMerge: false,
    mergeMaxVolume: 0.20,
    mergeMaxAspect: 1.5,
    quantize: false,
    palette: 'weapon',
    bakeAO: false,
    normalizeSize: 50,
    rotateX: 0,
    rotateY: 0,
    rotateZ: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' || arg === '-o') { opts.output = args[++i]; }
    else if (arg === '--budget') { opts.budget = parseInt(args[++i], 10); }
    else if (arg === '--max-hulls') { opts.maxHulls = parseInt(args[++i], 10); }
    else if (arg === '--vhacd-resolution') { opts.vhacdResolution = parseInt(args[++i], 10); }
    else if (arg === '--category') { opts.category = args[++i]; }
    else if (arg === '--archetype') { opts.archetype = args[++i]; }
    else if (arg === '--min-volume') { opts.minVolume = parseFloat(args[++i]); }
    else if (arg === '--no-merge') { opts.noMerge = true; }
    else if (arg === '--merge-max-volume') { opts.mergeMaxVolume = parseFloat(args[++i]); }
    else if (arg === '--merge-max-aspect') { opts.mergeMaxAspect = parseFloat(args[++i]); }
    else if (arg === '--quantize') { opts.quantize = true; }
    else if (arg === '--palette') { opts.palette = args[++i]; }
    else if (arg === '--bake-ao') { opts.bakeAO = true; }
    else if (arg === '--normalize-size') { opts.normalizeSize = parseFloat(args[++i]); }
    else if (arg === '--rotate-x') { opts.rotateX = (opts.rotateX + 90) % 360; }
    else if (arg === '--rotate-y') { opts.rotateY = (opts.rotateY + 90) % 360; }
    else if (arg === '--rotate-z') { opts.rotateZ = (opts.rotateZ + 90) % 360; }
    else if (!arg.startsWith('--') && !opts.input) { opts.input = arg; }
  }

  if (!opts.input) {
    console.error('Usage: node decompose.js <input.glb|obj> [options]');
    console.error('  --output <path>         Output JSON path (default: stdout)');
    console.error('  --budget <n>            Max primitives (default: 25)');
    console.error('  --max-hulls <n>         V-HACD hull count, 2-4x budget (default: 80)');
    console.error('  --vhacd-resolution <n>  V-HACD voxel resolution (default: 400000)');
    console.error('  --category <type>       Category:', VALID_CATEGORIES.join(', '), '(default: prop)');
    console.error('  --archetype <type>      Weapon archetype (required for weapons):', VALID_ARCHETYPES.join(', '));
    console.error('  --min-volume <f>        Min primitive volume as % of total (default: 0.5)');
    console.error('  --no-merge              Skip merge pass entirely');
    console.error('  --merge-max-volume <f>  Max volume increase fraction for merge (default: 0.20)');
    console.error('  --merge-max-aspect <f>  Max aspect ratio growth factor for merge (default: 1.5)');
    console.error('  --quantize              Quantize colors to nearest palette entry');
    console.error('  --palette <name|path>   Color palette: weapon, vehicle, furniture, or JSON path (default: weapon)');
    console.error('  --bake-ao               Compute per-primitive ambient occlusion');
    console.error('  --normalize-size <f>    Target size in cm for longest axis (default: 50)');
    console.error('  --rotate-x             Rotate 90° around X (stackable)');
    console.error('  --rotate-y             Rotate 90° around Y (stackable)');
    console.error('  --rotate-z             Rotate 90° around Z (stackable)');
    process.exit(1);
  }

  if (!VALID_CATEGORIES.includes(opts.category)) {
    console.error(`Error: --category must be one of: ${VALID_CATEGORIES.join(', ')}`);
    process.exit(1);
  }

  if (opts.category === 'weapon') {
    if (!opts.archetype || !VALID_ARCHETYPES.includes(opts.archetype)) {
      console.error(`Error: --archetype is required for weapons. Must be one of: ${VALID_ARCHETYPES.join(', ')}`);
      process.exit(1);
    }
  }

  return opts;
}

// ─── OBJ LOADING ─────────────────────────────────────────────────────────────

function loadOBJ(filePath) {
  const text = readFileSync(resolve(filePath), 'utf8');
  const lines = text.split('\n');
  const positions = [];
  const indices = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('v ')) {
      const parts = trimmed.split(/\s+/);
      positions.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
    } else if (trimmed.startsWith('f ')) {
      const parts = trimmed.split(/\s+/).slice(1);
      // Parse face indices — handle v, v/vt, v/vt/vn, v//vn formats
      const faceIndices = parts.map(p => parseInt(p.split('/')[0], 10) - 1);
      if (faceIndices.length >= 3) {
        // First triangle
        indices.push(faceIndices[0], faceIndices[1], faceIndices[2]);
        // Triangulate quads and n-gons with fan triangulation
        for (let i = 3; i < faceIndices.length; i++) {
          indices.push(faceIndices[0], faceIndices[i - 1], faceIndices[i]);
        }
      }
    }
  }

  if (positions.length === 0) {
    console.error('Error: No vertices found in OBJ file.');
    process.exit(1);
  }

  console.error(`OBJ parsed: ${positions.length / 3} vertices, ${indices.length / 3} triangles`);
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    vertexColors: null,
    materials: null,
    materialPerTri: null,
  };
}

// ─── GLTF LOADING ────────────────────────────────────────────────────────────

async function loadGLTF(filePath) {
  const absPath = resolve(filePath);
  console.error(`Resolved path: ${absPath}`);
  // Change to the directory containing the file so @gltf-transform can resolve
  // relative .bin references (e.g. "scene.bin") from .gltf files correctly.
  const origCwd = process.cwd();
  process.chdir(dirname(absPath));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  let doc;
  try {
    doc = await io.read(absPath);
  } finally {
    process.chdir(origCwd);
  }
  const root = doc.getRoot();

  const allPositions = [];
  const allIndices = [];
  const allVertexColors = [];  // RGB per vertex (0-1 range)
  const allMaterialPerTri = []; // material index per triangle
  const materialsList = [];     // { baseColorFactor: [r,g,b,a] }
  const materialMap = new Map(); // glTF Material → index
  let vertexOffset = 0;
  let hasAnyVertexColors = false;

  // Walk all nodes, collect mesh geometry with world transforms
  function processNode(node, parentMatrix) {
    // Compute local transform matrix
    const local = mat4Identity();
    const t = node.getTranslation();
    const r = node.getRotation();
    const s = node.getScale();
    mat4FromTRS(local, t, r, s);

    const world = mat4Multiply(mat4Identity(), parentMatrix, local);

    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const posAccessor = prim.getAttribute('POSITION');
        if (!posAccessor) continue;

        const posArray = posAccessor.getArray();
        const indexAccessor = prim.getIndices();
        const vertCount = posArray.length / 3;

        // Extract vertex colors (COLOR_0)
        const colorAccessor = prim.getAttribute('COLOR_0');
        if (colorAccessor) {
          hasAnyVertexColors = true;
          const colorArray = colorAccessor.getArray();
          const colorSize = colorAccessor.getElementSize(); // 3 (RGB) or 4 (RGBA)
          for (let i = 0; i < vertCount; i++) {
            const ci = i * colorSize;
            // Store as sRGB (glTF vertex colors are linear)
            allVertexColors.push(
              linearToSRGB(colorArray[ci]),
              linearToSRGB(colorArray[ci + 1]),
              linearToSRGB(colorArray[ci + 2])
            );
          }
        } else {
          // Pad with -1 sentinel so indices stay aligned
          for (let i = 0; i < vertCount; i++) {
            allVertexColors.push(-1, -1, -1);
          }
        }

        // Extract material
        const mat = prim.getMaterial();
        let matIdx = 0;
        if (mat) {
          if (!materialMap.has(mat)) {
            const bcf = mat.getBaseColorFactor ? mat.getBaseColorFactor() : [0.5, 0.5, 0.5, 1.0];
            materialMap.set(mat, materialsList.length);
            materialsList.push({
              baseColorFactor: [linearToSRGB(bcf[0]), linearToSRGB(bcf[1]), linearToSRGB(bcf[2]), bcf[3]],
            });
          }
          matIdx = materialMap.get(mat);
        } else if (materialsList.length === 0) {
          materialsList.push({ baseColorFactor: [0.5, 0.5, 0.5, 1.0] });
        }

        // Transform positions to world space
        for (let i = 0; i < posArray.length; i += 3) {
          const v = mat4TransformPoint(world, posArray[i], posArray[i + 1], posArray[i + 2]);
          allPositions.push(v[0], v[1], v[2]);
        }

        // Collect indices (offset by vertex count so far)
        let triCount = 0;
        if (indexAccessor) {
          const idxArray = indexAccessor.getArray();
          for (let i = 0; i < idxArray.length; i++) {
            allIndices.push(idxArray[i] + vertexOffset);
          }
          triCount = idxArray.length / 3;
        } else {
          for (let i = 0; i < vertCount; i++) {
            allIndices.push(i + vertexOffset);
          }
          triCount = vertCount / 3;
        }

        // Track material per triangle
        for (let i = 0; i < triCount; i++) {
          allMaterialPerTri.push(matIdx);
        }

        vertexOffset += vertCount;
      }
    }

    for (const child of node.listChildren()) {
      processNode(child, world);
    }
  }

  const identity = mat4Identity();
  for (const scene of root.listScenes()) {
    for (const node of scene.listChildren()) {
      processNode(node, identity);
    }
  }

  if (allPositions.length === 0) {
    console.error('Error: No mesh geometry found in the file.');
    process.exit(1);
  }

  return {
    positions: new Float32Array(allPositions),
    indices: new Uint32Array(allIndices),
    vertexColors: hasAnyVertexColors ? new Float32Array(allVertexColors) : null,
    materials: materialsList.length > 0 ? materialsList : null,
    materialPerTri: allMaterialPerTri.length > 0 ? new Uint16Array(allMaterialPerTri) : null,
  };
}

// ─── LOAD DISPATCH ───────────────────────────────────────────────────────────

async function loadMesh(filePath) {
  const ext = filePath.toLowerCase().replace(/^.*\./, '.');
  if (ext === '.obj') {
    return loadOBJ(filePath);
  } else if (ext === '.glb' || ext === '.gltf') {
    return loadGLTF(filePath);
  } else {
    console.error(`Error: Unsupported file format "${ext}". Use .glb, .gltf, or .obj`);
    process.exit(1);
  }
}

// ─── 4x4 MATRIX HELPERS (column-major) ──────────────────────────────────────

function mat4Identity() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]);
}

function mat4FromTRS(out, t, q, s) {
  // Build matrix from translation, quaternion rotation, scale
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  out[0]  = (1 - (yy + zz)) * s[0];
  out[1]  = (xy + wz) * s[0];
  out[2]  = (xz - wy) * s[0];
  out[3]  = 0;
  out[4]  = (xy - wz) * s[1];
  out[5]  = (1 - (xx + zz)) * s[1];
  out[6]  = (yz + wx) * s[1];
  out[7]  = 0;
  out[8]  = (xz + wy) * s[2];
  out[9]  = (yz - wx) * s[2];
  out[10] = (1 - (xx + yy)) * s[2];
  out[11] = 0;
  out[12] = t[0];
  out[13] = t[1];
  out[14] = t[2];
  out[15] = 1;
  return out;
}

function mat4Multiply(out, a, b) {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function mat4TransformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8]  * z + m[12],
    m[1] * x + m[5] * y + m[9]  * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// ─── NORMALIZATION ───────────────────────────────────────────────────────────

function normalizeMesh(positions, normalizeSize = 50, rotDeg = [0, 0, 0]) {
  const n = positions.length / 3;

  // Compute centroid
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < positions.length; i += 3) {
    cx += positions[i];
    cy += positions[i + 1];
    cz += positions[i + 2];
  }
  cx /= n; cy /= n; cz /= n;

  // Translate to origin
  for (let i = 0; i < positions.length; i += 3) {
    positions[i]     -= cx;
    positions[i + 1] -= cy;
    positions[i + 2] -= cz;
  }

  // ── Apply 90-degree rotations (user-specified via --rotate-x/y/z) ──
  // Apply rotations in X → Y → Z order. For 90-degree increments we use exact values.
  const DEG = Math.PI / 180;
  for (const [axis, deg] of [[0, rotDeg[0]], [1, rotDeg[1]], [2, rotDeg[2]]]) {
    if (deg === 0) continue;
    const rad = deg * DEG;
    const c = Math.round(Math.cos(rad));
    const s = Math.round(Math.sin(rad));
    for (let i = 0; i < positions.length; i += 3) {
      let a1, a2;
      if (axis === 0) { a1 = 1; a2 = 2; }       // rotate around X: Y,Z rotate
      else if (axis === 1) { a1 = 2; a2 = 0; }   // rotate around Y: Z,X rotate
      else { a1 = 0; a2 = 1; }                    // rotate around Z: X,Y rotate
      const v1 = positions[i + a1], v2 = positions[i + a2];
      positions[i + a1] = v1 * c - v2 * s;
      positions[i + a2] = v1 * s + v2 * c;
    }
    console.error(`Applied ${deg}° rotation around ${'XYZ'[axis]} axis`);
  }

  // Compute bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // Scale so longest axis = normalizeSize cm
  const extents = [maxX - minX, maxY - minY, maxZ - minZ];
  const longest = Math.max(...extents);
  const scaleFactor = (longest > 0) ? (normalizeSize / longest) : 1;

  for (let i = 0; i < positions.length; i++) {
    positions[i] *= scaleFactor;
  }

  return {
    scaleFactor,
    centroid: [cx, cy, cz],
    rotation: rotDeg,
    bbox: {
      min: [minX * scaleFactor, minY * scaleFactor, minZ * scaleFactor],
      max: [maxX * scaleFactor, maxY * scaleFactor, maxZ * scaleFactor],
    },
  };
}

// ─── PER-HULL PRIMITIVE FITTING (AABB only) ─────────────────────────────────

function fitPrimitive(positions) {
  // positions: Float64Array or Float32Array of [x,y,z, x,y,z, ...]
  const n = positions.length / 3;
  if (n < 3) return null;

  // Compute AABB
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const extents = [maxX - minX, maxY - minY, maxZ - minZ];
  const vol = extents[0] * extents[1] * extents[2];

  return {
    type: 'box',
    pos: center,
    rot: [0, 0, 0],
    scale: extents,
    _volume: vol,
    _vertices: positions,
    _min: [minX, minY, minZ],
    _max: [maxX, maxY, maxZ],
  };
}

// ─── V-HACD OVERSEGMENTATION ────────────────────────────────────────────────

async function vhacdDecompose(positions, indices, opts) {
  const decomposer = await ConvexMeshDecomposition.create();

  // vhacd-js requires Float64Array for positions
  const positions64 = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i++) positions64[i] = positions[i];

  const hulls = decomposer.computeConvexHulls(
    { positions: positions64, indices },
    {
      maxHulls: opts.maxHulls,
      voxelResolution: opts.vhacdResolution,
      messages: 'progress',
    }
  );
  return hulls; // array of { positions: Float64Array, indices: Uint32Array }
}

// ─── ADJACENCY GRAPH ─────────────────────────────────────────────────────────

function buildAdjacency(primitives, threshold) {
  // Spatial hash: map cell key → set of primitive indices
  const cellSize = threshold;
  const cellMap = new Map();

  function cellKey(x, y, z) {
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    const cz = Math.floor(z / cellSize);
    return `${cx},${cy},${cz}`;
  }

  // For each primitive, hash all its vertices into grid cells
  const primCells = []; // primCells[i] = Set of cell keys
  for (let pi = 0; pi < primitives.length; pi++) {
    const verts = primitives[pi]._vertices;
    const cells = new Set();
    for (let i = 0; i < verts.length; i += 3) {
      const key = cellKey(verts[i], verts[i + 1], verts[i + 2]);
      cells.add(key);
      if (!cellMap.has(key)) cellMap.set(key, new Set());
      cellMap.get(key).add(pi);
    }
    primCells.push(cells);
  }

  // Build adjacency: two primitives are adjacent if they share a cell
  // or have vertices in neighboring cells
  const adjacency = new Map();
  for (let pi = 0; pi < primitives.length; pi++) {
    adjacency.set(pi, new Set());
  }

  // Check each primitive's vertices against neighboring cells
  for (let pi = 0; pi < primitives.length; pi++) {
    const verts = primitives[pi]._vertices;
    const neighbors = new Set();
    for (let i = 0; i < verts.length; i += 3) {
      const x = verts[i], y = verts[i + 1], z = verts[i + 2];
      // Check the 27 neighboring cells (including own cell)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const key = cellKey(
              x + dx * cellSize,
              y + dy * cellSize,
              z + dz * cellSize
            );
            const prims = cellMap.get(key);
            if (prims) {
              for (const pj of prims) {
                if (pj !== pi) neighbors.add(pj);
              }
            }
          }
        }
      }
    }
    for (const pj of neighbors) {
      adjacency.get(pi).add(pj);
      adjacency.get(pj).add(pi);
    }
  }

  return adjacency;
}

// ─── COLOR HELPERS ───────────────────────────────────────────────────────────

function hexToRGB(hex) {
  const h = (hex || '#3a3a3a').replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r, g, b) {
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}

function linearToSRGB(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function mergeColors(a, b) {
  const ca = hexToRGB(a._color);
  const cb = hexToRGB(b._color);
  const va = a._volume || 1, vb = b._volume || 1;
  const total = va + vb;
  return rgbToHex(
    (ca[0] * va + cb[0] * vb) / total,
    (ca[1] * va + cb[1] * vb) / total,
    (ca[2] * va + cb[2] * vb) / total
  );
}

// ─── COLOR SAMPLING FROM SOURCE MESH ─────────────────────────────────────────

function buildTriangleIndex(positions, indices, cellSize) {
  const grid = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const triMin = [Infinity, Infinity, Infinity];
    const triMax = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < 3; v++) {
      const vi = indices[t + v] * 3;
      for (let a = 0; a < 3; a++) {
        triMin[a] = Math.min(triMin[a], positions[vi + a]);
        triMax[a] = Math.max(triMax[a], positions[vi + a]);
      }
    }
    for (let x = Math.floor(triMin[0] / cellSize); x <= Math.floor(triMax[0] / cellSize); x++)
    for (let y = Math.floor(triMin[1] / cellSize); y <= Math.floor(triMax[1] / cellSize); y++)
    for (let z = Math.floor(triMin[2] / cellSize); z <= Math.floor(triMax[2] / cellSize); z++) {
      const key = `${x},${y},${z}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(t / 3);
    }
  }
  return grid;
}

function getOverlappingTriangles(primitive, grid, cellSize) {
  const triSet = new Set();
  // Compute AABB from pos ± scale/2 (with small margin)
  const margin = 0.5;
  const min = primitive.pos.map((v, i) => v - primitive.scale[i] / 2 - margin);
  const max = primitive.pos.map((v, i) => v + primitive.scale[i] / 2 + margin);
  for (let x = Math.floor(min[0] / cellSize); x <= Math.floor(max[0] / cellSize); x++)
  for (let y = Math.floor(min[1] / cellSize); y <= Math.floor(max[1] / cellSize); y++)
  for (let z = Math.floor(min[2] / cellSize); z <= Math.floor(max[2] / cellSize); z++) {
    const key = `${x},${y},${z}`;
    const tris = grid.get(key);
    if (tris) for (const t of tris) triSet.add(t);
  }
  return triSet;
}

function sampleTriangleColor(triIndex, positions, indices, vertexColors, materials, materialPerTri) {
  // Try vertex colors first
  if (vertexColors) {
    const i0 = indices[triIndex * 3] * 3;
    const i1 = indices[triIndex * 3 + 1] * 3;
    const i2 = indices[triIndex * 3 + 2] * 3;
    // Check sentinel (-1 = no vertex color for this vertex)
    if (vertexColors[i0] >= 0 && vertexColors[i1] >= 0 && vertexColors[i2] >= 0) {
      return [
        (vertexColors[i0] + vertexColors[i1] + vertexColors[i2]) / 3,
        (vertexColors[i0 + 1] + vertexColors[i1 + 1] + vertexColors[i2 + 1]) / 3,
        (vertexColors[i0 + 2] + vertexColors[i1 + 2] + vertexColors[i2 + 2]) / 3,
      ];
    }
  }
  // Fall back to material color
  if (materials && materialPerTri) {
    const matIdx = materialPerTri[triIndex];
    const mat = materials[matIdx];
    if (mat && mat.baseColorFactor) {
      return mat.baseColorFactor.slice(0, 3);
    }
  }
  return null;
}

function computePrimitiveColor(primitive, grid, cellSize, meshData) {
  const tris = getOverlappingTriangles(primitive, grid, cellSize);
  if (tris.size === 0) return null;

  let r = 0, g = 0, b = 0, count = 0;
  for (const t of tris) {
    const c = sampleTriangleColor(
      t, meshData.positions, meshData.indices,
      meshData.vertexColors, meshData.materials, meshData.materialPerTri
    );
    if (c) {
      r += c[0]; g += c[1]; b += c[2];
      count++;
    }
  }

  if (count === 0) return null;

  return rgbToHex(
    (r / count) * 255,
    (g / count) * 255,
    (b / count) * 255
  );
}

// ─── Z-POSITION FALLBACK PALETTE ────────────────────────────────────────────

function assignPositionColor(primitive, bbox) {
  const zRange = bbox.max[2] - bbox.min[2];
  const yRange = bbox.max[1] - bbox.min[1];
  const normZ = zRange > 0 ? (primitive.pos[2] - bbox.min[2]) / zRange : 0.5;
  const normY = yRange > 0 ? (primitive.pos[1] - bbox.min[1]) / yRange : 0.5;

  if (normZ > 0.6) return '#2a2a2a';   // barrel region, dark metal
  if (normZ < 0.2) return '#3d3530';   // stock region, warm dark
  if (normY < 0.3) return '#2a2a20';   // below center, magazine/grip
  return '#3a3a3a';                     // receiver, medium grey
}

// ─── ITERATIVE GREEDY MERGE ──────────────────────────────────────────────────

function combineVertices(a, b) {
  const combined = new Float64Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  return combined;
}

function aspectRatio(prim) {
  const s = [prim.scale[0], prim.scale[1], prim.scale[2]].sort((a, b) => a - b);
  return s[2] / Math.max(s[0], 0.001);
}

function canMerge(a, b, merged, maxVolumeIncrease, maxAspectMult) {
  const volIncrease = merged._volume / (a._volume + b._volume) - 1.0;
  if (volIncrease > maxVolumeIncrease) return false;

  const avgAspect = (aspectRatio(a) + aspectRatio(b)) / 2;
  const mergedAR = aspectRatio(merged);
  if (mergedAR > avgAspect * maxAspectMult) return false;

  return true;
}

function mergeDown(primitives, adjacency, budget, mergeMaxVolume = 0.20, mergeMaxAspect = 1.5) {
  // Work with indexed arrays for efficient removal
  let prims = primitives.map((p, i) => ({ ...p, _idx: i }));
  let adj = new Map();
  for (const [k, v] of adjacency) {
    adj.set(k, new Set(v));
  }

  let nextIdx = prims.length;

  while (prims.length > budget) {
    let bestVolIncrease = Infinity;
    let bestI = -1, bestJ = -1;
    let bestMerged = null;

    // Find lowest volume-increase adjacent pair that passes constraints
    for (const p of prims) {
      const neighbors = adj.get(p._idx);
      if (!neighbors) continue;
      for (const nIdx of neighbors) {
        const q = prims.find(x => x._idx === nIdx);
        if (!q || q._idx <= p._idx) continue; // avoid duplicate pairs

        const combined = combineVertices(p._vertices, q._vertices);
        const merged = fitPrimitive(combined);
        if (!merged) continue;

        if (!canMerge(p, q, merged, mergeMaxVolume, mergeMaxAspect)) continue;

        const volIncrease = merged._volume / (p._volume + q._volume) - 1.0;
        if (volIncrease < bestVolIncrease) {
          bestVolIncrease = volIncrease;
          bestI = p._idx;
          bestJ = q._idx;
          bestMerged = merged;
        }
      }
    }

    if (bestI === -1) {
      console.error(`  Merge stopped at ${prims.length} primitives (constraints prevent further merging)`);
      break;
    }

    // Blend colors on merge
    const primA = prims.find(p => p._idx === bestI);
    const primB = prims.find(p => p._idx === bestJ);
    if (primA && primB) {
      bestMerged._color = mergeColors(primA, primB);
    }

    // Assign new index to merged primitive
    bestMerged._idx = nextIdx++;

    // Merge adjacency: new primitive inherits all neighbors of both parents
    const newNeighbors = new Set();
    const neighborsI = adj.get(bestI) || new Set();
    const neighborsJ = adj.get(bestJ) || new Set();
    for (const n of neighborsI) {
      if (n !== bestJ) newNeighbors.add(n);
    }
    for (const n of neighborsJ) {
      if (n !== bestI) newNeighbors.add(n);
    }

    // Remove old entries from adjacency
    adj.delete(bestI);
    adj.delete(bestJ);
    for (const [k, v] of adj) {
      v.delete(bestI);
      v.delete(bestJ);
      if (newNeighbors.has(k)) {
        v.add(bestMerged._idx);
      }
    }

    // Add new entry
    adj.set(bestMerged._idx, newNeighbors);

    // Replace in primitives array
    prims = prims.filter(p => p._idx !== bestI && p._idx !== bestJ);
    prims.push(bestMerged);

    console.error(`  Merged pair (vol+${(bestVolIncrease * 100).toFixed(1)}%), ${prims.length} remaining`);
  }

  // Strip _idx
  return prims.map(p => { const { _idx, ...rest } = p; return rest; });
}

// ─── POST-MERGE CLEANUP ─────────────────────────────────────────────────────

function postMergeCleanup(primitives, minVolumePercent) {
  // Re-fit each primitive for tight bounds (preserve color, group, ao)
  let cleaned = primitives.map(p => {
    const color = p._color;
    const group = p.group;
    const ao = p._ao;
    const refit = fitPrimitive(p._vertices);
    if (refit) { refit._color = color; refit.group = group; refit._ao = ao; return refit; }
    return p;
  });

  // Filter by min volume
  const totalVolume = cleaned.reduce((sum, p) => sum + p._volume, 0);
  if (totalVolume > 0) {
    cleaned = cleaned.filter(p => (p._volume / totalVolume * 100) >= minVolumePercent);
  }

  // Strip internal fields (keep _color for recipe output)
  return cleaned.map(p => {
    const { _volume, _vertices, _min, _max, ...rest } = p;
    return rest;
  });
}

// ─── AUTO-GROUPING ───────────────────────────────────────────────────────────

const GROUP_COLORS = {
  receiver: '#3a3a3a',
  barrel: '#2a2a2a',
  stock: '#3d3530',
  magazine: '#3a3a3a',
  grip: '#3d3530',
  muzzle: '#2a2a2a',
  optic_rail: '#5a5a5a',
  underbarrel: '#3a3a3a',
  trigger_guard: '#2a2a2a',
  cosmetic: '#4a4a4a',
};

function findComponents(primitives, adjacency) {
  const visited = new Set();
  const components = [];
  for (let i = 0; i < primitives.length; i++) {
    if (visited.has(i)) continue;
    const component = [];
    const queue = [i];
    while (queue.length > 0) {
      const idx = queue.shift();
      if (visited.has(idx)) continue;
      visited.add(idx);
      component.push(idx);
      const neighbors = adjacency.get(idx) || new Set();
      for (const n of neighbors) {
        if (!visited.has(n)) queue.push(n);
      }
    }
    components.push(component);
  }
  return components;
}

function assignGroupByPosition(p, minZ, maxZ, minY, maxY, avgVolume) {
  const zRange = maxZ - minZ;
  const yMid = (minY + maxY) / 2;
  const normZ = zRange > 0 ? (p.pos[2] - minZ) / zRange : 0.5;
  const vol = primVolume(p);
  const isSmall = vol < avgVolume * 0.3;
  const maxScale = Math.max(p.scale[0], p.scale[1], p.scale[2]);
  const minScale = Math.min(p.scale[0], p.scale[1], p.scale[2]);
  const ar = minScale > 0 ? maxScale / minScale : 1;

  if (ar > 8 && normZ < 0.5) return 'barrel';
  if (ar > 4 && normZ < 0.3 && p.scale[2] > zRange * 0.2) return 'barrel';
  if (isSmall && normZ < 0.1) return 'muzzle';

  if (normZ < 0.35) {
    if (isSmall && p.pos[1] < yMid) return 'underbarrel';
    return 'barrel';
  } else if (normZ < 0.7) {
    if (normZ >= 0.4 && normZ <= 0.6 && p.pos[1] < yMid - (maxY - minY) * 0.15 && isSmall && ar > 2 && ar < 6) return 'trigger_guard';
    if (p.pos[1] < yMid && p.scale[1] > p.scale[0] * 1.5 && p.scale[1] > p.scale[2] * 1.5) return isSmall ? 'grip' : 'magazine';
    if (p.pos[1] < yMid && isSmall) return 'grip';
    if (p.pos[1] < yMid && !isSmall) return 'magazine';
    if (p.pos[1] > yMid && isSmall) return 'optic_rail';
    return 'receiver';
  }
  return 'stock';
}

function autoGroup(primitives, category = 'weapon') {
  if (primitives.length === 0) return;

  if (category !== 'weapon') {
    for (const p of primitives) p.group = 'body';
    return;
  }

  // Compute bounds
  let minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  let totalVolume = 0;
  for (const p of primitives) {
    if (p.pos[2] < minZ) minZ = p.pos[2];
    if (p.pos[2] > maxZ) maxZ = p.pos[2];
    if (p.pos[1] < minY) minY = p.pos[1];
    if (p.pos[1] > maxY) maxY = p.pos[1];
    totalVolume += primVolume(p);
  }
  const zRange = maxZ - minZ;
  const yMid = (minY + maxY) / 2;
  const avgVolume = totalVolume / primitives.length;

  // Build adjacency for grouping (slightly larger threshold than merge)
  const adj = buildAdjacency(primitives, 1.0);
  const components = findComponents(primitives, adj);

  console.error(`Auto-group: ${components.length} connected components, ${primitives.length} primitives`);

  if (components.length <= 1) {
    // Single component: fall back to per-primitive position-based assignment
    for (const p of primitives) {
      p.group = assignGroupByPosition(p, minZ, maxZ, minY, maxY, avgVolume);
    }
  } else {
    // Multi-component: analyze each component
    const compData = components.map(indices => {
      let vol = 0, cx = 0, cy = 0, cz = 0;
      let cMinZ = Infinity, cMaxZ = -Infinity;
      let cMinY = Infinity, cMaxY = -Infinity;
      let cMinX = Infinity, cMaxX = -Infinity;
      for (const i of indices) {
        const p = primitives[i];
        const v = primVolume(p);
        vol += v;
        cx += p.pos[0] * v; cy += p.pos[1] * v; cz += p.pos[2] * v;
        cMinX = Math.min(cMinX, p.pos[0] - p.scale[0] / 2);
        cMaxX = Math.max(cMaxX, p.pos[0] + p.scale[0] / 2);
        cMinY = Math.min(cMinY, p.pos[1] - p.scale[1] / 2);
        cMaxY = Math.max(cMaxY, p.pos[1] + p.scale[1] / 2);
        cMinZ = Math.min(cMinZ, p.pos[2] - p.scale[2] / 2);
        cMaxZ = Math.max(cMaxZ, p.pos[2] + p.scale[2] / 2);
      }
      if (vol > 0) { cx /= vol; cy /= vol; cz /= vol; }
      return {
        indices, vol, centroid: [cx, cy, cz],
        extents: [cMaxX - cMinX, cMaxY - cMinY, cMaxZ - cMinZ],
      };
    });

    // Sort by volume, largest first
    compData.sort((a, b) => b.vol - a.vol);

    const assigned = new Set();
    for (const comp of compData) {
      const normZ = zRange > 0 ? (comp.centroid[2] - minZ) / zRange : 0.5;
      const normY = (maxY - minY) > 0 ? (comp.centroid[1] - minY) / (maxY - minY) : 0.5;
      const zExtent = comp.extents[2];
      const yExtent = comp.extents[1];
      const xExtent = comp.extents[0];
      const isThin = (zExtent > xExtent * 2 && zExtent > yExtent * 2);

      let group;
      if (!assigned.has('receiver') && normZ >= 0.3 && normZ <= 0.7 && comp.vol === compData[0].vol) {
        group = 'receiver';
      } else if (normZ > 0.6 && isThin) {
        group = 'barrel';
      } else if (normZ < 0.2) {
        group = 'stock';
      } else if (normY < 0.3 && comp.vol < avgVolume * comp.indices.length * 0.5) {
        group = yExtent > zExtent ? 'grip' : 'magazine';
      } else if (normY > 0.7 && comp.vol < compData[0].vol * 0.2) {
        group = 'optic_rail';
      } else {
        group = 'body';
      }

      assigned.add(group);
      for (const i of comp.indices) {
        primitives[i].group = group;
      }
    }
  }

  // Post-pass: ensure at least one receiver
  const hasReceiver = primitives.some(p => p.group === 'receiver');
  if (!hasReceiver) {
    let best = null, bestVol = 0;
    for (const p of primitives) {
      const normZ = zRange > 0 ? (p.pos[2] - minZ) / zRange : 0.5;
      if (normZ >= 0.25 && normZ <= 0.75) {
        const v = primVolume(p);
        if (v > bestVol) { bestVol = v; best = p; }
      }
    }
    if (best) best.group = 'receiver';
  }
}

function primVolume(p) {
  return p.scale[0] * p.scale[1] * p.scale[2];
}

// ─── COLOR QUANTIZATION ─────────────────────────────────────────────────────

const WEAPON_PALETTE = ['#3a3a3a', '#2a2a2a', '#3d3530', '#5a5a5a', '#2e2e2e', '#1a3a4a', '#4a4a3a', '#2a2a20'];
const VEHICLE_PALETTE = ['#3a3a3a', '#2a2a2a', '#4a4a3a', '#5a5a5a', '#3d3530', '#2e3440'];
const FURNITURE_PALETTE = ['#3d3530', '#5a4a3a', '#3a3a3a', '#6a5a4a', '#2a2a2a'];

function loadPalette(name) {
  if (name === 'weapon') return WEAPON_PALETTE;
  if (name === 'vehicle') return VEHICLE_PALETTE;
  if (name === 'furniture') return FURNITURE_PALETTE;
  // Try loading as JSON file
  try {
    const data = readFileSync(resolve(name), 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error(`Warning: Could not load palette "${name}", using weapon palette`);
    return WEAPON_PALETTE;
  }
}

function quantizeColor(hex, palette) {
  const c = hexToRGB(hex);
  let bestDist = Infinity;
  let bestColor = palette[0];
  for (const p of palette) {
    const pc = hexToRGB(p);
    const dist = (c[0] - pc[0]) ** 2 + (c[1] - pc[1]) ** 2 + (c[2] - pc[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestColor = p;
    }
  }
  return bestColor;
}

// ─── BAKED AMBIENT OCCLUSION ────────────────────────────────────────────────

// ─── OVERLAP RESOLUTION ───────────────────────────────────────────────────────

// Fix z-fighting by nudging only near-coplanar faces.
// Only acts when two faces are within EPSILON of each other (actual z-fight zone).
// Shrinks the SMALLER box inward by a tiny amount — never creates gaps.
function resolveOverlaps(primitives) {
  const EPS = 0.05; // cm — faces closer than this cause z-fighting
  const NUDGE = 0.04; // cm — how much to shrink the smaller box's face
  let resolved = 0;

  for (let i = 0; i < primitives.length; i++) {
    const a = primitives[i];
    for (let j = i + 1; j < primitives.length; j++) {
      const b = primitives[j];

      // Check all 3 axes for near-coplanar opposing faces
      for (let ax = 0; ax < 3; ax++) {
        const aMin = a.pos[ax] - a.scale[ax] / 2;
        const aMax = a.pos[ax] + a.scale[ax] / 2;
        const bMin = b.pos[ax] - b.scale[ax] / 2;
        const bMax = b.pos[ax] + b.scale[ax] / 2;

        // Check if the boxes actually overlap on the other two axes
        // (otherwise the faces aren't visible together)
        const otherAxes = [0, 1, 2].filter(x => x !== ax);
        let facesVisible = true;
        for (const oa of otherAxes) {
          const a0 = a.pos[oa] - a.scale[oa] / 2;
          const a1 = a.pos[oa] + a.scale[oa] / 2;
          const b0 = b.pos[oa] - b.scale[oa] / 2;
          const b1 = b.pos[oa] + b.scale[oa] / 2;
          if (a1 <= b0 || b1 <= a0) { facesVisible = false; break; }
        }
        if (!facesVisible) continue;

        // Case 1: a's max face ≈ b's min face
        if (Math.abs(aMax - bMin) < EPS) {
          // Shrink the smaller primitive inward
          const volA = a.scale[0] * a.scale[1] * a.scale[2];
          const volB = b.scale[0] * b.scale[1] * b.scale[2];
          if (volA <= volB) {
            a.scale[ax] = Math.max(0.05, a.scale[ax] - NUDGE);
            a.pos[ax] -= NUDGE / 2;
          } else {
            b.scale[ax] = Math.max(0.05, b.scale[ax] - NUDGE);
            b.pos[ax] += NUDGE / 2;
          }
          resolved++;
        }
        // Case 2: b's max face ≈ a's min face
        else if (Math.abs(bMax - aMin) < EPS) {
          const volA = a.scale[0] * a.scale[1] * a.scale[2];
          const volB = b.scale[0] * b.scale[1] * b.scale[2];
          if (volB <= volA) {
            b.scale[ax] = Math.max(0.05, b.scale[ax] - NUDGE);
            b.pos[ax] -= NUDGE / 2;
          } else {
            a.scale[ax] = Math.max(0.05, a.scale[ax] - NUDGE);
            a.pos[ax] += NUDGE / 2;
          }
          resolved++;
        }
      }
    }
  }

  if (resolved > 0) console.error(`  Resolved ${resolved} near-coplanar face pairs`);
}

function aabbOverlap(a, b, margin) {
  for (let i = 0; i < 3; i++) {
    const aMin = a.pos[i] - a.scale[i] / 2 - margin;
    const aMax = a.pos[i] + a.scale[i] / 2 + margin;
    const bMin = b.pos[i] - b.scale[i] / 2;
    const bMax = b.pos[i] + b.scale[i] / 2;
    if (aMax < bMin || aMin > bMax) return false;
  }
  return true;
}

// Face directions: +X, -X, +Y, -Y, +Z, -Z
const FACE_DIRS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

function bakeAO(primitives) {
  const probeDistance = 2.0; // cm — how far to probe for occluders

  for (const prim of primitives) {
    const ao = [1, 1, 1, 1, 1, 1]; // per-face brightness: +X -X +Y -Y +Z -Z

    for (let f = 0; f < 6; f++) {
      const dir = FACE_DIRS[f];
      const axis = f >> 1; // 0=X, 1=Y, 2=Z
      const sign = (f & 1) === 0 ? 1 : -1;

      // Face center = prim center + half-extent along face normal
      const faceCenter = [prim.pos[0], prim.pos[1], prim.pos[2]];
      faceCenter[axis] += sign * prim.scale[axis] / 2;

      // Count how many other primitives occlude this face
      let occlusion = 0;
      for (const other of primitives) {
        if (other === prim) continue;

        // Check if the other primitive's AABB is in front of this face
        // within probeDistance
        const oMin = other.pos[axis] - other.scale[axis] / 2;
        const oMax = other.pos[axis] + other.scale[axis] / 2;

        // Is the other prim on the correct side of this face?
        if (sign > 0 && oMin > faceCenter[axis] + probeDistance) continue;
        if (sign > 0 && oMax < faceCenter[axis]) continue;
        if (sign < 0 && oMax < faceCenter[axis] - probeDistance) continue;
        if (sign < 0 && oMin > faceCenter[axis]) continue;

        // Check overlap on the other two axes (does the other prim cover this face?)
        const otherAxes = [0, 1, 2].filter(a => a !== axis);
        let covers = true;
        for (const oa of otherAxes) {
          const fMin = prim.pos[oa] - prim.scale[oa] / 2;
          const fMax = prim.pos[oa] + prim.scale[oa] / 2;
          const oaMin = other.pos[oa] - other.scale[oa] / 2;
          const oaMax = other.pos[oa] + other.scale[oa] / 2;
          if (oaMax <= fMin || oaMin >= fMax) { covers = false; break; }
        }
        if (covers) occlusion++;
      }

      // 0 occluders = 1.0, 1 = 0.80, 2 = 0.70, 3+ = 0.65
      ao[f] = occlusion === 0 ? 1.0 :
              occlusion === 1 ? 0.80 :
              occlusion === 2 ? 0.70 : 0.65;
    }

    prim._ao = ao;
  }
}

// ─── OUTPUT ──────────────────────────────────────────────────────────────────

function roundArr(arr, decimals) {
  const f = Math.pow(10, decimals);
  return arr.map(v => Math.round(v * f) / f);
}

function buildRecipe(primitives, category, archetype, inputName, normInfo) {
  const name = inputName || 'unnamed';

  const recipePrimitives = primitives.map((p, i) => {
    const { _color, _ao, ...rest } = p;
    const out = {
      id: `${p.group || 'part'}_${i}`,
      group: p.group || 'cosmetic',
      type: p.type,
      pos: roundArr(p.pos, 2),
      rot: roundArr(p.rot, 1),
      scale: roundArr(p.scale, 2),
      color: _color || GROUP_COLORS[p.group] || '#3a3a3a',
    };
    if (_ao) out.ao = roundArr(_ao, 2);
    return out;
  });

  const recipe = {
    name,
    category,
    version: 1,
    units: 'cm',
    origin: 'receiver_center',
    primitives: recipePrimitives,
  };

  if (category === 'weapon') {
    recipe.archetype = archetype;
    recipe.attachmentPoints = {};
    recipe.viewmodel = {
      scale: 1.0,
      pos: [12, -10, -15],
      rot: [0, 0, 0],
    };
    recipe.worldmodel = {
      scale: 0.4,
    };
  }

  // Store the source transform so the editor can align the original reference model
  // to match the decomposed recipe orientation.
  if (normInfo) {
    recipe.sourceTransform = {
      centroid: roundArr(normInfo.centroid, 6),
      rotation: normInfo.rotation,
      scaleFactor: Math.round(normInfo.scaleFactor * 1e6) / 1e6,
    };
  }

  return recipe;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  console.error(`Loading: ${opts.input}`);
  const meshData = await loadMesh(opts.input);
  const { positions, indices } = meshData;
  console.error(`Loaded: ${positions.length / 3} vertices, ${indices.length / 3} triangles`);

  console.error('Normalizing...');
  const normInfo = normalizeMesh(positions, opts.normalizeSize, [opts.rotateX, opts.rotateY, opts.rotateZ]);
  console.error(`Scale factor: ${normInfo.scaleFactor.toFixed(6)}`);
  console.error(`Normalized bbox: X[${normInfo.bbox.min[0].toFixed(2)}, ${normInfo.bbox.max[0].toFixed(2)}] Y[${normInfo.bbox.min[1].toFixed(2)}, ${normInfo.bbox.max[1].toFixed(2)}] Z[${normInfo.bbox.min[2].toFixed(2)}, ${normInfo.bbox.max[2].toFixed(2)}]`);
  console.error(`Normalized extents: X=${(normInfo.bbox.max[0]-normInfo.bbox.min[0]).toFixed(2)} Y=${(normInfo.bbox.max[1]-normInfo.bbox.min[1]).toFixed(2)} Z=${(normInfo.bbox.max[2]-normInfo.bbox.min[2]).toFixed(2)}`);

  // V-HACD oversegmentation
  console.error(`V-HACD: maxHulls=${opts.maxHulls}, resolution=${opts.vhacdResolution}`);
  const hulls = await vhacdDecompose(positions, indices, opts);
  console.error(`V-HACD produced ${hulls.length} convex hulls`);

  // Fit an AABB primitive to each hull
  let primitives = hulls.map(hull => fitPrimitive(hull.positions));
  primitives = primitives.filter(p => p !== null);
  console.error(`Fitted ${primitives.length} primitives`);

  // Sample colors from source mesh
  const hasColorData = meshData.vertexColors || meshData.materials;
  if (hasColorData) {
    console.error('Sampling colors from source mesh...');
    const triGrid = buildTriangleIndex(positions, indices, 2.0);
    for (const prim of primitives) {
      prim._color = computePrimitiveColor(prim, triGrid, 2.0, meshData);
    }
    const colored = primitives.filter(p => p._color).length;
    console.error(`Colored ${colored}/${primitives.length} primitives from source`);
  }

  // Z-position fallback for primitives without color
  for (const prim of primitives) {
    if (!prim._color) {
      prim._color = assignPositionColor(prim, normInfo.bbox);
    }
  }

  // Build adjacency graph and merge down to budget
  if (!opts.noMerge && primitives.length > opts.budget) {
    console.error(`Merging ${primitives.length} → ${opts.budget}...`);
    const adjacency = buildAdjacency(primitives, 0.5);
    primitives = mergeDown(primitives, adjacency, opts.budget, opts.mergeMaxVolume, opts.mergeMaxAspect);
    console.error(`After merge: ${primitives.length} primitives`);
  }

  // Color quantization
  if (opts.quantize) {
    console.error('Quantizing colors...');
    const palette = loadPalette(opts.palette);
    for (const prim of primitives) {
      if (prim._color) prim._color = quantizeColor(prim._color, palette);
    }
  }

  // Baked ambient occlusion
  if (opts.bakeAO) {
    console.error('Baking ambient occlusion...');
    bakeAO(primitives);
  }

  // Auto-group (before cleanup strips _vertices needed for adjacency)
  autoGroup(primitives, opts.category);

  // Post-merge cleanup: re-fit, filter small, strip internals
  primitives = postMergeCleanup(primitives, opts.minVolume);
  console.error(`After cleanup: ${primitives.length} primitives`);

  // Resolve overlapping AABBs to prevent z-fighting
  resolveOverlaps(primitives);

  // Extract name from filename
  const inputName = opts.input.replace(/\\/g, '/').split('/').pop().replace(/\.(glb|gltf|obj)$/i, '');
  const recipe = buildRecipe(primitives, opts.category, opts.archetype, inputName, normInfo);

  const json = JSON.stringify(recipe, null, 2);

  if (opts.output) {
    writeFileSync(resolve(opts.output), json, 'utf8');
    console.error(`Written: ${opts.output}`);
  } else {
    process.stdout.write(json + '\n');
  }

}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
