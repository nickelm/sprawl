// ─── WEAPON DEFINITIONS ─────────────────────────────────────
// Data-only configs. Parts keyed by role:
//   barrel → CylinderGeometry (radius, length, segments)
//   everything else → BoxGeometry (size [w,h,d])

export const WEAPON_DEFS = {
  assault_rifle: {
    name: 'ASSAULT RIFLE',
    stats: {
      ammo: 30,
      maxAmmo: 30,
      fireRate: 150,
      reloadTime: 2000,
      damage: 25,
    },
    hipPos: [0.32, -0.28, -0.5],
    adsPos: [0.0, -0.17, -0.4],
    adsFov: 55,
    adsSpeed: 12,
    drawSpeed: 3.0,    // seconds⁻¹ for switch animation (lower/raise)
    muzzleOffset: [0, 0.02, -0.68],

    reload: {
      tiltPitch: 30,   // degrees barrel tips up
      tiltRoll: -10,   // degrees weapon twists
      dropY: -0.08,    // how far weapon drops
    },

    parts: {
      body:       { size: [0.12, 0.14, 0.55], color: 0x2a2a2a, pos: [0, 0, 0] },
      barrel:     { radius: 0.025, length: 0.45, segments: 8, color: 0x1a1a1a, pos: [0, 0.02, -0.45] },
      magazine:   { size: [0.08, 0.18, 0.06], color: 0x222222, pos: [0, -0.14, 0.05] },
      stock:      { size: [0.10, 0.10, 0.25], color: 0x2a2a2a, pos: [0, 0.01, 0.35] },
      sightRearL: { size: [0.02, 0.04, 0.02], color: 0x1a1a1a, pos: [-0.04, 0.09, -0.08] },
      sightRearR: { size: [0.02, 0.04, 0.02], color: 0x1a1a1a, pos: [0.04, 0.09, -0.08] },
      sightFront: { size: [0.02, 0.065, 0.02], color: 0x1a1a1a, pos: [0, 0.077, -0.62] },
    },
  },

  pistol: {
    name: 'PISTOL',
    stats: {
      ammo: 12,
      maxAmmo: 12,
      fireRate: 250,
      reloadTime: 1500,
      damage: 35,
    },
    hipPos: [0.28, -0.30, -0.45],
    adsPos: [0.0, -0.19, -0.38],
    adsFov: 60,
    adsSpeed: 20,
    drawSpeed: 5.0,    // pistol draws faster
    muzzleOffset: [0, 0.02, -0.38],

    reload: {
      tiltPitch: 40,
      tiltRoll: -5,
      dropY: -0.06,
    },

    parts: {
      body:       { size: [0.08, 0.12, 0.22], color: 0x2a2a2a, pos: [0, 0, 0] },
      barrel:     { radius: 0.018, length: 0.18, segments: 8, color: 0x1a1a1a, pos: [0, 0.02, -0.18] },
      magazine:   { size: [0.05, 0.10, 0.04], color: 0x222222, pos: [0, -0.10, 0.02] },
      sightRearL: { size: [0.015, 0.025, 0.015], color: 0x1a1a1a, pos: [-0.025, 0.08, -0.02] },
      sightRearR: { size: [0.015, 0.025, 0.015], color: 0x1a1a1a, pos: [0.025, 0.08, -0.02] },
      sightFront: { size: [0.015, 0.035, 0.015], color: 0x1a1a1a, pos: [0, 0.055, -0.25] },
    },
  },
};

export const WEAPON_ORDER = ['assault_rifle', 'pistol'];
