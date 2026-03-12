// ─── GUN WORKBENCH ─────────────────────────────────────────────
// Real-time 3D weapon viewer & editor.
// Standalone mode: design tool with geometry sliders.
// Game mode: loadout screen during wave intermissions.

import * as THREE from 'three';
import { WEAPON_DEFS, ALL_WEAPONS, computeStats, ATTACHMENT_DEFS, OPTIC_DEFS } from './weaponDefs.js';

// ─── LOCAL GEOMETRY HELPERS ─────────────────────────────────
// Duplicated from weaponView.js to avoid importing the full game
// dependency chain (renderer.js → DOM) in standalone mode.

const wbMatCache = {};
function getMat(color) {
  if (!wbMatCache[color]) {
    wbMatCache[color] = new THREE.MeshPhongMaterial({ color, flatShading: true });
  }
  return wbMatCache[color];
}

function createWedgeGeometry(size) {
  const [w, h, d] = size;
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const vertices = new Float32Array([
    // front face — normal -Z
    hw, -hh, -hd,  -hw, -hh, -hd,  0, hh, -hd,
    // back face — normal +Z
    -hw, -hh, hd,   hw, -hh, hd,   0, hh, hd,
    // bottom face — normal -Y
    -hw, -hh, -hd,  hw, -hh, -hd,   hw, -hh, hd,
    -hw, -hh, -hd,  hw, -hh, hd,   -hw, -hh, hd,
    // left face — normal -X
    -hw, -hh, -hd, -hw, -hh, hd,    0, hh, hd,
    -hw, -hh, -hd,  0, hh, hd,      0, hh, -hd,
    // right face — normal +X
    hw, -hh, hd,    hw, -hh, -hd,   0, hh, -hd,
    hw, -hh, hd,    0, hh, -hd,     0, hh, hd,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

function createPyramidGeometry(size) {
  const [w, h, d] = size;
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const vertices = new Float32Array([
    -hw, -hh, hd,   hw, -hh, hd,   hw, hh, hd,
    -hw, -hh, hd,   hw, hh, hd,   -hw, hh, hd,
    0, 0, -hd,      hw, -hh, hd,  -hw, -hh, hd,
    0, 0, -hd,     -hw, hh, hd,    hw, hh, hd,
    0, 0, -hd,     -hw, -hh, hd,  -hw, hh, hd,
    0, 0, -hd,      hw, hh, hd,    hw, -hh, hd,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

function buildWeaponMesh(defKey) {
  const def = WEAPON_DEFS[defKey];
  const group = new THREE.Group();
  for (const [role, part] of Object.entries(def.parts)) {
    let mesh;
    if (part.radius !== undefined) {
      const geo = new THREE.CylinderGeometry(part.radius, part.radius, part.length, part.segments || 8);
      geo.rotateX(Math.PI / 2);
      mesh = new THREE.Mesh(geo, getMat(part.color));
    } else if (part.type === 'wedge') {
      mesh = new THREE.Mesh(createWedgeGeometry(part.size), getMat(part.color));
    } else if (part.type === 'pyramid') {
      mesh = new THREE.Mesh(createPyramidGeometry(part.size), getMat(part.color));
    } else {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(...part.size), getMat(part.color));
    }
    mesh.position.set(...part.pos);
    if (part.rot) mesh.rotation.set(...part.rot);
    mesh.name = role;
    group.add(mesh);
  }
  return group;
}

// ─── DEFAULT COLORS (matches weaponDefs.js C palette) ───────
const DEFAULT_COLORS = {
  receiver: 0x3a3a3a,
  barrel:   0x2a2a2a,
  stock:    0x3d3530,
  magazine: 0x3a3a3a,
  accent:   0x5a5a5a,
};

// Map part role names → color category
const ROLE_COLOR_MAP = {
  body: 'receiver', receiver: 'receiver', handguard: 'receiver',
  slide: 'receiver', gasBlock: 'receiver',
  barrel: 'barrel',
  stock: 'stock', grip: 'stock', cheekRest: 'stock',
  stockTube: 'stock', stockArm: 'stock', stockArmT: 'stock', stockArmB: 'stock',
  stockEnd: 'stock', stockPad: 'stock',
  magazine: 'magazine', boxMag: 'magazine', drum: 'magazine',
  rail: 'accent', carryHandle: 'accent', accent: 'accent',
  trigger: 'accent', hammer: 'accent', boltHandle: 'accent',
  pumpSlide: 'accent',
  sightRearL: 'accent', sightRearR: 'accent', sightFront: 'accent',
  cylinder: 'accent', scope: 'accent',
};

// ─── STAT DISPLAY CONFIG ────────────────────────────────────
const STAT_LABELS = {
  damage: 'DAMAGE', penetration: 'PENETRATION', rateOfFire: 'FIRE RATE',
  magSize: 'MAG SIZE', reloadTime: 'RELOAD', adsTime: 'ADS TIME',
  moveSpeed: 'MOVE SPEED', adsSpeed: 'ADS SPEED',
  'spread.hip': 'HIP SPREAD', 'spread.ads': 'ADS SPREAD',
  range: 'RANGE', headshotMult: 'HS MULT', weight: 'WEIGHT',
};

// Stats where lower is better
const LOWER_IS_BETTER = new Set([
  'reloadTime', 'adsTime', 'spread.hip', 'spread.ads', 'weight',
]);

// ─── GEOMETRY SLIDER DEFS ───────────────────────────────────
const SLIDER_DEFS = [
  { label: 'Barrel Length', part: 'barrel', prop: 'length', min: 0.08, max: 0.80, step: 0.01 },
  { label: 'Barrel Radius', part: 'barrel', prop: 'radius', min: 0.008, max: 0.05, step: 0.001 },
  { label: 'Receiver Length', part: 'body', prop: 'size.2', min: 0.10, max: 0.70, step: 0.01 },
  { label: 'Receiver Height', part: 'body', prop: 'size.1', min: 0.06, max: 0.25, step: 0.01 },
  { label: 'Receiver Width', part: 'body', prop: 'size.0', min: 0.04, max: 0.20, step: 0.01 },
  { label: 'Stock Length', part: 'stock', prop: 'size.2', min: 0.05, max: 0.40, step: 0.01 },
  { label: 'Stock Height', part: 'stock', prop: 'size.1', min: 0.04, max: 0.16, step: 0.01 },
  { label: 'Magazine Length', part: 'magazine', prop: 'size.1', min: 0.04, max: 0.30, step: 0.01 },
  { label: 'Magazine Width', part: 'magazine', prop: 'size.2', min: 0.02, max: 0.12, step: 0.01 },
];

// ─── MODULE STATE ───────────────────────────────────────────
let wb = {
  active: false,
  mode: 'standalone', // 'standalone' | 'game'
  devMode: false,

  // 3D
  scene: null,
  camera: null,
  renderer: null,
  weaponGroup: null,
  gridHelper: null,

  // Orbit
  theta: 0.3,
  phi: 1.0,
  radius: 1.2,
  isDragging: false,
  dragStart: { x: 0, y: 0, theta: 0, phi: 0 },
  idleTimer: 0,

  // Weapon state
  selectedWeapon: 'carbine',
  attachments: { muzzle: null, barrel: null, underbarrel: null, stock: 'skeleton_stock', magazine: null, optic: 'iron_sights', accessory: null },
  colors: { ...DEFAULT_COLORS },
  geometryOverrides: {},

  // Display
  showGrid: true,
  turntable: true,
  wireframe: false,

  // Game mode
  loadout: null,
  activeSlot: 'primary',
  slotData: {
    primary:   { weapon: 'carbine', attachments: { muzzle: null, barrel: null, underbarrel: null, stock: 'skeleton_stock', magazine: null, optic: 'iron_sights', accessory: null }, colors: { ...DEFAULT_COLORS } },
    secondary: { weapon: 'pistol',  attachments: { muzzle: null, barrel: null, underbarrel: null, stock: null, magazine: null, optic: 'iron_sights', accessory: null }, colors: { ...DEFAULT_COLORS } },
  },
  onConfirm: null,
  onCancel: null,
  available: null, // available weapons/attachments (game mode)

  // DOM
  overlay: null,
  canvas: null,
  abortCtrl: null,

  // Animation
  animId: null,
  lastTime: 0,
};

// ─── 3D SCENE SETUP ─────────────────────────────────────────

function createWBScene() {
  wb.scene = new THREE.Scene();
  wb.scene.background = new THREE.Color(0x1a1a22);

  // Ambient
  wb.scene.add(new THREE.AmbientLight(0x404050, 0.6));

  // Key light — warm, upper-right
  const key = new THREE.DirectionalLight(0xfff0dd, 0.8);
  key.position.set(2, 3, 1);
  wb.scene.add(key);

  // Fill light — cool, from left
  const fill = new THREE.DirectionalLight(0xaabbdd, 0.3);
  fill.position.set(-2, 1, 0);
  wb.scene.add(fill);

  // Rim — orange accent, from behind
  const rim = new THREE.DirectionalLight(0xf39c12, 0.2);
  rim.position.set(0, 1, 3);
  wb.scene.add(rim);

  // Grid
  wb.gridHelper = new THREE.GridHelper(4, 20, 0x333340, 0x222230);
  wb.gridHelper.position.y = -0.3;
  wb.scene.add(wb.gridHelper);
}

function createWBCamera() {
  wb.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  updateOrbitCamera();
}

function updateOrbitCamera() {
  const { theta, phi, radius } = wb;
  wb.camera.position.set(
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.cos(theta),
  );
  wb.camera.lookAt(0, 0, 0);
}

// ─── ORBIT CONTROLS ─────────────────────────────────────────

function attachOrbitControls(canvas) {
  wb.abortCtrl = new AbortController();
  const sig = { signal: wb.abortCtrl.signal };

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    wb.isDragging = true;
    wb.dragStart = { x: e.clientX, y: e.clientY, theta: wb.theta, phi: wb.phi };
    wb.idleTimer = 0;
  }, sig);

  window.addEventListener('mousemove', (e) => {
    if (!wb.isDragging) return;
    const dx = e.clientX - wb.dragStart.x;
    const dy = e.clientY - wb.dragStart.y;
    wb.theta = wb.dragStart.theta - dx * 0.008;
    wb.phi = Math.max(0.2, Math.min(Math.PI - 0.2, wb.dragStart.phi - dy * 0.008));
    wb.idleTimer = 0;
    updateOrbitCamera();
  }, sig);

  window.addEventListener('mouseup', () => {
    wb.isDragging = false;
  }, sig);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    wb.radius = Math.max(0.5, Math.min(4.0, wb.radius + e.deltaY * 0.002));
    wb.idleTimer = 0;
    updateOrbitCamera();
  }, { ...sig, passive: false });
}

function detachOrbitControls() {
  if (wb.abortCtrl) {
    wb.abortCtrl.abort();
    wb.abortCtrl = null;
  }
}

// ─── ATTACHMENT GEOMETRY ──────────────────────────────────────

const ATTACHMENT_GEOMETRY = {
  // Muzzle
  suppressor:   { mount: 'muzzle', parts: [
    { radius: 0.022, length: 0.12, segments: 8, color: 0x2a2a2a, offset: [0, 0, -0.06] },
  ]},
  compensator:  { mount: 'muzzle', parts: [
    { size: [0.035, 0.035, 0.04], color: 0x3a3a3a, offset: [0, 0, -0.02] },
  ]},
  flash_hider:  { mount: 'muzzle', parts: [
    // Triangular cross-section (3-sided cylinder)
    { radius: 0.018, length: 0.05, segments: 3, color: 0x2a2a2a, offset: [0, 0, -0.025] },
  ]},
  muzzle_brake: { mount: 'muzzle', parts: [
    { size: [0.04, 0.03, 0.04], color: 0x3a3a3a, offset: [0, 0, -0.02] },
  ]},
  // Barrel — modifies actual barrel mesh scale
  long_barrel:  { mount: 'barrel_mod', barrelScale: [1.0, 1.0, 1.25], parts: [] },
  short_barrel: { mount: 'barrel_mod', barrelScale: [1.0, 1.0, 0.7], parts: [] },
  heavy_barrel: { mount: 'barrel_mod', barrelScale: [1.4, 1.4, 1.0], parts: [] },
  // Underbarrel
  vertical_grip: { mount: 'underbarrel', parts: [
    { size: [0.03, 0.08, 0.03], color: 0x4a3728, offset: [0, -0.04, 0] },
  ]},
  angled_grip:   { mount: 'underbarrel', parts: [
    // Angles forward (positive X rot = top tilts toward muzzle)
    { size: [0.03, 0.07, 0.03], color: 0x4a3728, offset: [0, -0.035, -0.015], rot: [0.4, 0, 0] },
  ]},
  stubby_grip:   { mount: 'underbarrel', parts: [
    { type: 'sphere', radius: 0.025, segments: 8, color: 0x4a3728, offset: [0, -0.025, 0] },
  ]},
  bipod:         { mount: 'barrel_under', parts: [
    // Folded legs along barrel, splayed slightly outward
    { radius: 0.006, length: 0.14, segments: 6, color: 0x2a2a2a, offset: [-0.015, -0.008, -0.07] },
    { radius: 0.006, length: 0.14, segments: 6, color: 0x2a2a2a, offset: [0.015, -0.008, -0.07] },
    // Pivot block attaching to body
    { size: [0.04, 0.015, 0.02], color: 0x2a2a2a, offset: [0, -0.005, 0] },
  ]},
  // Magazine
  extended_mag: { mount: 'mag_bottom', parts: [
    // Visible baseplate extension matching magazine width
    { size: [0.05, 0.04, 0.04], color: 0x3a3a3a, offset: [0, -0.02, 0] },
  ]},
  fast_mag:     { mount: 'mag_bottom', parts: [
    // Orange pull tab on magazine base
    { size: [0.015, 0.025, 0.035], color: 0xf39c12, offset: [0, -0.005, 0.02] },
  ]},
  drum_mag:     { mount: 'mag_replace', parts: [
    { radius: 0.07, length: 0.08, segments: 12, color: 0x3a3a3a, offset: [0, -0.05, 0] },
  ]},
  // Stock
  full_stock:   { mount: 'stock', parts: [
    // Pyramid: apex overlaps into body rear, base (shoulder) extends out
    { type: 'pyramid', size: [0.07, 0.09, 0.24], color: 0x3d3530, offset: [0, 0, 0.08] },
    { size: [0.07, 0.09, 0.015], color: 0x1a1a1a, offset: [0, 0, 0.20] },  // buttpad
  ]},
  skeleton_stock: { mount: 'stock', parts: [
    // Two wire arms (top + bottom) from body rear, with end plate
    { radius: 0.006, length: 0.22, segments: 6, color: 0x4a4a4a, offset: [0, 0.025, 0.11] },   // top arm
    { radius: 0.006, length: 0.22, segments: 6, color: 0x4a4a4a, offset: [0, -0.020, 0.11] },   // bottom arm
    { size: [0.04, 0.065, 0.012], color: 0x1a1a1a, offset: [0, 0.002, 0.22] },                  // end plate
  ]},
};

const OPTIC_GEOMETRY = {
  iron_sights:   { parts: [] },
  red_dot:       { mount: 'rail', parts: [
    { size: [0.03, 0.035, 0.04], color: 0x1a1a1a, offset: [0, 0.02, 0] },
  ]},
  holographic:   { mount: 'rail', parts: [
    { size: [0.035, 0.04, 0.05], color: 0x2a2a2a, offset: [0, 0.02, 0] },
  ]},
  acog:          { mount: 'rail', parts: [
    { radius: 0.016, length: 0.08, segments: 8, color: 0x1a1a1a, offset: [0, 0.02, 0] },
  ]},
  dmr_scope:     { mount: 'rail', parts: [
    { radius: 0.018, length: 0.14, segments: 8, color: 0x1a1a1a, offset: [0, 0.02, 0] },
  ]},
  sniper_scope:  { mount: 'rail', parts: [
    { radius: 0.020, length: 0.20, segments: 8, color: 0x1a1a1a, offset: [0, 0.02, 0] },
  ]},
  sniper_12x:    { mount: 'rail', parts: [
    { radius: 0.022, length: 0.24, segments: 8, color: 0x1a1a1a, offset: [0, 0.02, 0] },
  ]},
  thermal:       { mount: 'rail', parts: [
    { size: [0.04, 0.04, 0.06], color: 0x2a2a2a, offset: [0, 0.025, 0] },
  ]},
};

const ACCESSORY_GEOMETRY = {
  laser_sight: { mount: 'accessory', parts: [
    { size: [0.02, 0.02, 0.04], color: 0x1a1a1a, offset: [0.01, 0, 0] },
    { radius: 0.003, length: 0.02, segments: 6, color: 0xff0000, offset: [0.01, 0, -0.03] },
  ]},
  flashlight:  { mount: 'accessory', parts: [
    { radius: 0.014, length: 0.06, segments: 8, color: 0x2a2a2a, offset: [0.01, 0, -0.01] },
    { radius: 0.012, length: 0.01, segments: 8, color: 0xffffcc, offset: [0.01, 0, -0.05] },
  ]},
  ir_laser:    { mount: 'accessory', parts: [
    { size: [0.025, 0.025, 0.05], color: 0x1a1a1a, offset: [0.01, 0, 0] },
  ]},
};

// Attachments that don't make sense for certain archetypes
const ATTACHMENT_EXCLUSIONS = {
  drum_mag:       new Set(['revolver', 'sniper', 'shotgun', 'pistol']),
  extended_mag:   new Set(['revolver']),
  fast_mag:       new Set(['revolver']),
  bipod:          new Set(['pistol', 'revolver', 'shotgun']),
  vertical_grip:  new Set(['pistol', 'revolver']),
  angled_grip:    new Set(['pistol', 'revolver']),
  stubby_grip:    new Set(['pistol', 'revolver']),
  full_stock:     new Set(['pistol', 'revolver']),
  skeleton_stock: new Set(['pistol', 'revolver']),
};

// Default stock per archetype (null = no stock slot)
const DEFAULT_STOCKS = {
  pistol: null,
  revolver: null,
  smg: 'skeleton_stock',
  carbine: 'skeleton_stock',
  ar: 'full_stock',
  battle_rifle: 'skeleton_stock',
  lmg: 'full_stock',
  dmr: 'skeleton_stock',
  sniper: 'full_stock',
  shotgun: 'full_stock',
};

function getMountPoint(defKey, mountType) {
  const def = WEAPON_DEFS[defKey];
  const parts = def.parts;
  const body = parts.body;
  const barrel = parts.barrel;

  switch (mountType) {
    case 'muzzle':
    case 'barrel_end': {
      if (barrel) return [barrel.pos[0], barrel.pos[1], barrel.pos[2] - barrel.length / 2];
      // Fallback for weapons without barrel (pistol): front of body
      if (body) {
        const frontZ = body.pos[2] - (body.size ? body.size[2] / 2 : 0.10);
        return [body.pos[0], body.pos[1], frontZ];
      }
      return [0, 0, -0.10];
    }
    case 'barrel_mid': {
      if (barrel) return [barrel.pos[0], barrel.pos[1], barrel.pos[2]];
      if (body) return [body.pos[0], body.pos[1], body.pos[2] - (body.size ? body.size[2] / 4 : 0.05)];
      return [0, 0, -0.05];
    }
    case 'barrel_under': {
      // Under the barrel, near the front of the body
      if (barrel) return [barrel.pos[0], barrel.pos[1] - (barrel.radius || 0.02), barrel.pos[2]];
      if (body) {
        const bottomY = body.pos[1] - (body.size ? body.size[1] / 2 : body.radius || 0.05);
        return [body.pos[0], bottomY, body.pos[2] - (body.size ? body.size[2] / 4 : 0.05)];
      }
      return [0, -0.03, -0.10];
    }
    case 'underbarrel': {
      const hg = parts.handguard;
      if (hg) {
        const bottomY = hg.pos[1] - (hg.size ? hg.size[1] / 2 : 0.04);
        return [hg.pos[0], bottomY, hg.pos[2]];
      }
      // Fallback: bottom of body, forward section
      if (body) {
        const bottomY = body.pos[1] - (body.size ? body.size[1] / 2 : body.radius || 0.05);
        const forwardZ = body.pos[2] - (body.size ? body.size[2] / 4 : 0.05);
        return [body.pos[0], bottomY, forwardZ];
      }
      return [0, -0.05, -0.05];
    }
    case 'rail': {
      const r = parts.rail;
      if (r) return [r.pos[0], r.pos[1], r.pos[2]];
      if (body) {
        const topY = body.pos[1] + (body.size ? body.size[1] / 2 : body.radius || 0.05);
        return [body.pos[0], topY, body.pos[2]];
      }
      return [0, 0.07, -0.05];
    }
    case 'accessory': {
      const hg = parts.handguard;
      if (hg) {
        const sideX = hg.size ? hg.size[0] / 2 : 0.04;
        return [sideX, hg.pos[1], hg.pos[2]];
      }
      if (body) {
        const sideX = body.size ? body.size[0] / 2 : body.radius || 0.04;
        const forwardZ = body.pos[2] - (body.size ? body.size[2] / 4 : 0.05);
        return [sideX, body.pos[1], forwardZ];
      }
      return [0.04, 0, -0.10];
    }
    case 'mag_bottom': {
      const m = parts.magazine || parts.boxMag;
      if (m) return [m.pos[0], m.pos[1] - (m.size ? m.size[1] / 2 : 0.08), m.pos[2]];
      // Fallback for pistol: bottom of grip
      const g = parts.grip;
      if (g) return [g.pos[0], g.pos[1] - (g.size ? g.size[1] / 2 : 0.04), g.pos[2]];
      return [0, -0.15, 0.05];
    }
    case 'mag_replace': {
      // Position drum at body bottom for snug fit
      const m = parts.magazine || parts.boxMag;
      if (m) {
        // Use existing magazine position as base
        return [m.pos[0], m.pos[1], m.pos[2]];
      }
      if (body) {
        const bottomY = body.pos[1] - (body.size ? body.size[1] / 2 : body.radius || 0.05);
        // Fallback: grip position for pistol
        const g = parts.grip;
        const magZ = g ? g.pos[2] : body.pos[2];
        return [body.pos[0], bottomY, magZ];
      }
      return [0, -0.05, 0.05];
    }
    case 'stock': {
      // Always use rear of body/receiver — stock geometry extends backward from here
      if (body) {
        const rearZ = body.pos[2] + (body.size ? body.size[2] / 2 : 0.10);
        return [body.pos[0], body.pos[1], rearZ];
      }
      return [0, 0, 0.20];
    }
    default: return [0, 0, 0];
  }
}

function isStockPart(name) {
  return name && (name.startsWith('stock') || name === 'cheekRest');
}

function isIronSightPart(name) {
  return name && (name.startsWith('sight') || name === 'scope');
}

function isAttachmentAllowed(attKey, archetype) {
  const excl = ATTACHMENT_EXCLUSIONS[attKey];
  return !excl || !excl.has(archetype);
}

function addAttachmentMeshes(group, defKey) {
  const def = WEAPON_DEFS[defKey];

  // Hide iron sights when a non-iron optic is selected
  const optic = wb.attachments.optic;
  if (optic && optic !== 'iron_sights') {
    group.traverse(c => {
      if (c.isMesh && isIronSightPart(c.name)) c.visible = false;
    });
  }

  // Hide base stock parts when a stock attachment is selected
  if (wb.attachments.stock) {
    group.traverse(c => {
      if (c.isMesh && isStockPart(c.name)) c.visible = false;
    });
  }

  // Hide internal magazine for sniper (only visible with extended_mag)
  if (def?.archetype === 'sniper' && wb.attachments.magazine !== 'extended_mag') {
    group.traverse(c => {
      if (c.isMesh && c.name === 'magazine') c.visible = false;
    });
  }

  for (const [slot, attKey] of Object.entries(wb.attachments)) {
    if (!attKey) continue;

    let geoDef;
    if (slot === 'optic') {
      geoDef = OPTIC_GEOMETRY[attKey];
    } else if (slot === 'accessory') {
      geoDef = ACCESSORY_GEOMETRY[attKey];
    } else {
      geoDef = ATTACHMENT_GEOMETRY[attKey];
    }

    if (!geoDef) continue;

    // Barrel modification: scale the barrel mesh directly
    if (geoDef.barrelScale) {
      group.traverse(c => {
        if (c.isMesh && c.name === 'barrel') {
          c.scale.set(...geoDef.barrelScale);
        }
      });
      continue;
    }

    if (!geoDef.parts || geoDef.parts.length === 0) continue;

    const mp = getMountPoint(defKey, geoDef.mount);
    if (!mp) continue;

    for (const p of geoDef.parts) {
      let mesh;
      if (p.type === 'pyramid') {
        mesh = new THREE.Mesh(createPyramidGeometry(p.size), getMat(p.color));
      } else if (p.type === 'sphere') {
        mesh = new THREE.Mesh(new THREE.SphereGeometry(p.radius, p.segments || 8, p.segments || 8), getMat(p.color));
      } else if (p.radius !== undefined) {
        const geo = new THREE.CylinderGeometry(p.radius, p.radius, p.length, p.segments || 8);
        geo.rotateX(Math.PI / 2);
        mesh = new THREE.Mesh(geo, getMat(p.color));
      } else {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(...p.size), getMat(p.color));
      }
      mesh.position.set(mp[0] + p.offset[0], mp[1] + p.offset[1], mp[2] + p.offset[2]);
      if (p.rot) mesh.rotation.set(...p.rot);
      mesh.name = `att_${slot}`;
      group.add(mesh);
    }

    // Drum mag replaces original magazine
    if (attKey === 'drum_mag') {
      group.traverse(c => {
        if (c.isMesh && (c.name === 'magazine' || c.name === 'boxMag')) c.visible = false;
      });
    }
  }
}

// ─── WEAPON REBUILD ─────────────────────────────────────────

function rebuildWeapon() {
  // Remove old
  if (wb.weaponGroup) {
    wb.weaponGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); });
    wb.scene.remove(wb.weaponGroup);
  }

  const defKey = wb.selectedWeapon;
  const def = WEAPON_DEFS[defKey];
  if (!def) return;

  // If devMode with overrides, build from modified parts
  if (wb.devMode && Object.keys(wb.geometryOverrides).length > 0) {
    wb.weaponGroup = buildWeaponMeshWithOverrides(defKey, wb.geometryOverrides);
  } else {
    wb.weaponGroup = buildWeaponMesh(defKey);
  }

  // Add attachment geometry
  addAttachmentMeshes(wb.weaponGroup, defKey);

  // Apply custom colors
  applyColors(wb.weaponGroup);

  // Wireframe toggle
  if (wb.wireframe) {
    wb.weaponGroup.traverse(c => {
      if (c.isMesh) c.material = c.material.clone();
    });
    setWireframe(wb.weaponGroup, true);
  }

  wb.scene.add(wb.weaponGroup);
  updateStats();
}

function buildWeaponMeshWithOverrides(defKey, overrides) {
  const def = WEAPON_DEFS[defKey];
  const group = new THREE.Group();

  for (const [role, part] of Object.entries(def.parts)) {
    // Deep clone part, apply overrides
    const p = { ...part };
    if (p.size) p.size = [...p.size];

    const key = role;
    if (overrides[key]) {
      for (const [prop, val] of Object.entries(overrides[key])) {
        if (prop.startsWith('size.')) {
          const idx = parseInt(prop.split('.')[1]);
          if (p.size) p.size[idx] = val;
        } else {
          p[prop] = val;
        }
      }
    }

    let mesh;
    if (p.radius !== undefined) {
      const geo = new THREE.CylinderGeometry(p.radius, p.radius, p.length, p.segments || 8);
      geo.rotateX(Math.PI / 2);
      mesh = new THREE.Mesh(geo, getMat(p.color));
    } else if (p.type === 'wedge') {
      mesh = new THREE.Mesh(createWedgeGeometry(p.size), getMat(p.color));
    } else if (p.type === 'pyramid') {
      mesh = new THREE.Mesh(createPyramidGeometry(p.size), getMat(p.color));
    } else {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(...p.size), getMat(p.color));
    }
    mesh.position.set(...(p.pos || [0, 0, 0]));
    if (p.rot) mesh.rotation.set(...p.rot);
    mesh.name = role;
    group.add(mesh);
  }

  return group;
}

function applyColors(group) {
  group.traverse(c => {
    if (!c.isMesh || !c.name) return;
    const category = ROLE_COLOR_MAP[c.name];
    if (category && wb.colors[category] !== undefined) {
      c.material = getMat(wb.colors[category]);
    }
  });
}

function setWireframe(group, val) {
  group.traverse(c => {
    if (c.isMesh) c.material.wireframe = val;
  });
}

// ─── UI CREATION ────────────────────────────────────────────

function createUI(container) {
  // Overlay wrapper
  wb.overlay = document.createElement('div');
  wb.overlay.id = 'wb-overlay';
  wb.overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    display: flex; z-index: 200;
    font-family: 'Rajdhani', sans-serif; color: #e0e0e0;
  `;

  // Left: canvas area
  const left = document.createElement('div');
  left.style.cssText = 'flex: 1; position: relative; background: #1a1a22;';

  wb.canvas = document.createElement('canvas');
  wb.canvas.style.cssText = 'width: 100%; height: 100%; display: block; cursor: grab;';
  left.appendChild(wb.canvas);

  // Title overlay on canvas
  const title = document.createElement('div');
  title.style.cssText = `
    position: absolute; top: 16px; left: 20px;
    font-family: 'Rajdhani', sans-serif; font-weight: 700;
    font-size: 18px; color: #f39c12; letter-spacing: 2px;
    text-transform: uppercase; pointer-events: none;
  `;
  title.textContent = 'GUN WORKBENCH';
  left.appendChild(title);

  wb.overlay.appendChild(left);

  // Right: panel
  const panel = document.createElement('div');
  panel.id = 'wb-panel';
  panel.style.cssText = `
    width: 320px; background: #12121a; overflow-y: auto;
    padding: 16px; border-left: 1px solid #2a2a3a;
    font-size: 13px;
  `;

  // Build panel sections
  if (wb.mode === 'game') buildSlotTabs(panel);
  buildWeaponSelector(panel);
  buildAttachmentDropdowns(panel);
  buildStatReadout(panel);
  buildColorPickers(panel);
  if (wb.devMode) buildGeometrySliders(panel);
  if (wb.mode === 'game') buildConfirmCancel(panel);

  wb.overlay.appendChild(panel);
  container.appendChild(wb.overlay);
}

function sectionHeader(text) {
  const h = document.createElement('div');
  h.style.cssText = `
    font-family: 'Rajdhani', sans-serif; font-weight: 600;
    font-size: 12px; color: #f39c12; letter-spacing: 1.5px;
    text-transform: uppercase; margin: 16px 0 8px 0;
    border-bottom: 1px solid #2a2a3a; padding-bottom: 4px;
  `;
  h.textContent = text;
  return h;
}

// ── Slot Tabs (game mode) ───────────────────────────────────

function buildSlotTabs(panel) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display: flex; gap: 8px; margin-bottom: 12px;';

  for (const slot of ['primary', 'secondary']) {
    const btn = document.createElement('button');
    btn.textContent = slot.toUpperCase();
    btn.dataset.slot = slot;
    btn.style.cssText = `
      flex: 1; padding: 8px; border: 1px solid #3a3a4a;
      background: ${slot === wb.activeSlot ? '#f39c12' : '#1a1a22'};
      color: ${slot === wb.activeSlot ? '#0a0a0a' : '#888'};
      font-family: 'Rajdhani', sans-serif; font-weight: 600;
      font-size: 13px; cursor: pointer; letter-spacing: 1px;
    `;
    btn.addEventListener('click', () => switchSlot(slot));
    wrap.appendChild(btn);
  }

  panel.appendChild(wrap);
}

function switchSlot(slot) {
  // Save current
  saveSlotData();
  wb.activeSlot = slot;
  // Load new slot
  const data = wb.slotData[slot];
  wb.selectedWeapon = data.weapon;
  wb.attachments = { ...data.attachments };
  wb.colors = { ...data.colors };
  rebuildWeapon();
  refreshUI();
}

function saveSlotData() {
  wb.slotData[wb.activeSlot] = {
    weapon: wb.selectedWeapon,
    attachments: { ...wb.attachments },
    colors: { ...wb.colors },
  };
}

// ── Weapon Selector ─────────────────────────────────────────

function buildWeaponSelector(panel) {
  panel.appendChild(sectionHeader('Weapon'));

  const grid = document.createElement('div');
  grid.id = 'wb-weapon-grid';
  grid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 8px;';

  const CATEGORY_LABELS = {
    pistol: 'Pistol', revolver: 'Revolver', smg: 'Submachine Gun',
    carbine: 'Carbine', ar: 'Assault Rifle', battle_rifle: 'Battle Rifle',
    lmg: 'Light Machine Gun', dmr: 'Marksman Rifle', sniper: 'Sniper Rifle',
    shotgun: 'Shotgun',
  };

  for (const key of ALL_WEAPONS) {
    const def = WEAPON_DEFS[key];
    const btn = document.createElement('button');
    btn.dataset.weapon = key;
    const isAvailable = !wb.available || wb.available.weapons.includes(key);
    const isActive = key === wb.selectedWeapon;
    btn.style.cssText = `
      padding: 6px 4px 4px; border: 1px solid ${isActive ? '#f39c12' : '#3a3a4a'};
      background: ${isActive ? '#2a2218' : '#1a1a22'};
      color: ${!isAvailable ? '#444' : isActive ? '#f39c12' : '#aaa'};
      font-family: 'Share Tech Mono', monospace; font-size: 11px;
      cursor: ${isAvailable ? 'pointer' : 'default'};
      text-transform: uppercase; letter-spacing: 0.5px;
    `;
    const nameSpan = document.createElement('div');
    nameSpan.textContent = def.name;
    btn.appendChild(nameSpan);
    const catSpan = document.createElement('div');
    catSpan.textContent = CATEGORY_LABELS[def.archetype] || def.archetype;
    catSpan.style.cssText = 'font-size: 8px; color: #666; text-transform: none; letter-spacing: 0; margin-top: 1px;';
    btn.appendChild(catSpan);
    if (isAvailable) {
      btn.addEventListener('click', () => selectWeapon(key));
    }
    grid.appendChild(btn);
  }

  panel.appendChild(grid);
}

function selectWeapon(key) {
  wb.selectedWeapon = key;
  const archetype = WEAPON_DEFS[key]?.archetype;
  // Reset attachments when switching weapon
  for (const slot of Object.keys(wb.attachments)) wb.attachments[slot] = null;
  wb.attachments.optic = 'iron_sights';
  wb.attachments.stock = DEFAULT_STOCKS[archetype] || null;
  wb.colors = { ...DEFAULT_COLORS };
  wb.geometryOverrides = {};
  rebuildWeapon();
  refreshUI();
}

// ── Attachment Dropdowns ────────────────────────────────────

function buildAttachmentDropdowns(panel) {
  panel.appendChild(sectionHeader('Attachments'));

  const slots = ['muzzle', 'barrel', 'underbarrel', 'stock', 'magazine', 'optic', 'accessory'];

  for (const slot of slots) {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; margin-bottom: 6px; gap: 8px;';

    const label = document.createElement('span');
    label.style.cssText = `
      width: 90px; font-family: 'Share Tech Mono', monospace;
      font-size: 10px; color: #888; text-transform: uppercase;
    `;
    label.textContent = slot;
    row.appendChild(label);

    const sel = document.createElement('select');
    sel.dataset.slot = slot;
    sel.id = `wb-att-${slot}`;
    sel.style.cssText = `
      flex: 1; padding: 4px 6px; background: #1a1a22;
      border: 1px solid #3a3a4a; color: #ccc;
      font-family: 'Share Tech Mono', monospace; font-size: 11px;
    `;

    const archetype = WEAPON_DEFS[wb.selectedWeapon]?.archetype;

    if (slot === 'optic') {
      // Optic: no "None", iron_sights is the baseline
      for (const [key, def] of Object.entries(OPTIC_DEFS)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = def.name;
        if (wb.attachments.optic === key) opt.selected = true;
        sel.appendChild(opt);
      }
    } else if (slot === 'accessory') {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'None';
      sel.appendChild(none);
      for (const name of ['Laser Sight', 'Flashlight', 'IR Laser']) {
        const opt = document.createElement('option');
        opt.value = name.toLowerCase().replace(/ /g, '_');
        opt.textContent = name;
        if (wb.attachments.accessory === name.toLowerCase().replace(/ /g, '_')) opt.selected = true;
        sel.appendChild(opt);
      }
    } else {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'None';
      sel.appendChild(none);
      for (const [key, def] of Object.entries(ATTACHMENT_DEFS)) {
        if (def.slot !== slot) continue;
        if (!isAttachmentAllowed(key, archetype)) continue;
        const isAvail = !wb.available || !wb.available.attachments || wb.available.attachments.includes(key);
        if (wb.mode === 'game' && !isAvail) continue;
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = def.name;
        if (wb.attachments[slot] === key) opt.selected = true;
        sel.appendChild(opt);
      }
    }

    sel.addEventListener('change', () => {
      wb.attachments[slot] = sel.value || null;
      rebuildWeapon();
    });

    row.appendChild(sel);
    panel.appendChild(row);
  }
}

// ── Stat Readout ────────────────────────────────────────────

function buildStatReadout(panel) {
  panel.appendChild(sectionHeader('Stats'));

  const table = document.createElement('div');
  table.id = 'wb-stats';
  table.style.cssText = 'font-family: "Share Tech Mono", monospace; font-size: 11px;';
  panel.appendChild(table);
}

function updateStats() {
  const table = document.getElementById('wb-stats');
  if (!table) return;
  table.innerHTML = '';

  const def = WEAPON_DEFS[wb.selectedWeapon];
  if (!def) return;

  // Gather active attachments
  const atts = [];
  for (const [slot, key] of Object.entries(wb.attachments)) {
    if (!key) continue;
    if (slot === 'optic' || slot === 'accessory') continue;
    if (ATTACHMENT_DEFS[key]) atts.push(ATTACHMENT_DEFS[key]);
  }

  const base = computeStats(def, []);
  const modded = computeStats(def, atts);

  for (const [statKey, label] of Object.entries(STAT_LABELS)) {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; justify-content: space-between; padding: 2px 0; border-bottom: 1px solid #1a1a22;';

    const lbl = document.createElement('span');
    lbl.style.color = '#888';
    lbl.textContent = label;

    let baseVal, modVal;
    if (statKey === 'spread.hip') {
      baseVal = base.spread.hip;
      modVal = modded.spread.hip;
    } else if (statKey === 'spread.ads') {
      baseVal = base.spread.ads;
      modVal = modded.spread.ads;
    } else {
      baseVal = base[statKey];
      modVal = modded[statKey];
    }

    const val = document.createElement('span');
    if (typeof modVal === 'number') {
      const fmt = modVal % 1 === 0 ? modVal.toString() : modVal.toFixed(2);
      val.textContent = fmt;

      // Color diff
      const diff = modVal - baseVal;
      if (Math.abs(diff) > 0.001) {
        const improved = LOWER_IS_BETTER.has(statKey) ? diff < 0 : diff > 0;
        val.style.color = improved ? '#2ecc71' : '#e74c3c';
      } else {
        val.style.color = '#e0e0e0';
      }
    } else {
      val.textContent = modVal || '-';
      val.style.color = '#e0e0e0';
    }

    row.appendChild(lbl);
    row.appendChild(val);
    table.appendChild(row);
  }

  // Fire mode (non-numeric)
  const fmRow = document.createElement('div');
  fmRow.style.cssText = 'display: flex; justify-content: space-between; padding: 2px 0;';
  const fmLbl = document.createElement('span');
  fmLbl.style.color = '#888';
  fmLbl.textContent = 'FIRE MODE';
  const fmVal = document.createElement('span');
  fmVal.style.color = '#e0e0e0';
  fmVal.textContent = (def.availableModes || [def.baseStats.fireMode]).join(' / ').toUpperCase();
  fmRow.appendChild(fmLbl);
  fmRow.appendChild(fmVal);
  table.appendChild(fmRow);

  // Swap time
  const swapRow = document.createElement('div');
  swapRow.style.cssText = 'display: flex; justify-content: space-between; padding: 2px 0;';
  const swapLbl = document.createElement('span');
  swapLbl.style.color = '#888';
  swapLbl.textContent = 'SWAP TIME';
  const swapVal = document.createElement('span');
  swapVal.style.color = '#e0e0e0';
  swapVal.textContent = (0.3 + modded.weight * 0.02).toFixed(2) + 's';
  swapRow.appendChild(swapLbl);
  swapRow.appendChild(swapVal);
  table.appendChild(swapRow);
}

// ── Color Pickers ───────────────────────────────────────────

function buildColorPickers(panel) {
  panel.appendChild(sectionHeader('Colors'));

  const categories = ['receiver', 'barrel', 'stock', 'magazine', 'accent'];

  for (const cat of categories) {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; margin-bottom: 6px; gap: 8px;';

    const label = document.createElement('span');
    label.style.cssText = `
      width: 90px; font-family: 'Share Tech Mono', monospace;
      font-size: 10px; color: #888; text-transform: uppercase;
    `;
    label.textContent = cat;
    row.appendChild(label);

    const input = document.createElement('input');
    input.type = 'color';
    input.id = `wb-color-${cat}`;
    input.value = '#' + wb.colors[cat].toString(16).padStart(6, '0');
    input.style.cssText = `
      width: 36px; height: 24px; border: 1px solid #3a3a4a;
      background: #1a1a22; cursor: pointer; padding: 0;
    `;
    input.addEventListener('input', () => {
      wb.colors[cat] = parseInt(input.value.slice(1), 16);
      if (wb.weaponGroup) applyColors(wb.weaponGroup);
    });

    row.appendChild(input);
    panel.appendChild(row);
  }
}

// ── Geometry Sliders (devMode) ──────────────────────────────

function buildGeometrySliders(panel) {
  panel.appendChild(sectionHeader('Geometry'));

  const def = WEAPON_DEFS[wb.selectedWeapon];

  for (const sd of SLIDER_DEFS) {
    // Skip if weapon doesn't have this part
    const part = def.parts[sd.part];
    if (!part) continue;

    // Get current value
    let currentVal;
    if (sd.prop.startsWith('size.')) {
      const idx = parseInt(sd.prop.split('.')[1]);
      currentVal = part.size ? part.size[idx] : sd.min;
    } else {
      currentVal = part[sd.prop] !== undefined ? part[sd.prop] : sd.min;
    }

    // Apply override if exists
    if (wb.geometryOverrides[sd.part] && wb.geometryOverrides[sd.part][sd.prop] !== undefined) {
      currentVal = wb.geometryOverrides[sd.part][sd.prop];
    }

    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom: 6px;';

    const top = document.createElement('div');
    top.style.cssText = 'display: flex; justify-content: space-between; margin-bottom: 2px;';

    const label = document.createElement('span');
    label.style.cssText = "font-family: 'Share Tech Mono', monospace; font-size: 10px; color: #888;";
    label.textContent = sd.label;

    const readout = document.createElement('span');
    readout.style.cssText = "font-family: 'Share Tech Mono', monospace; font-size: 10px; color: #f39c12;";
    readout.textContent = currentVal.toFixed(3);

    top.appendChild(label);
    top.appendChild(readout);
    row.appendChild(top);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = sd.min;
    range.max = sd.max;
    range.step = sd.step;
    range.value = currentVal;
    range.style.cssText = 'width: 100%; accent-color: #f39c12;';

    range.addEventListener('input', () => {
      const val = parseFloat(range.value);
      readout.textContent = val.toFixed(3);
      if (!wb.geometryOverrides[sd.part]) wb.geometryOverrides[sd.part] = {};
      wb.geometryOverrides[sd.part][sd.prop] = val;
      rebuildWeapon();
    });

    row.appendChild(range);
    panel.appendChild(row);
  }

  // Export button
  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'COPY OVERRIDES';
  exportBtn.style.cssText = `
    margin-top: 8px; padding: 6px 12px; width: 100%;
    background: #2a2a3a; border: 1px solid #3a3a4a; color: #aaa;
    font-family: 'Share Tech Mono', monospace; font-size: 10px;
    cursor: pointer; letter-spacing: 1px;
  `;
  exportBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify(wb.geometryOverrides, null, 2));
    exportBtn.textContent = 'COPIED!';
    setTimeout(() => { exportBtn.textContent = 'COPY OVERRIDES'; }, 1500);
  });
  panel.appendChild(exportBtn);
}

// ── Display Toggles ─────────────────────────────────────────

function buildDisplayToggles(panel) {
  panel.appendChild(sectionHeader('Display'));

  const toggles = [
    { label: 'Grid', key: 'showGrid', fn: () => { wb.gridHelper.visible = wb.showGrid; } },
    { label: 'Turntable', key: 'turntable', fn: () => {} },
    { label: 'Wireframe', key: 'wireframe', fn: () => {
      if (wb.weaponGroup) {
        // Clone materials if switching to wireframe to not affect matCache
        if (wb.wireframe) {
          wb.weaponGroup.traverse(c => {
            if (c.isMesh) c.material = c.material.clone();
          });
        }
        setWireframe(wb.weaponGroup, wb.wireframe);
        if (!wb.wireframe) {
          // Restore shared materials
          applyColors(wb.weaponGroup);
        }
      }
    }},
  ];

  for (const t of toggles) {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 4px;';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = wb[t.key];
    cb.style.cssText = 'accent-color: #f39c12;';
    cb.addEventListener('change', () => {
      wb[t.key] = cb.checked;
      t.fn();
    });

    const label = document.createElement('span');
    label.style.cssText = "font-family: 'Share Tech Mono', monospace; font-size: 11px; color: #aaa;";
    label.textContent = t.label;

    row.appendChild(cb);
    row.appendChild(label);
    panel.appendChild(row);
  }
}

// ── Confirm/Cancel (game mode) ──────────────────────────────

function buildConfirmCancel(panel) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display: flex; gap: 8px; margin-top: 20px;';

  const confirm = document.createElement('button');
  confirm.textContent = 'CONFIRM';
  confirm.style.cssText = `
    flex: 1; padding: 10px; background: #f39c12; border: none;
    color: #0a0a0a; font-family: 'Rajdhani', sans-serif; font-weight: 700;
    font-size: 14px; cursor: pointer; letter-spacing: 1px;
  `;
  confirm.addEventListener('click', () => {
    saveSlotData();
    if (wb.onConfirm) {
      wb.onConfirm({
        primary: { ...wb.slotData.primary },
        secondary: { ...wb.slotData.secondary },
      });
    }
    teardown();
  });

  const cancel = document.createElement('button');
  cancel.textContent = 'CANCEL';
  cancel.style.cssText = `
    flex: 1; padding: 10px; background: #2a2a3a; border: 1px solid #3a3a4a;
    color: #888; font-family: 'Rajdhani', sans-serif; font-weight: 600;
    font-size: 14px; cursor: pointer; letter-spacing: 1px;
  `;
  cancel.addEventListener('click', () => {
    if (wb.onCancel) wb.onCancel();
    teardown();
  });

  wrap.appendChild(confirm);
  wrap.appendChild(cancel);
  panel.appendChild(wrap);
}

// ── Refresh all UI to match state ───────────────────────────

function refreshUI() {
  if (!wb.overlay) return;

  // Re-render the entire panel (simple approach — panel is lightweight DOM)
  const panel = wb.overlay.querySelector('#wb-panel');
  if (panel) {
    panel.innerHTML = '';
    if (wb.mode === 'game') buildSlotTabs(panel);
    buildWeaponSelector(panel);
    buildAttachmentDropdowns(panel);
    buildStatReadout(panel);
    buildColorPickers(panel);
    if (wb.devMode) buildGeometrySliders(panel);
    buildDisplayToggles(panel);
    if (wb.mode === 'game') buildConfirmCancel(panel);
  }

  updateStats();
}

// ─── RESIZE / RENDER ─────────────────────────────────────────

function resizeRenderer() {
  if (!wb.canvas || !wb.renderer) return;
  const rect = wb.canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  wb.renderer.setSize(rect.width, rect.height, false);
  wb.camera.aspect = rect.width / rect.height;
  wb.camera.updateProjectionMatrix();
}

function wbLoop(time) {
  if (!wb.active) return;
  wb.animId = requestAnimationFrame(wbLoop);

  const dt = Math.min((time - wb.lastTime) / 1000, 0.05);
  wb.lastTime = time;

  // Turntable
  if (wb.turntable && !wb.isDragging) {
    wb.idleTimer += dt;
    if (wb.idleTimer > 3) {
      wb.theta += dt * 0.3;
      updateOrbitCamera();
    }
  }

  // Resize check
  const rect = wb.canvas.getBoundingClientRect();
  const dpr = wb.renderer.getPixelRatio();
  const needW = (rect.width * dpr) | 0;
  const needH = (rect.height * dpr) | 0;
  if (wb.canvas.width !== needW || wb.canvas.height !== needH) {
    resizeRenderer();
  }

  wb.renderer.render(wb.scene, wb.camera);
}

// ─── TEARDOWN ───────────────────────────────────────────────

function teardown() {
  wb.active = false;
  if (wb.animId) cancelAnimationFrame(wb.animId);
  detachOrbitControls();

  if (wb.weaponGroup) {
    wb.weaponGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); });
    wb.scene.remove(wb.weaponGroup);
    wb.weaponGroup = null;
  }

  if (wb.overlay && wb.overlay.parentNode) {
    wb.overlay.parentNode.removeChild(wb.overlay);
  }
  wb.overlay = null;
  wb.canvas = null;

  if (wb.renderer) {
    wb.renderer.dispose();
    wb.renderer = null;
  }
}

// ─── PUBLIC API ─────────────────────────────────────────────

export function initStandalone(container) {
  wb.mode = 'standalone';
  wb.devMode = true;
  wb.active = true;
  wb.selectedWeapon = 'carbine';
  wb.attachments = { muzzle: null, barrel: null, underbarrel: null, stock: 'skeleton_stock', magazine: null, optic: 'iron_sights', accessory: null };
  wb.colors = { ...DEFAULT_COLORS };
  wb.geometryOverrides = {};
  wb.available = null;

  createWBScene();
  createWBCamera();
  createUI(container);

  // Create renderer targeting our canvas
  wb.renderer = new THREE.WebGLRenderer({ canvas: wb.canvas, antialias: true });
  wb.renderer.setPixelRatio(window.devicePixelRatio);

  attachOrbitControls(wb.canvas);
  rebuildWeapon();

  wb.lastTime = performance.now();
  // Defer first frame so DOM layout is complete
  requestAnimationFrame((t) => {
    resizeRenderer();
    wb.animId = requestAnimationFrame(wbLoop);
  });
}

export function openWorkbench(gameRenderer, gameCamera, gameScene, loadout, available, options = {}) {
  wb.mode = 'game';
  wb.devMode = options.devMode || false;
  wb.active = true;
  wb.available = available || null;
  wb.onConfirm = options.onConfirm || null;
  wb.onCancel = options.onCancel || null;

  // Initialize slot data from loadout
  if (loadout) {
    const priWeapon = loadout.primary?.weapon || loadout.primary || 'carbine';
    const secWeapon = loadout.secondary?.weapon || loadout.secondary || 'pistol';
    const priArch = WEAPON_DEFS[priWeapon]?.archetype;
    const secArch = WEAPON_DEFS[secWeapon]?.archetype;
    wb.slotData.primary = {
      weapon: priWeapon,
      attachments: loadout.primary?.attachments || { muzzle: null, barrel: null, underbarrel: null, stock: DEFAULT_STOCKS[priArch] || null, magazine: null, optic: 'iron_sights', accessory: null },
      colors: (loadout.primary?.colors && Object.keys(loadout.primary.colors).length > 0) ? loadout.primary.colors : { ...DEFAULT_COLORS },
    };
    wb.slotData.secondary = {
      weapon: secWeapon,
      attachments: loadout.secondary?.attachments || { muzzle: null, barrel: null, underbarrel: null, stock: DEFAULT_STOCKS[secArch] || null, magazine: null, optic: 'iron_sights', accessory: null },
      colors: (loadout.secondary?.colors && Object.keys(loadout.secondary.colors).length > 0) ? loadout.secondary.colors : { ...DEFAULT_COLORS },
    };
  }

  wb.activeSlot = 'primary';
  wb.selectedWeapon = wb.slotData.primary.weapon;
  wb.attachments = { ...wb.slotData.primary.attachments };
  wb.colors = { ...wb.slotData.primary.colors };
  wb.geometryOverrides = {};

  createWBScene();
  createWBCamera();
  createUI(document.body);

  // In game mode, create a separate renderer for the workbench canvas
  wb.renderer = new THREE.WebGLRenderer({ canvas: wb.canvas, antialias: true });
  wb.renderer.setPixelRatio(window.devicePixelRatio);

  attachOrbitControls(wb.canvas);
  rebuildWeapon();

  wb.lastTime = performance.now();
  requestAnimationFrame((t) => {
    resizeRenderer();
    wb.animId = requestAnimationFrame(wbLoop);
  });
}

export function closeWorkbench() {
  saveSlotData();
  const result = {
    primary: { ...wb.slotData.primary },
    secondary: { ...wb.slotData.secondary },
  };
  teardown();
  return result;
}

// Export for game integration
export function isWorkbenchOpen() {
  return wb.active;
}

// Allow game loop to call this for updates if needed
export function updateWorkbench(dt) {
  // Turntable update (called externally when running in game loop)
  if (wb.turntable && !wb.isDragging) {
    wb.idleTimer += dt;
    if (wb.idleTimer > 3) {
      wb.theta += dt * 0.3;
      updateOrbitCamera();
    }
  }
}

export function renderWorkbench(extRenderer) {
  if (!wb.active || !wb.scene || !wb.camera) return;
  extRenderer.autoClear = false;
  extRenderer.clearDepth();
  extRenderer.render(wb.scene, wb.camera);
  extRenderer.autoClear = true;
}
