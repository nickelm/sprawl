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
  currentWeapon: 'assault_rifle',
  dead: false,
  sprintActive: false,
  ads: false,
  adsBlend: 0,
  lastShotTime: 0,
  fireRate: 150,
  reloadTime: 2000,

  // Wave system
  wave: 0,
  waveActive: false,
  wavePause: true,      // true = between waves (intermission)
  waveTimer: 0,         // countdown for intermission or spawn stagger
  waveEnemiesTotal: 0,  // total enemies this wave
  waveEnemiesAlive: 0,  // currently alive wave enemies
  waveEnemiesSpawned: 0,// how many spawned so far this wave
  waveSpawnTimer: 0,    // stagger timer for spawning
};

// Shared game object arrays — live references, mutations visible everywhere
export const enemies = [];
export const pickups = [];
export const bullets = [];
export const enemyBullets = [];

// Constants
export const CHUNK_SIZE = 60;
export const RENDER_DIST = 3;
export const PLAYER_HEIGHT = 1.7;
export const PLAYER_RADIUS = 0.4;
export const MOVE_SPEED = 6;
export const SPRINT_MULT = 1.6;
export const MOUSE_SENS = 0.002;
export const GRAVITY = -20;
export const ENEMY_MELEE_RANGE = 2.5;
export const ENEMY_SHOOT_RANGE = 30;
export const ENEMY_MELEE_DAMAGE = 15;
export const ENEMY_BULLET_DAMAGE = 8;

// Cover AI
export const COVER_SEARCH_RADIUS = 25;
export const ENGAGE_RANGE = 25;
export const RETREAT_HEALTH_PCT = 0.4;
export const PEEK_DURATION = 1.3;
export const PEEK_OFFSET = 1.0;
export const COVER_WAIT_MIN = 1.0;
export const COVER_WAIT_MAX = 3.0;
export const COVER_TIMEOUT = 8.0;
