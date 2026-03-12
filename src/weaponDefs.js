// ─── WEAPON DEFINITIONS ─────────────────────────────────────
// Full weapon system: 10 archetypes, attachments, stance modifiers, recoil patterns.
// See docs/weapons-spec.md for design spec.

const DEG = Math.PI / 180;

// ─── RECOIL PATTERN GENERATOR ─────────────────────────────
// Generates deterministic per-weapon recoil patterns from archetype shape params.
function generateRecoilPattern(shape, magSize) {
  const { basePitch, yawDrift, yawAmplitude, yawFrequency, pitchDecay } = shape;
  const pattern = [];
  for (let i = 0; i < magSize; i++) {
    const t = i / magSize;
    const pitch = basePitch * (1 - pitchDecay * t);
    const yaw = yawDrift * t + yawAmplitude * Math.sin(t * Math.PI * 2 * yawFrequency);
    pattern.push({ pitch, yaw });
  }
  return pattern;
}

// ─── RECOIL SHAPES PER ARCHETYPE ──────────────────────────
const RECOIL_SHAPES = {
  pistol:       { basePitch: 1.2, yawDrift: 0.0, yawAmplitude: 0.1, yawFrequency: 1, pitchDecay: 0.1 },
  revolver:     { basePitch: 2.5, yawDrift: 0.0, yawAmplitude: 0.15, yawFrequency: 0.5, pitchDecay: 0.05 },
  smg:          { basePitch: 0.4, yawDrift: 0.05, yawAmplitude: 0.15, yawFrequency: 2, pitchDecay: 0.2 },
  carbine:      { basePitch: 0.6, yawDrift: 0.1, yawAmplitude: 0.1, yawFrequency: 1.5, pitchDecay: 0.15 },
  ar:           { basePitch: 0.6, yawDrift: 0.0, yawAmplitude: 0.25, yawFrequency: 1.5, pitchDecay: 0.2 },
  battle_rifle: { basePitch: 0.9, yawDrift: 0.0, yawAmplitude: 0.3, yawFrequency: 2, pitchDecay: 0.1 },
  lmg:          { basePitch: 0.5, yawDrift: 0.0, yawAmplitude: 0.4, yawFrequency: 3, pitchDecay: 0.15 },
  dmr:          { basePitch: 1.4, yawDrift: 0.0, yawAmplitude: 0.1, yawFrequency: 1, pitchDecay: 0.3 },
  sniper:       { basePitch: 3.0, yawDrift: 0.0, yawAmplitude: 0.2, yawFrequency: 0.5, pitchDecay: 0.05 },
  shotgun:      { basePitch: 2.0, yawDrift: 0.0, yawAmplitude: 0.5, yawFrequency: 1, pitchDecay: 0.1 },
};

// ─── WEAPON COLORS ────────────────────────────────────────
const C = {
  receiver: 0x3a3a3a,
  barrel:   0x2a2a2a,
  stock:    0x3d3530,
  accent:   0x5a5a5a,
  magazine: 0x3a3a3a,
  dark:     0x1a1a1a,
  grip:     0x4a3728,
  wood:     0x5c3d2e,
  metal:    0x4a4a4a,
};

// ─── WEAPON DEFINITIONS ───────────────────────────────────
export const WEAPON_DEFS = {

  // ── 1. PISTOL — M9A1 ──────────────────────────────────
  pistol: {
    name: 'M9A1',
    archetype: 'pistol',
    baseStats: {
      damage: 22, penetration: 0.4, rateOfFire: 6, magSize: 15,
      reloadTime: 1.4, adsTime: 0.10, moveSpeed: 1.00, adsSpeed: 0.60,
      spread: { hip: 4.0, ads: 1.5 },
      range: 50, headshotMult: 1.8, fireMode: 'semi', weight: 1.0,
    },
    hipFactor: 0.8, adsFactor: 0.9,
    recoilRecoveryRate: 8,
    spreadPerShot: 0.4,
    tracerColor: 0xffdd66, tracerInterval: 3,
    pelletCount: 1,
    availableModes: ['semi'],
    defaultOptic: 'iron_sights',

    hipPos: [0.28, -0.30, -0.45],
    adsPos: [0.0, -0.046, -0.38],
    adsFov: 65,
    drawSpeed: 5.0,
    muzzleOffset: [0, 0.01, -0.19],

    reload: { tiltPitch: 40, tiltRoll: -5, dropY: -0.06 },
    ejectionOffset: [0.03, 0.02, -0.05],
    casingColor: 0xc4a63a,

    parts: {
      body:       { size: [0.05, 0.08, 0.20], color: C.receiver, pos: [0, -0.01, 0] },
      barrel:     { radius: 0.012, length: 0.10, segments: 8, color: C.barrel, pos: [0, 0.0, -0.14] },
      grip:       { size: [0.04, 0.09, 0.04], color: C.grip, pos: [0, -0.09, 0.04], rot: [-0.2, 0, 0] },
      sightFront: { size: [0.012, 0.022, 0.012], color: C.dark, pos: [0, 0.035, -0.18] },
    },
  },

  // ── 2. REVOLVER — .357 Magnum ─────────────────────────
  revolver: {
    name: '.357 MAGNUM',
    archetype: 'revolver',
    baseStats: {
      damage: 55, penetration: 0.7, rateOfFire: 1.5, magSize: 6,
      reloadTime: 2.8, adsTime: 0.15, moveSpeed: 0.98, adsSpeed: 0.55,
      spread: { hip: 3.0, ads: 0.8 },
      range: 60, headshotMult: 2.0, fireMode: 'semi', weight: 1.2,
    },
    hipFactor: 1.0, adsFactor: 0.7,
    recoilRecoveryRate: 5,
    spreadPerShot: 0.6,
    tracerColor: 0xffcc33, tracerInterval: 1,
    pelletCount: 1,
    availableModes: ['semi'],
    defaultOptic: 'iron_sights',

    hipPos: [0.28, -0.30, -0.45],
    adsPos: [0.0, -0.05, -0.38],
    adsFov: 65,
    drawSpeed: 4.5,
    muzzleOffset: [0, 0.04, -0.42],

    reload: { tiltPitch: 50, tiltRoll: -8, dropY: -0.07 },
    ejectionOffset: null,  // revolver: no per-shot ejection, dump all on reload
    casingColor: 0xc4a63a,

    parts: {
      body:       { radius: 0.045, length: 0.10, segments: 8, color: C.receiver, pos: [0, 0, 0] },
      barrel:     { radius: 0.018, length: 0.26, segments: 8, color: C.barrel, pos: [0, 0.01, -0.18] },
      cylinder:   { radius: 0.032, length: 0.06, segments: 6, color: C.accent, pos: [0, 0.01, -0.02] },
      grip:       { size: [0.05, 0.10, 0.045], color: C.grip, pos: [0, -0.07, 0.02], rot: [-0.25, 0, 0] },
      hammer:     { size: [0.02, 0.035, 0.015], color: C.accent, pos: [0, 0.06, 0.04] },
      sightFront: { size: [0.012, 0.025, 0.012], color: C.dark, pos: [0, 0.04, -0.30] },
    },
  },

  // ── 3. SMG — MP7 ──────────────────────────────────────
  smg: {
    name: 'MP7',
    archetype: 'smg',
    baseStats: {
      damage: 20, penetration: 0.3, rateOfFire: 15, magSize: 40,
      reloadTime: 1.8, adsTime: 0.10, moveSpeed: 0.97, adsSpeed: 0.60,
      spread: { hip: 5.0, ads: 2.0 },
      range: 40, headshotMult: 1.5, fireMode: 'auto', weight: 2.0,
    },
    hipFactor: 0.6, adsFactor: 1.0,
    recoilRecoveryRate: 7,
    spreadPerShot: 0.3,
    tracerColor: 0xffaa44, tracerInterval: 4,
    pelletCount: 1,
    availableModes: ['auto', 'semi'],
    defaultOptic: 'iron_sights',

    hipPos: [0.30, -0.28, -0.48],
    adsPos: [0.0, -0.065, -0.40],
    adsFov: 65,
    drawSpeed: 4.0,
    muzzleOffset: [0, 0.02, -0.52],

    reload: { tiltPitch: 35, tiltRoll: -8, dropY: -0.07 },
    ejectionOffset: [0.05, 0.04, -0.08],
    casingColor: 0xc4a63a,

    parts: {
      body:       { size: [0.09, 0.10, 0.28], color: C.receiver, pos: [0, 0, 0] },
      barrel:     { radius: 0.016, length: 0.22, segments: 8, color: C.barrel, pos: [0, 0.02, -0.24] },
      magazine:   { size: [0.05, 0.20, 0.035], color: C.magazine, pos: [0, -0.15, 0.02] },
      stockArmT:  { radius: 0.006, length: 0.14, segments: 6, color: C.metal, pos: [0, 0.04, 0.21] },
      stockArmB:  { radius: 0.006, length: 0.14, segments: 6, color: C.metal, pos: [0, -0.01, 0.21] },
      stockEnd:   { size: [0.04, 0.07, 0.01], color: C.metal, pos: [0, 0.015, 0.28] },
      grip:       { size: [0.05, 0.08, 0.035], color: C.grip, pos: [0, -0.08, 0.10], rot: [-0.2, 0, 0] },
      sightRearL: { size: [0.012, 0.02, 0.012], color: C.dark, pos: [-0.025, 0.06, -0.06] },
      sightRearR: { size: [0.012, 0.02, 0.012], color: C.dark, pos: [0.025, 0.06, -0.06] },
      sightFront: { size: [0.012, 0.03, 0.012], color: C.dark, pos: [0, 0.05, -0.32] },
    },
  },

  // ── 4. CARBINE — M4 ──────────────────────────────────
  carbine: {
    name: 'M4',
    archetype: 'carbine',
    baseStats: {
      damage: 28, penetration: 0.6, rateOfFire: 12, magSize: 30,
      reloadTime: 2.0, adsTime: 0.15, moveSpeed: 0.93, adsSpeed: 0.55,
      spread: { hip: 3.5, ads: 1.2 },
      range: 80, headshotMult: 1.8, fireMode: 'auto', weight: 3.0,
    },
    hipFactor: 0.9, adsFactor: 0.8,
    recoilRecoveryRate: 6,
    spreadPerShot: 0.4,
    tracerColor: 0xffaa44, tracerInterval: 4,
    pelletCount: 1,
    availableModes: ['auto', 'semi'],
    defaultOptic: 'iron_sights',

    hipPos: [0.32, -0.28, -0.5],
    adsPos: [0.0, -0.08, -0.4],
    adsFov: 65,
    drawSpeed: 3.0,
    muzzleOffset: [0, 0.02, -0.68],

    reload: { tiltPitch: 30, tiltRoll: -10, dropY: -0.08 },
    ejectionOffset: [0.05, 0.04, -0.10],
    casingColor: 0xc4a63a,

    parts: {
      body:       { size: [0.08, 0.10, 0.42], color: C.receiver, pos: [0, 0, 0] },
      barrel:     { radius: 0.018, length: 0.38, segments: 8, color: C.barrel, pos: [0, 0.02, -0.38] },
      handguard:  { size: [0.07, 0.08, 0.22], color: C.receiver, pos: [0, 0.01, -0.24] },
      magazine:   { size: [0.06, 0.16, 0.045], color: C.magazine, pos: [0, -0.13, 0.05] },
      stockTube:  { radius: 0.015, length: 0.18, segments: 6, color: C.metal, pos: [0, 0.01, 0.30] },
      stockPad:   { size: [0.06, 0.08, 0.015], color: C.dark, pos: [0, 0.01, 0.39] },
      grip:       { size: [0.05, 0.09, 0.035], color: C.grip, pos: [0, -0.09, 0.14], rot: [-0.25, 0, 0] },
      sightRearL: { size: [0.015, 0.03, 0.015], color: C.dark, pos: [-0.03, 0.06, -0.08] },
      sightRearR: { size: [0.015, 0.03, 0.015], color: C.dark, pos: [0.03, 0.06, -0.08] },
      sightFront: { size: [0.015, 0.04, 0.015], color: C.dark, pos: [0, 0.06, -0.55] },
    },
  },

  // ── 5. AR — AK-74 ────────────────────────────────────
  ar: {
    name: 'AK-74',
    archetype: 'ar',
    baseStats: {
      damage: 32, penetration: 0.8, rateOfFire: 10, magSize: 30,
      reloadTime: 2.3, adsTime: 0.18, moveSpeed: 0.90, adsSpeed: 0.50,
      spread: { hip: 3.5, ads: 1.0 },
      range: 90, headshotMult: 1.8, fireMode: 'auto', weight: 3.5,
    },
    hipFactor: 1.0, adsFactor: 0.7,
    recoilRecoveryRate: 5,
    spreadPerShot: 0.5,
    tracerColor: 0xffaa44, tracerInterval: 4,
    pelletCount: 1,
    availableModes: ['auto', 'semi'],
    defaultOptic: 'iron_sights',

    hipPos: [0.32, -0.28, -0.5],
    adsPos: [0.0, -0.075, -0.4],
    adsFov: 65,
    drawSpeed: 2.8,
    muzzleOffset: [0, 0.02, -0.72],

    reload: { tiltPitch: 30, tiltRoll: -10, dropY: -0.08 },
    ejectionOffset: [0.06, 0.05, -0.10],
    casingColor: 0xc4a63a,

    parts: {
      body:       { size: [0.10, 0.12, 0.48], color: C.receiver, pos: [0, 0, 0] },
      barrel:     { radius: 0.020, length: 0.42, segments: 8, color: C.barrel, pos: [0, 0.02, -0.42] },
      gasBlock:   { size: [0.05, 0.05, 0.035], color: C.barrel, pos: [0, 0.055, -0.35] },
      magazine:   { size: [0.07, 0.18, 0.05], color: C.magazine, pos: [0.01, -0.14, 0.04], rot: [0.15, 0, 0] },
      stock:      { type: 'pyramid', size: [0.08, 0.10, 0.26], color: C.wood, pos: [0, 0.01, 0.36] },
      grip:       { size: [0.05, 0.09, 0.035], color: C.grip, pos: [0, -0.09, 0.14], rot: [-0.25, 0, 0] },
      sightRearL: { size: [0.015, 0.025, 0.015], color: C.dark, pos: [-0.035, 0.075, -0.08] },
      sightRearR: { size: [0.015, 0.025, 0.015], color: C.dark, pos: [0.035, 0.075, -0.08] },
      sightFront: { size: [0.015, 0.04, 0.015], color: C.dark, pos: [0, 0.055, -0.60] },
    },
  },

  // ── 6. BATTLE RIFLE — SCAR-H ─────────────────────────
  battle_rifle: {
    name: 'SCAR-H',
    archetype: 'battle_rifle',
    baseStats: {
      damage: 40, penetration: 0.9, rateOfFire: 8, magSize: 20,
      reloadTime: 2.5, adsTime: 0.20, moveSpeed: 0.87, adsSpeed: 0.50,
      spread: { hip: 3.0, ads: 0.8 },
      range: 100, headshotMult: 2.0, fireMode: 'semi', weight: 4.0,
    },
    hipFactor: 1.2, adsFactor: 0.6,
    recoilRecoveryRate: 5,
    spreadPerShot: 0.6,
    tracerColor: 0xffaa44, tracerInterval: 3,
    pelletCount: 1,
    availableModes: ['semi', 'auto'],
    defaultOptic: 'iron_sights',

    hipPos: [0.32, -0.28, -0.5],
    adsPos: [0.0, -0.07, -0.4],
    adsFov: 65,
    drawSpeed: 2.5,
    muzzleOffset: [0, 0.02, -0.70],

    reload: { tiltPitch: 28, tiltRoll: -10, dropY: -0.09 },
    ejectionOffset: [0.06, 0.05, -0.10],
    casingColor: 0xc4a63a,

    parts: {
      body:       { size: [0.10, 0.12, 0.46], color: C.receiver, pos: [0, 0, 0] },
      barrel:     { radius: 0.022, length: 0.40, segments: 8, color: C.barrel, pos: [0, 0.02, -0.40] },
      handguard:  { size: [0.09, 0.09, 0.22], color: C.receiver, pos: [0, 0.01, -0.24] },
      magazine:   { size: [0.07, 0.16, 0.05], color: C.magazine, pos: [0, -0.13, 0.05] },
      stockArm:   { size: [0.08, 0.06, 0.20], color: C.metal, pos: [0, 0.01, 0.32] },
      stockPad:   { size: [0.08, 0.10, 0.02], color: C.dark, pos: [0, 0.01, 0.42] },
      grip:       { size: [0.06, 0.09, 0.035], color: C.grip, pos: [0, -0.09, 0.14], rot: [-0.25, 0, 0] },
      rail:       { size: [0.05, 0.02, 0.28], color: C.accent, pos: [0, 0.075, -0.10] },
      sightRearL: { size: [0.015, 0.025, 0.015], color: C.dark, pos: [-0.03, 0.07, -0.06] },
      sightRearR: { size: [0.015, 0.025, 0.015], color: C.dark, pos: [0.03, 0.07, -0.06] },
      sightFront: { size: [0.015, 0.035, 0.015], color: C.dark, pos: [0, 0.055, -0.58] },
    },
  },

  // ── 7. LMG — M249 ────────────────────────────────────
  lmg: {
    name: 'M249',
    archetype: 'lmg',
    baseStats: {
      damage: 30, penetration: 0.8, rateOfFire: 13, magSize: 200,
      reloadTime: 4.5, adsTime: 0.25, moveSpeed: 0.80, adsSpeed: 0.45,
      spread: { hip: 5.0, ads: 2.5 },
      range: 90, headshotMult: 1.5, fireMode: 'auto', weight: 7.0,
    },
    hipFactor: 1.3, adsFactor: 0.9,
    recoilRecoveryRate: 3,
    spreadPerShot: 0.3,
    tracerColor: 0xffaa44, tracerInterval: 3,
    pelletCount: 1,
    availableModes: ['auto'],
    defaultOptic: 'iron_sights',

    hipPos: [0.34, -0.30, -0.5],
    adsPos: [0.0, -0.10, -0.4],
    adsFov: 65,
    drawSpeed: 2.0,
    muzzleOffset: [0, 0.02, -0.80],

    reload: { tiltPitch: 25, tiltRoll: -12, dropY: -0.10 },
    ejectionOffset: [0.07, 0.05, -0.12],
    casingColor: 0xc4a63a,

    parts: {
      body:       { size: [0.12, 0.13, 0.52], color: C.receiver, pos: [0, 0, 0] },
      barrel:     { radius: 0.024, length: 0.52, segments: 8, color: C.barrel, pos: [0, 0.02, -0.50] },
      handguard:  { size: [0.09, 0.09, 0.26], color: C.receiver, pos: [0, 0.01, -0.28] },
      boxMag:     { size: [0.10, 0.12, 0.09], color: C.magazine, pos: [0, -0.12, 0.02] },
      stock:      { type: 'pyramid', size: [0.08, 0.10, 0.22], color: C.metal, pos: [0, 0.01, 0.34] },
      stockPad:   { size: [0.06, 0.08, 0.015], color: C.dark, pos: [0, 0.01, 0.45] },
      grip:       { size: [0.05, 0.09, 0.035], color: C.grip, pos: [0, -0.09, 0.14], rot: [-0.25, 0, 0] },
      sightRearL: { size: [0.015, 0.025, 0.015], color: C.dark, pos: [-0.03, 0.09, -0.06] },
      sightRearR: { size: [0.015, 0.025, 0.015], color: C.dark, pos: [0.03, 0.09, -0.06] },
      sightFront: { size: [0.015, 0.03, 0.015], color: C.dark, pos: [0, 0.085, -0.74] },
    },
  },

  // ── 8. DMR — MK14 ────────────────────────────────────
  dmr: {
    name: 'MK14',
    archetype: 'dmr',
    baseStats: {
      damage: 45, penetration: 1.0, rateOfFire: 4, magSize: 20,
      reloadTime: 2.2, adsTime: 0.20, moveSpeed: 0.88, adsSpeed: 0.50,
      spread: { hip: 2.5, ads: 0.5 },
      range: 120, headshotMult: 2.5, fireMode: 'semi', weight: 4.2,
    },
    hipFactor: 1.5, adsFactor: 0.5,
    recoilRecoveryRate: 6,
    spreadPerShot: 0.5,
    tracerColor: 0xffaa44, tracerInterval: 2,
    pelletCount: 1,
    availableModes: ['semi'],
    defaultOptic: 'iron_sights',

    hipPos: [0.32, -0.28, -0.5],
    adsPos: [0.0, -0.105, -0.4],
    adsFov: 65,
    drawSpeed: 2.5,
    muzzleOffset: [0, 0.02, -0.76],

    reload: { tiltPitch: 28, tiltRoll: -8, dropY: -0.08 },
    ejectionOffset: [0.05, 0.04, -0.10],
    casingColor: 0xc4a63a,

    parts: {
      body:       { size: [0.09, 0.11, 0.48], color: C.receiver, pos: [0, 0, 0] },
      barrel:     { radius: 0.020, length: 0.48, segments: 8, color: C.barrel, pos: [0, 0.02, -0.46] },
      handguard:  { size: [0.07, 0.07, 0.24], color: C.receiver, pos: [0, 0.01, -0.26] },
      magazine:   { size: [0.06, 0.16, 0.04], color: C.magazine, pos: [0, -0.13, 0.05] },
      stockArmT:  { size: [0.04, 0.02, 0.22], color: C.metal, pos: [0, 0.04, 0.34] },
      stockArmB:  { size: [0.04, 0.02, 0.22], color: C.metal, pos: [0, -0.03, 0.34] },
      stockEnd:   { size: [0.04, 0.09, 0.02], color: C.metal, pos: [0, 0.005, 0.45] },
      stockPad:   { size: [0.06, 0.08, 0.015], color: C.dark, pos: [0, 0.005, 0.46] },
      grip:       { size: [0.05, 0.09, 0.035], color: C.grip, pos: [0, -0.09, 0.14], rot: [-0.25, 0, 0] },
      rail:       { size: [0.04, 0.015, 0.30], color: C.accent, pos: [0, 0.065, -0.12] },
      sightFront: { size: [0.012, 0.03, 0.012], color: C.dark, pos: [0, 0.09, -0.62] },
    },
  },

  // ── 9. SNIPER — M24 ──────────────────────────────────
  sniper: {
    name: 'M24',
    archetype: 'sniper',
    baseStats: {
      damage: 90, penetration: 1.5, rateOfFire: 1, magSize: 5,
      reloadTime: 3.0, adsTime: 0.25, moveSpeed: 0.82, adsSpeed: 0.40,
      spread: { hip: 3.0, ads: 0.2 },
      range: 200, headshotMult: 3.0, fireMode: 'semi', weight: 5.5,
    },
    hipFactor: 1.8, adsFactor: 0.3,
    recoilRecoveryRate: 4,
    spreadPerShot: 0.8,
    tracerColor: 0xffaa44, tracerInterval: 1,
    pelletCount: 1,
    availableModes: ['semi'],
    defaultOptic: 'iron_sights',

    hipPos: [0.34, -0.28, -0.5],
    adsPos: [0.0, -0.065, -0.4],
    adsFov: 65,
    drawSpeed: 2.0,
    muzzleOffset: [0, 0.02, -0.85],

    reload: { tiltPitch: 25, tiltRoll: -6, dropY: -0.09 },
    ejectionOffset: [0.06, 0.05, -0.08],
    casingColor: 0xc4a63a,

    parts: {
      body:       { size: [0.08, 0.10, 0.44], color: C.receiver, pos: [0, 0, 0] },
      barrel:     { radius: 0.020, length: 0.58, segments: 8, color: C.barrel, pos: [0, 0.02, -0.52] },
      boltHandle: { radius: 0.010, length: 0.05, segments: 6, color: C.accent, pos: [0.05, 0.05, -0.04] },
      magazine:   { size: [0.06, 0.08, 0.04], color: C.magazine, pos: [0, -0.09, 0.05] },
      stock:      { type: 'pyramid', size: [0.08, 0.10, 0.30], color: C.wood, pos: [0, 0.01, 0.36] },
      rail:       { size: [0.03, 0.015, 0.24], color: C.accent, pos: [0, 0.065, -0.10] },
      sightFront: { size: [0.012, 0.03, 0.012], color: C.dark, pos: [0, 0.05, -0.78] },
    },
  },

  // ── 10. SHOTGUN — M870 ────────────────────────────────
  shotgun: {
    name: 'M870',
    archetype: 'shotgun',
    baseStats: {
      damage: 12, penetration: 0.2, rateOfFire: 1.2, magSize: 6,
      reloadTime: 3.0, adsTime: 0.18, moveSpeed: 0.92, adsSpeed: 0.55,
      spread: { hip: 8.0, ads: 5.0 },
      range: 20, headshotMult: 1.5, fireMode: 'pump', weight: 3.5,
    },
    hipFactor: 0.5, adsFactor: 0.8,
    recoilRecoveryRate: 4,
    spreadPerShot: 0.5,
    tracerColor: 0xffaa44, tracerInterval: 1,
    pelletCount: 8,
    shellReloadTime: 0.5,   // per-shell reload for shotgun
    availableModes: ['pump'],
    defaultOptic: 'iron_sights',

    hipPos: [0.32, -0.28, -0.5],
    adsPos: [0.0, -0.06, -0.4],
    adsFov: 65,
    drawSpeed: 2.8,
    muzzleOffset: [0, 0.02, -0.72],

    reload: { tiltPitch: 30, tiltRoll: -8, dropY: -0.07 },
    ejectionOffset: [0.06, 0.04, -0.10],
    casingColor: 0xcc3333,  // red shotgun shell

    parts: {
      body:       { size: [0.10, 0.11, 0.38], color: C.receiver, pos: [0, 0, 0] },
      barrel:     { radius: 0.028, length: 0.50, segments: 8, color: C.barrel, pos: [0, 0.02, -0.42] },
      pumpSlide:  { radius: 0.023, length: 0.14, segments: 8, color: C.accent, pos: [0, -0.01, -0.28] },
      stock:      { type: 'pyramid', size: [0.08, 0.10, 0.24], color: C.metal, pos: [0, 0.01, 0.30] },
      stockPad:   { size: [0.06, 0.08, 0.015], color: C.dark, pos: [0, 0.01, 0.42] },
      grip:       { size: [0.05, 0.09, 0.035], color: C.grip, pos: [0, -0.09, 0.12], rot: [-0.25, 0, 0] },
      sightFront: { size: [0.015, 0.025, 0.015], color: C.accent, pos: [0, 0.05, -0.65] },
    },
  },
};

// Generate recoil patterns for all weapons
for (const [key, def] of Object.entries(WEAPON_DEFS)) {
  const shape = RECOIL_SHAPES[def.archetype];
  def.recoilPattern = generateRecoilPattern(shape, def.baseStats.magSize);
}

// ─── LEGACY STATS BRIDGE ──────────────────────────────────
// Provides backward-compatible stats object for existing code
for (const def of Object.values(WEAPON_DEFS)) {
  const bs = def.baseStats;
  def.stats = {
    ammo: bs.magSize,
    maxAmmo: bs.magSize,
    fireRate: Math.round(1000 / bs.rateOfFire),
    reloadTime: Math.round(bs.reloadTime * 1000),
    damage: bs.damage,
    penetration: bs.penetration,
    spread: bs.spread.hip * (Math.PI / 180),  // legacy: radians
    range: bs.range,
    tracerColor: def.tracerColor,
  };
}

// ─── WEAPON ORDER ─────────────────────────────────────────
// Default loadout: pistol + carbine (per spec §8.1)
export const WEAPON_ORDER = ['pistol', 'carbine'];

// All available weapons for testing
export const ALL_WEAPONS = [
  'pistol', 'revolver', 'smg', 'carbine', 'ar',
  'battle_rifle', 'lmg', 'dmr', 'sniper', 'shotgun',
];

// ─── COMPUTE STATS ────────────────────────────────────────
// Applies attachment modifiers multiplicatively to base stats.
// Returns a new stats object (does not mutate the weapon def).
// `attachments` can be:
//   - An array of attachment def objects (legacy)
//   - A loadout-style object { muzzle: 'suppressor', barrel: null, ... }
export function computeStats(weaponDef, attachments) {
  const bs = weaponDef.baseStats;
  const stats = {
    damage: bs.damage,
    penetration: bs.penetration,
    rateOfFire: bs.rateOfFire,
    magSize: bs.magSize,
    reloadTime: bs.reloadTime,
    adsTime: bs.adsTime,
    moveSpeed: bs.moveSpeed,
    adsSpeed: bs.adsSpeed,
    spread: { hip: bs.spread.hip, ads: bs.spread.ads },
    range: bs.range,
    headshotMult: bs.headshotMult,
    fireMode: bs.fireMode,
    weight: bs.weight,
  };

  // Collect recoil modifiers from attachments
  let recoilVertMult = 1.0;
  let recoilHorizMult = 1.0;

  const attList = resolveAttachments(attachments);
  for (const att of attList) {
    if (!att.modifiers) continue;
    for (const [stat, modifier] of Object.entries(att.modifiers)) {
      if (stat === 'spread.hip') stats.spread.hip *= (1 + modifier);
      else if (stat === 'spread.ads') stats.spread.ads *= (1 + modifier);
      else if (stats[stat] !== undefined) stats[stat] *= (1 + modifier);
    }
    if (att.recoilMods) {
      if (att.recoilMods.vertical !== undefined) recoilVertMult *= (1 + att.recoilMods.vertical);
      if (att.recoilMods.horizontal !== undefined) recoilHorizMult *= (1 + att.recoilMods.horizontal);
    }
  }

  stats.recoilVertMult = recoilVertMult;
  stats.recoilHorizMult = recoilHorizMult;
  stats.magSize = Math.round(stats.magSize); // keep integer

  return stats;
}

// Resolve attachments to an array of ATTACHMENT_DEFS entries.
// Accepts array of defs, loadout-style { slot: key }, or null.
function resolveAttachments(attachments) {
  if (!attachments) return [];
  if (Array.isArray(attachments)) {
    return attachments.filter(a => a && a.modifiers);
  }
  // Loadout-style object: { muzzle: 'suppressor', barrel: null, ... }
  const result = [];
  for (const key of Object.values(attachments)) {
    if (key && ATTACHMENT_DEFS[key]) result.push(ATTACHMENT_DEFS[key]);
  }
  return result;
}

// ─── STANCE MODIFIERS ─────────────────────────────────────
export const STANCE_MODIFIERS = {
  standing_still:   { spreadHip: 1.0,  spreadAds: 1.0,  recoil: 1.0  },
  walking:          { spreadHip: 1.3,  spreadAds: 1.0,  recoil: 1.1  },
  sprinting:        { spreadHip: 1.8,  spreadAds: 1.8,  recoil: 1.5  },
  crouched_still:   { spreadHip: 0.85, spreadAds: 0.85, recoil: 0.85 },
  crouched_moving:  { spreadHip: 1.0,  spreadAds: 0.9,  recoil: 0.9  },
  airborne:         { spreadHip: 2.5,  spreadAds: 2.0,  recoil: 1.5  },
};

// ─── ATTACHMENT DEFINITIONS ───────────────────────────────
// Data-only for now; attachment application is a later implementation step.
export const ATTACHMENT_DEFS = {
  // Muzzle
  suppressor:   { slot: 'muzzle', name: 'Suppressor',   modifiers: { damage: -0.10, range: -0.05 } },
  compensator:  { slot: 'muzzle', name: 'Compensator',  modifiers: {}, recoilMods: { vertical: -0.20, horizontal: 0.10 } },
  flash_hider:  { slot: 'muzzle', name: 'Flash Hider',  modifiers: {}, recoilMods: { vertical: -0.10 } },
  muzzle_brake: { slot: 'muzzle', name: 'Muzzle Brake', modifiers: {}, recoilMods: { vertical: 0.05, horizontal: -0.15 } },

  // Barrel
  long_barrel:  { slot: 'barrel', name: 'Long Barrel',  modifiers: { range: 0.15, 'spread.ads': -0.10, adsTime: 0.10, moveSpeed: -0.03 } },
  short_barrel: { slot: 'barrel', name: 'Short Barrel', modifiers: { range: -0.15, 'spread.ads': 0.10, adsTime: -0.10, moveSpeed: 0.03 } },
  heavy_barrel: { slot: 'barrel', name: 'Heavy Barrel', modifiers: { 'spread.hip': -0.20, 'spread.ads': -0.20, adsTime: 0.15, moveSpeed: -0.05 } },

  // Underbarrel
  vertical_grip: { slot: 'underbarrel', name: 'Vertical Grip', modifiers: { adsTime: 0.05 }, recoilMods: { vertical: -0.15 } },
  angled_grip:   { slot: 'underbarrel', name: 'Angled Grip',   modifiers: { adsTime: -0.10 }, recoilMods: { vertical: -0.05 } },
  stubby_grip:   { slot: 'underbarrel', name: 'Stubby Grip',   modifiers: { adsTime: 0.05 } },
  bipod:         { slot: 'underbarrel', name: 'Bipod',         modifiers: { adsTime: 0.15 }, recoilMods: { vertical: -0.60, horizontal: -0.60 } },

  // Magazine
  extended_mag: { slot: 'magazine', name: 'Extended Mag', modifiers: { magSize: 0.50, reloadTime: 0.15 } },
  fast_mag:     { slot: 'magazine', name: 'Fast Mag',     modifiers: { reloadTime: -0.30 } },
  drum_mag:     { slot: 'magazine', name: 'Drum Mag',     modifiers: { magSize: 1.00, reloadTime: 0.30, adsTime: -0.05, moveSpeed: -0.03 } },

  // Stock
  full_stock:     { slot: 'stock', name: 'Full Stock',     modifiers: { adsTime: 0.10, moveSpeed: -0.05 }, recoilMods: { vertical: -0.20, horizontal: -0.20 } },
  skeleton_stock: { slot: 'stock', name: 'Skeleton Stock', modifiers: { adsTime: -0.10, moveSpeed: 0.03 }, recoilMods: { vertical: 0.10, horizontal: 0.10 } },
};

// ─── OPTIC DEFINITIONS ────────────────────────────────────
export const OPTIC_DEFS = {
  iron_sights:   { name: 'Iron Sights',    zoom: 1.0,  fov: 65, reticle: 'none',           scoped: false },
  red_dot:       { name: 'Red Dot',        zoom: 1.0,  fov: 65, reticle: 'red_dot',        scoped: false },
  holographic:   { name: 'Holographic',    zoom: 1.0,  fov: 65, reticle: 'holographic',    scoped: false },
  acog:          { name: 'ACOG 4x',        zoom: 4.0,  fov: 20, reticle: 'acog',           scoped: true  },
  dmr_scope:     { name: 'DMR Scope 6x',   zoom: 6.0,  fov: 12, reticle: 'mil_dot',        scoped: true  },
  sniper_scope:  { name: 'Sniper 8x',      zoom: 8.0,  fov: 8,  reticle: 'fine_crosshair', scoped: true  },
  sniper_12x:    { name: 'Sniper 12x',     zoom: 12.0, fov: 5,  reticle: 'fine_crosshair', scoped: true  },
  thermal:       { name: 'Thermal 2.5x',   zoom: 2.5,  fov: 30, reticle: 'fine_crosshair', scoped: false },
};

// ─── ATTACHMENT EXCLUSIONS ───────────────────────────────
// Attachments that don't make sense for certain archetypes.
export const ATTACHMENT_EXCLUSIONS = {
  drum_mag:       new Set(['revolver', 'sniper', 'shotgun', 'pistol']),
  extended_mag:   new Set(['revolver']),
  fast_mag:       new Set(['revolver']),
  bipod:          new Set(['pistol', 'revolver', 'shotgun']),
  vertical_grip:  new Set(['pistol', 'revolver']),
  angled_grip:    new Set(['pistol', 'revolver']),
  stubby_grip:    new Set(['pistol', 'revolver']),
  full_stock:     new Set(['pistol', 'revolver']),
  skeleton_stock: new Set(['pistol', 'revolver']),
  suppressor:     new Set(['revolver', 'shotgun']),
  compensator:    new Set(['revolver', 'shotgun']),
  flash_hider:    new Set(['revolver', 'shotgun']),
  muzzle_brake:   new Set(['revolver', 'shotgun']),
  long_barrel:    new Set(['pistol', 'revolver']),
  short_barrel:   new Set(['pistol', 'revolver']),
  heavy_barrel:   new Set(['pistol', 'revolver']),
};

// ─── RANDOM WEAPON GENERATION ────────────────────────────

const WEAPON_POOLS = {
  early:  ['pistol', 'smg', 'carbine', 'shotgun'],
  mid:    ['pistol', 'smg', 'carbine', 'shotgun', 'ar', 'battle_rifle'],
  late:   ['pistol', 'smg', 'carbine', 'shotgun', 'ar', 'battle_rifle', 'lmg', 'dmr', 'sniper'],
};

function getWeaponPool(waveNumber) {
  if (waveNumber <= 3) return WEAPON_POOLS.early;
  if (waveNumber <= 6) return WEAPON_POOLS.mid;
  return WEAPON_POOLS.late;
}

function isAttachmentAllowed(attKey, archetype) {
  const excl = ATTACHMENT_EXCLUSIONS[attKey];
  return !excl || !excl.has(archetype);
}

/** Pick N random compatible attachments for a weapon. */
export function pickRandomAttachments(weaponKey, count) {
  const archetype = WEAPON_DEFS[weaponKey].archetype;
  const result = { muzzle: null, barrel: null, underbarrel: null, magazine: null, optic: 'iron_sights', accessory: null };
  if (count <= 0) return result;

  // Collect allowed attachments grouped by slot
  const bySlot = {};
  for (const [key, att] of Object.entries(ATTACHMENT_DEFS)) {
    if (!isAttachmentAllowed(key, archetype)) continue;
    if (!bySlot[att.slot]) bySlot[att.slot] = [];
    bySlot[att.slot].push(key);
  }

  // Also add optics (non-iron)
  const opticKeys = Object.keys(OPTIC_DEFS).filter(k => k !== 'iron_sights');
  bySlot.optic = opticKeys;

  // Pick from random slots
  const slots = Object.keys(bySlot).filter(s => bySlot[s].length > 0);
  const shuffled = slots.sort(() => Math.random() - 0.5);
  let picked = 0;
  for (const slot of shuffled) {
    if (picked >= count) break;
    const options = bySlot[slot];
    const choice = options[Math.floor(Math.random() * options.length)];
    result[slot] = choice;
    picked++;
  }
  return result;
}

/** Generate a random weapon loadout for a crate. */
export function generateRandomWeapon(waveNumber) {
  const pool = getWeaponPool(waveNumber);
  const weaponKey = pool[Math.floor(Math.random() * pool.length)];
  const attCount = Math.floor(Math.random() * 3); // 0-2
  const attachments = pickRandomAttachments(weaponKey, attCount);
  return { weapon: weaponKey, attachments };
}

/** Get compatible attachments for a weapon (for reward selection). */
export function getCompatibleAttachments(weaponKey) {
  const archetype = WEAPON_DEFS[weaponKey].archetype;
  const result = [];
  for (const [key, att] of Object.entries(ATTACHMENT_DEFS)) {
    if (isAttachmentAllowed(key, archetype)) {
      result.push({ key, ...att });
    }
  }
  return result;
}
