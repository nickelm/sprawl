import { STATE } from './state.js';
import { addScreenShake } from './player.js';

// ─── DOM REFS ──────────────────────────────────────────────
const healthFill = document.getElementById('health-bar-fill');
const healthValue = document.getElementById('health-value');
const ammoCount = document.getElementById('ammo-count');
const ammoLabel = document.getElementById('ammo-label');
const scoreValue = document.getElementById('score-value');
const distanceValue = document.getElementById('distance-value');
const killFeed = document.getElementById('kill-feed');
const damageFlash = document.getElementById('damage-flash');
const hitMarker = document.getElementById('hit-marker');
const muzzleFlash = document.getElementById('muzzle-flash');
const startScreen = document.getElementById('start-screen');
const deathScreen = document.getElementById('death-screen');
const deathStats = document.getElementById('death-stats');
const gameCanvas = document.getElementById('game-canvas');
const fpsDisplay = document.getElementById('fps-display');

export function updateFPS(fps) {
  fpsDisplay.textContent = `${fps} FPS`;
}

export function updateHUD() {
  healthFill.style.width = `${STATE.health}%`;
  healthValue.textContent = Math.max(0, STATE.health);
  ammoCount.textContent = STATE.ammo;
  scoreValue.textContent = STATE.score;
  distanceValue.textContent = `${Math.floor(STATE.distance)}m`;
}

export function addKillFeed(type) {
  const entry = document.createElement('div');
  entry.className = 'kill-entry';
  entry.textContent = `\u00d7 ${type} ELIMINATED`;
  killFeed.appendChild(entry);
  setTimeout(() => {
    entry.style.opacity = '0';
    setTimeout(() => entry.remove(), 1000);
  }, 2000);
}

export function showDamageFlash() {
  damageFlash.style.opacity = '1';
  setTimeout(() => { damageFlash.style.opacity = '0'; }, 200);
}

export function showMuzzleFlash() {
  muzzleFlash.style.opacity = '1';
  setTimeout(() => { muzzleFlash.style.opacity = '0'; }, 50);
}

// ─── HIT MARKERS ──────────────────────────────────────────
let hitMarkerTimeout = null;

export function showHitMarker(isKill) {
  if (hitMarkerTimeout) clearTimeout(hitMarkerTimeout);
  // Reset to retrigger animation
  hitMarker.className = '';
  hitMarker.style.opacity = '0';
  // Force reflow so removing then re-adding class retriggers CSS animation
  void hitMarker.offsetWidth;

  hitMarker.className = isKill ? 'kill' : '';
  hitMarker.style.opacity = '1';

  const fadeTime = isKill ? 250 : 150;
  hitMarkerTimeout = setTimeout(() => {
    hitMarker.style.opacity = '0';
    hitMarkerTimeout = null;
  }, fadeTime);
}

export function setReloading(isReloading) {
  ammoLabel.textContent = isReloading ? 'RELOADING...' : 'ROUNDS';
}

export function showDeathScreen() {
  deathStats.innerHTML = `WAVE: ${STATE.wave}<br>KILLS: ${STATE.score}<br>DISTANCE: ${Math.floor(STATE.distance)}m`;
  deathScreen.style.display = 'flex';
}

export function hideDeathScreen() {
  deathScreen.style.display = 'none';
}

export function hideStartScreen() {
  startScreen.style.display = 'none';
}

// ─── WAVE HUD ──────────────────────────────────────────────
const waveNumber = document.getElementById('wave-number');
const waveStatus = document.getElementById('wave-status');
const waveAnnounce = document.getElementById('wave-announce');
const waveAnnounceTitle = waveAnnounce.querySelector('.wave-title');
const waveAnnounceSubtitle = waveAnnounce.querySelector('.wave-subtitle');
let announceTimeout = null;

export function updateWaveHUD() {
  if (STATE.wave === 0) {
    waveNumber.textContent = '';
    waveStatus.textContent = '';
    return;
  }
  waveNumber.textContent = `WAVE ${STATE.wave}`;
  if (STATE.wavePause) {
    const secs = Math.ceil(STATE.waveTimer);
    waveStatus.textContent = secs > 0 ? `NEXT WAVE IN ${secs}` : '';
  } else {
    waveStatus.textContent = `${STATE.waveEnemiesAlive} REMAINING`;
  }
}

export function showWaveAnnounce(wave, enemyCount) {
  waveAnnounceTitle.textContent = `WAVE ${wave}`;
  waveAnnounceSubtitle.textContent = `${enemyCount} HOSTILES INBOUND`;
  waveAnnounce.style.opacity = '1';
  if (announceTimeout) clearTimeout(announceTimeout);
  announceTimeout = setTimeout(() => {
    waveAnnounce.style.opacity = '0';
  }, 2500);
}

// takeDamage lives here — touches both STATE and DOM
export function takeDamage(amount) {
  if (STATE.dead) return;
  STATE.health -= amount;
  updateHUD();
  showDamageFlash();
  addScreenShake(0.004, 0.2);

  if (STATE.health <= 0) {
    STATE.health = 0;
    STATE.dead = true;
    document.exitPointerLock();
    showDeathScreen();
  }
}
