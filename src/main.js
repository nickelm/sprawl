import { STATE, enemies, enemyBullets } from './state.js';
import { renderer, scene, camera, initRenderer, handleResize, updateShadowCamera, setDayTime, dayTime } from './renderer.js';
import { initPlayer, updatePlayer, resetPlayer } from './player.js';
import { updateEnemies, updatePickups, clearAllEnemyBullets, updateDyingEnemies } from './enemies.js';
import { updateDamageNumbers, clearDamageNumbers } from './damageNumbers.js';
import { updateChunks, chunks, removeChunk } from './world.js';
import { updateHUD, hideStartScreen, hideDeathScreen, updateFPS } from './hud.js';
import { initAudio } from './audio.js';
import { initWaves, updateWaves } from './waves.js';
import { initWeaponView, updateWeaponView, resetWeaponView, initWeaponAmmo } from './weaponView.js';
import { WEAPON_DEFS } from './weaponDefs.js';

// ─── GAME LOOP ─────────────────────────────────────────────
let lastTime = 0;
let _fpsFrames = 0;
let _fpsTimer = 0;

function gameLoop(time) {
  requestAnimationFrame(gameLoop);
  if (!STATE.started) return;

  const dt = Math.min((time - lastTime) / 1000, 0.05);
  lastTime = time;

  _fpsFrames++;
  _fpsTimer += dt;
  if (_fpsTimer >= 0.5) {
    updateFPS(Math.round(_fpsFrames / _fpsTimer));
    _fpsFrames = 0;
    _fpsTimer = 0;
  }

  updatePlayer(dt);
  updateWeaponView(dt);
  updateShadowCamera();
  updateChunks();
  updateEnemies(dt);
  updatePickups(dt);
  updateWaves(dt);
  updateDyingEnemies(dt);
  updateDamageNumbers(dt);

  renderer.render(scene, camera);
}

// ─── START / RESTART ───────────────────────────────────────
function startGame() {
  STATE.started = true;
  STATE.health = 100;
  const wDef = WEAPON_DEFS[STATE.currentWeapon].stats;
  STATE.ammo = wDef.ammo;
  STATE.maxAmmo = wDef.maxAmmo;
  STATE.fireRate = wDef.fireRate;
  STATE.reloadTime = wDef.reloadTime;
  STATE.score = 0;
  STATE.distance = 0;
  STATE.dead = false;
  STATE.reloading = false;
  STATE.reloadProgress = 0;

  // Clear old world state
  for (const [key] of chunks) {
    const [cx, cz] = key.split(',').map(Number);
    removeChunk(cx, cz);
  }
  clearAllEnemyBullets();

  resetPlayer();
  resetWeaponView();
  initWeaponAmmo();
  clearDamageNumbers();
  initWaves();
  updateHUD();
  updateChunks();

  document.getElementById('game-canvas').requestPointerLock();
  hideStartScreen();
  hideDeathScreen();

  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

// ─── INIT ──────────────────────────────────────────────────
initRenderer();
initPlayer();
initWeaponView();
initAudio();

window.addEventListener('resize', handleResize);
document.getElementById('start-screen').addEventListener('click', startGame);
document.getElementById('death-screen').addEventListener('click', startGame);

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
