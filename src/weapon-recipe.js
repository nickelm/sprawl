// ─── WEAPON RECIPE: Schema Validation + Runtime Loader ───────────────────────
//
// JSON recipe format for procedural weapon models.
// Recipes define weapons as arrays of positioned primitives (boxes, cylinders)
// with attachment points, viewmodel/worldmodel settings.
// Units: centimeters in recipe, converted to meters at build time.

import * as THREE from 'three';

const DEG2RAD = Math.PI / 180;

// ─── SCHEMA CONSTANTS ────────────────────────────────────────────────────────

export const VALID_ARCHETYPES = [
  'pistol', 'revolver', 'smg', 'carbine', 'ar',
  'battle_rifle', 'lmg', 'dmr', 'sniper', 'shotgun'
];

export const VALID_GROUPS = [
  'receiver', 'barrel', 'stock', 'magazine', 'muzzle',
  'underbarrel', 'optic_rail', 'grip', 'trigger_guard', 'cosmetic', 'body'
];

export const VALID_TYPES = ['box', 'cylinder'];

export const VALID_ATTACHMENT_POINTS = [
  'muzzle', 'optic_rail', 'underbarrel', 'magazine', 'stock'
];

// ─── VALIDATION ──────────────────────────────────────────────────────────────

function isArray3(v) {
  return Array.isArray(v) && v.length === 3 &&
    v.every(n => typeof n === 'number' && isFinite(n));
}

function isPositiveArray3(v) {
  return isArray3(v) && v.every(n => n > 0);
}

function isHexColor(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}

/**
 * Validate a recipe JSON object.
 * @param {object} recipe
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRecipe(recipe) {
  const errors = [];

  if (!recipe || typeof recipe !== 'object') {
    return { valid: false, errors: ['Recipe must be a non-null object'] };
  }

  // Top-level required fields
  if (typeof recipe.name !== 'string' || !recipe.name) {
    errors.push('Missing or invalid "name" (string)');
  }
  if (!VALID_ARCHETYPES.includes(recipe.archetype)) {
    errors.push(`Invalid "archetype": "${recipe.archetype}". Must be one of: ${VALID_ARCHETYPES.join(', ')}`);
  }
  if (!Number.isInteger(recipe.version) || recipe.version < 1) {
    errors.push('Missing or invalid "version" (integer >= 1)');
  }
  if (recipe.units !== 'cm') {
    errors.push('Missing or invalid "units" (must be "cm")');
  }
  if (!Array.isArray(recipe.primitives) || recipe.primitives.length === 0) {
    errors.push('Missing or empty "primitives" array');
    return { valid: false, errors };
  }

  // Primitives
  const ids = new Set();
  for (let i = 0; i < recipe.primitives.length; i++) {
    const p = recipe.primitives[i];
    const prefix = `primitives[${i}]`;

    if (typeof p.id !== 'string' || !p.id) {
      errors.push(`${prefix}: missing or invalid "id"`);
    } else if (ids.has(p.id)) {
      errors.push(`${prefix}: duplicate id "${p.id}"`);
    } else {
      ids.add(p.id);
    }

    if (!VALID_GROUPS.includes(p.group)) {
      errors.push(`${prefix}: invalid "group" "${p.group}"`);
    }
    if (!VALID_TYPES.includes(p.type)) {
      errors.push(`${prefix}: invalid "type" "${p.type}"`);
    }
    if (!isArray3(p.pos)) {
      errors.push(`${prefix}: "pos" must be [x, y, z]`);
    }
    if (!isArray3(p.rot)) {
      errors.push(`${prefix}: "rot" must be [rx, ry, rz]`);
    }
    if (!isPositiveArray3(p.scale)) {
      errors.push(`${prefix}: "scale" must be [sx, sy, sz] with positive values`);
    }
    if (!isHexColor(p.color)) {
      errors.push(`${prefix}: "color" must be hex string like "#3a3a3a"`);
    }
  }

  // Attachment points (optional)
  if (recipe.attachmentPoints && typeof recipe.attachmentPoints === 'object') {
    for (const [name, point] of Object.entries(recipe.attachmentPoints)) {
      if (!isArray3(point.pos)) {
        errors.push(`attachmentPoints.${name}: "pos" must be [x, y, z]`);
      }
      if (!isArray3(point.dir)) {
        errors.push(`attachmentPoints.${name}: "dir" must be [x, y, z]`);
      } else if (point.dir[0] === 0 && point.dir[1] === 0 && point.dir[2] === 0) {
        errors.push(`attachmentPoints.${name}: "dir" must be non-zero`);
      }
    }
  }

  // Viewmodel (optional)
  if (recipe.viewmodel) {
    const vm = recipe.viewmodel;
    if (vm.scale !== undefined && (typeof vm.scale !== 'number' || vm.scale <= 0)) {
      errors.push('viewmodel.scale must be a positive number');
    }
    if (vm.pos !== undefined && !isArray3(vm.pos)) {
      errors.push('viewmodel.pos must be [x, y, z]');
    }
    if (vm.rot !== undefined && !isArray3(vm.rot)) {
      errors.push('viewmodel.rot must be [rx, ry, rz]');
    }
  }

  // Worldmodel (optional)
  if (recipe.worldmodel) {
    if (recipe.worldmodel.scale !== undefined &&
        (typeof recipe.worldmodel.scale !== 'number' || recipe.worldmodel.scale <= 0)) {
      errors.push('worldmodel.scale must be a positive number');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── MATERIAL CACHE ──────────────────────────────────────────────────────────

const recipeMatCache = {};
function getRecipeMat(hexColor, needsVertexColors) {
  const key = hexColor + (needsVertexColors ? '_vc' : '');
  if (!recipeMatCache[key]) {
    recipeMatCache[key] = new THREE.MeshPhongMaterial({
      color: needsVertexColors ? 0xffffff : hexColor,
      flatShading: true,
      vertexColors: needsVertexColors || false,
    });
  }
  return recipeMatCache[key];
}

// Apply per-face AO as vertex colors on a BoxGeometry.
// ao = [+X, -X, +Y, -Y, +Z, -Z] brightness factors (0-1).
// Three.js BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z (6 faces, 2 tris each, 6 verts each).
function applyBoxAO(geometry, ao, baseColor) {
  const color = new THREE.Color(baseColor);
  const count = geometry.getAttribute('position').count; // 24 verts for a box
  const colors = new Float32Array(count * 3);

  // BoxGeometry groups: 6 groups of 6 indices each (2 triangles per face)
  // Group order: +X(0), -X(1), +Y(2), -Y(3), +Z(4), -Z(5)
  const groups = geometry.groups;
  for (let g = 0; g < groups.length; g++) {
    const factor = ao[g] !== undefined ? ao[g] : 1.0;
    const r = color.r * factor;
    const gv = color.g * factor;
    const b = color.b * factor;

    const indices = geometry.getIndex();
    const start = groups[g].start;
    const gCount = groups[g].count;
    for (let i = start; i < start + gCount; i++) {
      const vi = indices ? indices.getX(i) : i;
      colors[vi * 3] = r;
      colors[vi * 3 + 1] = gv;
      colors[vi * 3 + 2] = b;
    }
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// ─── RUNTIME LOADER ──────────────────────────────────────────────────────────

/**
 * Build a THREE.Group from a weapon recipe JSON.
 *
 * @param {object} recipe - Recipe JSON object (units in cm)
 * @param {object} [options]
 * @param {string} [options.mode] - 'viewmodel' | 'worldmodel' | undefined (raw)
 * @param {boolean} [options.validate] - Run validation first (default: true)
 * @returns {THREE.Group}
 */
export function buildWeaponFromRecipe(recipe, options = {}) {
  // Optional validation
  if (options.validate !== false) {
    const result = validateRecipe(recipe);
    if (!result.valid) {
      console.warn('Recipe validation warnings:', result.errors);
    }
  }

  const group = new THREE.Group();
  group.name = recipe.name || 'unnamed';

  // cm → m conversion factor
  const S = 1 / 100;

  for (const prim of recipe.primitives) {
    let geometry;

    // Per-face AO: ao is [+X, -X, +Y, -Y, +Z, -Z] array (boxes only)
    // Scalar AO: ao is a single number 0.0-1.0 (any primitive)
    const hasFaceAO = prim.type === 'box' && Array.isArray(prim.ao) && prim.ao.length === 6;
    const hasScalarAO = typeof prim.ao === 'number' && prim.ao < 1.0;

    if (prim.type === 'box') {
      geometry = new THREE.BoxGeometry(
        prim.scale[0] * S,
        prim.scale[1] * S,
        prim.scale[2] * S
      );
      if (hasFaceAO) {
        applyBoxAO(geometry, prim.ao, prim.color || '#3a3a3a');
      }
    } else if (prim.type === 'cylinder') {
      // scale: [radius, radius, height]
      // CylinderGeometry default axis is Y; recipe rot handles orientation
      geometry = new THREE.CylinderGeometry(
        prim.scale[0] * S,  // radiusTop
        prim.scale[0] * S,  // radiusBottom
        prim.scale[2] * S,  // height
        8                    // segments — low-poly
      );
    } else {
      continue; // unknown type, skip
    }

    // Scalar AO: darken base color uniformly (0.7 at full occlusion, 1.0 at none)
    let colorHex = prim.color || '#3a3a3a';
    if (hasScalarAO) {
      const darken = 0.7 + 0.3 * (1.0 - prim.ao);
      const c = new THREE.Color(colorHex).multiplyScalar(darken);
      colorHex = '#' + c.getHexString();
    }
    const material = getRecipeMat(colorHex, hasFaceAO);
    const mesh = new THREE.Mesh(geometry, material);

    // Position (cm → m)
    mesh.position.set(
      prim.pos[0] * S,
      prim.pos[1] * S,
      prim.pos[2] * S
    );

    // Rotation (degrees → radians)
    if (prim.rot) {
      mesh.rotation.set(
        prim.rot[0] * DEG2RAD,
        prim.rot[1] * DEG2RAD,
        prim.rot[2] * DEG2RAD
      );
    }

    mesh.name = prim.id;
    mesh.userData.id = prim.id;
    mesh.userData.group = prim.group;

    group.add(mesh);
  }

  // Store attachment points (converted to meters)
  if (recipe.attachmentPoints) {
    group.userData.attachmentPoints = {};
    for (const [name, point] of Object.entries(recipe.attachmentPoints)) {
      group.userData.attachmentPoints[name] = {
        pos: point.pos.map(v => v * S),
        dir: [...point.dir]
      };
    }
  }

  // Apply viewmodel or worldmodel scaling
  if (options.mode === 'viewmodel' && recipe.viewmodel) {
    const vm = recipe.viewmodel;
    if (vm.scale) group.scale.setScalar(vm.scale);
    if (vm.pos) group.position.set(vm.pos[0] * S, vm.pos[1] * S, vm.pos[2] * S);
    if (vm.rot) group.rotation.set(
      vm.rot[0] * DEG2RAD,
      vm.rot[1] * DEG2RAD,
      vm.rot[2] * DEG2RAD
    );
  } else if (options.mode === 'worldmodel' && recipe.worldmodel) {
    if (recipe.worldmodel.scale) group.scale.setScalar(recipe.worldmodel.scale);
  }

  // Store recipe metadata
  group.userData.recipe = recipe;

  return group;
}
