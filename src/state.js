// ─── GAME STATE ────────────────────────────────────────────
export const STATE = {
  started: false,
  health: 100,
  maxHealth: 100,
  ammo: 30,
  maxAmmo: 30,
  score: 0,
  distance: 0,
  reloading: false,
  reloadProgress: 0,
  currentWeapon: 'carbine',
  dead: false,
  dying: false,            // death animation in progress
  sprintActive: false,
  ads: false,
  onLadder: false,
  adsBlend: 0,
  lastShotTime: 0,
  fireRate: 150,
  reloadTime: 2000,

  // Weapon system (steps 1-6)
  shotCount: 0,
  sustainedFireMult: 1.0,
  mouseHeld: false,
  fireMode: 'auto',
  currentSpread: 0,
  isCrouching: false,
  isMoving: false,
  isGrounded: true,
  isSprinting: false,
  adsHeld: false,

  // Wave system
  wave: 0,
  waveActive: false,
  wavePause: true,      // true = between waves (intermission)
  waveTimer: 0,         // countdown for intermission or spawn stagger
  waveEnemiesTotal: 0,  // total enemies this wave
  waveEnemiesAlive: 0,  // currently alive wave enemies
  waveEnemiesSpawned: 0,// how many spawned so far this wave
  waveSpawnTimer: 0,    // stagger timer for spawning

  // Player health model (regen + damage tracking)
  timeSinceLastDamage: 99,   // high initial value so no regen delay at start
  isRegenerating: false,
  lastDamageDirection: null,  // THREE.Vector3 or null

  // Fall damage stun
  fallStunTimer: 0,
  fallStunSpeedMult: 1.0,

  // Death animation
  deathTimer: 0,

  // Workbench
  workbenchOpen: false,

  // Night vision
  nvActive: false,

  // Loadout (persisted across pallet visits)
  loadout: {
    primary:   { weapon: 'carbine', attachments: { muzzle: null, barrel: null, underbarrel: null, magazine: null, optic: 'iron_sights', accessory: null }, colors: {} },
    secondary: { weapon: 'pistol',  attachments: { muzzle: null, barrel: null, underbarrel: null, magazine: null, optic: 'iron_sights', accessory: null }, colors: {} },
  },
};

// Shared game object arrays — live references, mutations visible everywhere
export const enemies = [];
export const pickups = [];
export const pallets = [];
export const bullets = [];
export const enemyBullets = [];
export const weaponCrates = [];

// Constants
export const CHUNK_SIZE = 60;
export const RENDER_DIST = 3;
export const PLAYER_HEIGHT = 1.7;
export const PLAYER_RADIUS = 0.3;
export const MOVE_SPEED = 6;
export const SPRINT_MULT = 1.6;
export const MOUSE_SENS = 0.002;
export const GRAVITY = -20;
export const PLAYER_HALF_W = 0.3;
export const JUMP_IMPULSE = 8;
export const STEP_HEIGHT = 0.35;
export const CROUCH_HEIGHT = 1.0;
export const CROUCH_EYE = 0.9;
export const CROUCH_SPEED_MULT = 0.6;
export const PLAYER_EYE_HEIGHT = 1.6;
export const LADDER_CLIMB_SPEED = 2.0;
export const LADDER_YAW_LIMIT = Math.PI / 3;   // ±60°
export const LADDER_DISMOUNT_IMPULSE = 3.0;
export const LADDER_INTERACT_RANGE = 1.0;
export const PALLET_INTERACT_RANGE = 2.5;
export const ENEMY_MELEE_RANGE = 2.5;
export const ENEMY_SHOOT_RANGE = 30;
export const ENEMY_MELEE_DAMAGE = 15;
export const ENEMY_BULLET_DAMAGE = 8;

// Player health regen
export const REGEN_DELAY = 3.0;     // seconds after last damage before regen starts
export const REGEN_RATE = 15;        // HP per second during regen

// Enemy weapon stats per type
const DEG = Math.PI / 180;
export const ENEMY_WEAPON_STATS = {
  rifleman: {
    damage: 8, penetration: 0.6, range: 60,
    spreadMin: 3 * DEG, spreadMax: 5 * DEG,
    fireRate: 400, burstSize: 3,
    tracerColor: 0x44ff44,
  },
  flanker: {
    damage: 6, penetration: 0.4, range: 40,
    spreadMin: 5 * DEG, spreadMax: 8 * DEG,
    fireRate: 300, burstSize: 2,
    tracerColor: 0x44ff44,
  },
  heavy: {
    damage: 5, penetration: 0.8, range: 50,
    spreadMin: 6 * DEG, spreadMax: 10 * DEG,
    fireRate: 100, burstSize: 6,
    tracerColor: 0xff4444,
  },
};

// Cover AI
export const COVER_SEARCH_RADIUS = 25;
export const ENGAGE_RANGE = 25;
export const RETREAT_HEALTH_PCT = 0.4;
export const PEEK_DURATION = 1.3;
export const PEEK_OFFSET = 1.0;
export const COVER_WAIT_MIN = 1.0;
export const COVER_WAIT_MAX = 3.0;
export const COVER_TIMEOUT = 8.0;
