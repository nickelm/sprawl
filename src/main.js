import { STATE, enemies, pallets } from './state.js';
import { renderer, scene, camera, initRenderer, handleResize, updateShadowCamera, setDayTime, dayTime } from './renderer.js';
import { initPlayer, updatePlayer, resetPlayer, setOnPalletInteract } from './player.js';
import { updateEnemies, updatePickups, clearAllEnemyBullets, updateDyingEnemies } from './enemies.js';
import { updateDamageNumbers, clearDamageNumbers } from './damageNumbers.js';
import { updateChunks, chunks, removeChunk, updatePallets, updateWeaponCrates, clearWeaponCrates } from './world.js';
import { updateHUD, hideStartScreen, hideDeathScreen, updateFPS, updateHealthEffects, resetHealthEffects } from './hud.js';
import { initAudio } from './audio.js';
import { initWaves, updateWaves } from './waves.js';
import { initWeaponView, updateWeaponView, resetWeaponView, initWeaponAmmo, switchWeapon, rebuildCurrentWeapon } from './weaponView.js';
import { WEAPON_DEFS } from './weaponDefs.js';
import { updateWeapons, invalidateStatsCache, applyStatsToState } from './weapons.js';
import { initCrosshair } from './reticles.js';
import { randomizeWorldSeed, worldSeed } from './utils.js';
import { reseedTerrain } from './terrain.js';
import { updateDebris } from './debris.js';
import { updateCollapseQueue } from './destruction.js';
import { openWorkbench, closeWorkbench, isWorkbenchOpen } from './workbench.js';
import { initPostFX, updatePostFXBlend, postFXActive, renderWithPostFX, resizePostFX, setPostFXMode, getPostFXInputTarget, applyPostFX } from './postfx.js';


// ─── GAME LOOP ─────────────────────────────────────────────
let lastTime = 0;
let _fpsFrames = 0;
let _fpsTimer = 0;

function gameLoop(time) {
  requestAnimationFrame(gameLoop);
  if (!STATE.started) return;

  const dt = Math.min((time - lastTime) / 1000, 0.05);
  lastTime = time;

  // Workbench open — freeze gameplay, workbench has its own render loop
  if (STATE.workbenchOpen) return;

  _fpsFrames++;
  _fpsTimer += dt;
  if (_fpsTimer >= 0.5) {
    updateFPS(Math.round(_fpsFrames / _fpsTimer));
    _fpsFrames = 0;
    _fpsTimer = 0;
  }

  updatePlayer(dt);
  updateHealthEffects(dt);
  updateWeapons(dt);
  updateWeaponView(dt);
  updateShadowCamera();
  updateChunks();
  updateEnemies(dt);
  updatePickups(dt);
  updateWaves(dt);
  updateDyingEnemies(dt);
  updateDamageNumbers(dt);
  updateDebris(dt);
  updateCollapseQueue(dt);
  updatePallets(dt);
  updateWeaponCrates(dt);

  updatePostFXBlend(dt);

  if (postFXActive()) {
    renderer.setRenderTarget(getPostFXInputTarget());
    renderer.render(scene, camera);
    applyPostFX(scene, camera);
  } else {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }
}

// ─── START / RESTART ───────────────────────────────────────
function startGame() {
  STATE.started = true;
  STATE.health = 100;
  invalidateStatsCache();
  applyStatsToState();
  STATE.ammo = STATE.maxAmmo;
  STATE.score = 0;
  STATE.distance = 0;
  STATE.dead = false;
  STATE.dying = false;
  STATE.deathTimer = 0;
  STATE.reloading = false;
  STATE.reloadProgress = 0;
  STATE.fireMode = WEAPON_DEFS[STATE.currentWeapon].baseStats.fireMode;
  STATE.timeSinceLastDamage = 99;
  STATE.isRegenerating = false;
  STATE.lastDamageDirection = null;
  STATE.fallStunTimer = 0;
  STATE.fallStunSpeedMult = 1.0;
  STATE.shotCount = 0;
  STATE.sustainedFireMult = 1.0;
  STATE.mouseHeld = false;
  STATE.currentSpread = 0;
  STATE.adsHeld = false;
  STATE.isCrouching = false;
  STATE.isMoving = false;
  STATE.isGrounded = true;
  STATE.isSprinting = false;
  STATE.nvActive = false;
  setPostFXMode('none');

  // Restore saved loadout or use defaults
  const defaultLoadout = {
    primary:   { weapon: 'carbine', attachments: { muzzle: null, barrel: null, underbarrel: null, magazine: null, optic: 'iron_sights', accessory: null }, colors: {} },
    secondary: { weapon: 'pistol',  attachments: { muzzle: null, barrel: null, underbarrel: null, magazine: null, optic: 'iron_sights', accessory: null }, colors: {} },
  };
  try {
    const saved = localStorage.getItem('sprawl_loadout');
    STATE.loadout = saved ? JSON.parse(saved) : defaultLoadout;
  } catch { STATE.loadout = defaultLoadout; }
  STATE.currentWeapon = STATE.loadout.primary.weapon;
  pallets.length = 0;
  clearWeaponCrates();

  // Randomize world seed for a new map layout
  randomizeWorldSeed();
  reseedTerrain(worldSeed);

  // Clear old world state
  for (const [key] of chunks) {
    const [cx, cz] = key.split(',').map(Number);
    removeChunk(cx, cz);
  }
  clearAllEnemyBullets();

  resetPlayer();
  resetWeaponView();
  resetHealthEffects();
  initWeaponAmmo();
  clearDamageNumbers();
  initWaves();
  updateHUD();
  updateChunks();

  document.getElementById('game-canvas').requestPointerLock();
  hideStartScreen();
  hideDeathScreen();

  lastTime = performance.now();
}

// ─── INIT ──────────────────────────────────────────────────
initRenderer();
initPostFX(renderer, scene);
initPlayer();
initWeaponView();
initCrosshair();
initAudio();

window.addEventListener('resize', () => {
  handleResize();
  resizePostFX(window.innerWidth, window.innerHeight);
});
document.getElementById('start-screen').addEventListener('click', startGame);
document.getElementById('death-screen').addEventListener('click', startGame);

// ─── LOADOUT WORKBENCH ────────────────────────────────────
function openLoadoutWorkbench() {
  if (STATE.workbenchOpen || STATE.dead || !STATE.started) return;
  STATE.workbenchOpen = true;
  document.exitPointerLock();
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';

  const resumeGame = (loadout) => {
    if (loadout) {
      STATE.loadout = loadout;
      try { localStorage.setItem('sprawl_loadout', JSON.stringify(loadout)); } catch {}
      if (loadout.primary.weapon !== STATE.currentWeapon) {
        switchWeapon(loadout.primary.weapon);
      } else {
        // Same weapon but attachments may have changed — rebuild (Step 10e)
        rebuildCurrentWeapon();
      }
    }
    STATE.workbenchOpen = false;
    if (hud) hud.style.display = '';
    document.getElementById('game-canvas').requestPointerLock();
  };

  openWorkbench(renderer, camera, scene,
    STATE.loadout, null,
    {
      devMode: false,
      onConfirm: (loadout) => resumeGame(loadout),
      onCancel: () => resumeGame(null),
    }
  );
}

// Wire pallet interaction callback
setOnPalletInteract(openLoadoutWorkbench);

// Attachment applied event (from choice UI) — rebuild weapon (Step 14d)
window.addEventListener('attachment-applied', () => {
  rebuildCurrentWeapon();
});

// T key cycles through: noon → dusk → midnight → dawn → noon
const DAY_CYCLE = [0.5, 0.75, 0.0, 0.25];
let dayCycleIdx = 0;
document.addEventListener('keydown', e => {
  if (e.code === 'KeyT') {
    dayCycleIdx = (dayCycleIdx + 1) % DAY_CYCLE.length;
    setDayTime(DAY_CYCLE[dayCycleIdx]);
  }


});


// Initial chunk generation (renders city before game starts)
updateChunks();
requestAnimationFrame(gameLoop);
