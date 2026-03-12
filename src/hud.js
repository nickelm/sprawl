import { STATE, REGEN_DELAY, REGEN_RATE } from './state.js';
import { addScreenShake, forceLadderDismount, getPlayerYaw } from './player.js';
import { camera } from './renderer.js';
import { WEAPON_DEFS, ATTACHMENT_DEFS } from './weaponDefs.js';

// ─── DOM REFS ──────────────────────────────────────────────
const healthFill = document.getElementById('health-bar-fill');
const healthValue = document.getElementById('health-value');
const ammoCount = document.getElementById('ammo-count');
const ammoLabel = document.getElementById('ammo-label');
const weaponName = document.getElementById('weapon-name');
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
const interactPrompt = document.getElementById('interact-prompt');
const damageVignette = document.getElementById('damage-vignette');
const deathFade = document.getElementById('death-fade');
const damageIndicators = document.getElementById('damage-indicators');

export function showInteractPrompt(text) {
  if (interactPrompt) {
    interactPrompt.textContent = text;
    interactPrompt.style.display = 'block';
  }
}

export function hideInteractPrompt() {
  if (interactPrompt) interactPrompt.style.display = 'none';
}

export function updateFPS(fps) {
  fpsDisplay.textContent = `${fps} FPS`;
}

export function updateHUD() {
  healthFill.style.width = `${STATE.health}%`;
  healthValue.textContent = Math.max(0, Math.round(STATE.health));
  ammoCount.textContent = STATE.ammo;
  if (weaponName) {
    const def = WEAPON_DEFS[STATE.currentWeapon];
    const mode = STATE.fireMode ? STATE.fireMode.toUpperCase() : '';
    weaponName.textContent = def ? `${def.name} [${mode}]` : '';
  }
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

// ─── DIRECTIONAL DAMAGE INDICATORS ─────────────────────────
const INDICATOR_COUNT = 8;
const _indicators = [];

function initIndicators() {
  if (!damageIndicators) return;
  for (let i = 0; i < INDICATOR_COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'damage-indicator';
    el.style.opacity = '0';
    damageIndicators.appendChild(el);
    _indicators.push({ el, timer: 0 });
  }
}
initIndicators();

function showDirectionalIndicator(sourcePosition) {
  if (!damageIndicators || !sourcePosition) return;

  // Compute angle from player forward to damage source in XZ plane
  const dx = sourcePosition.x - camera.position.x;
  const dz = sourcePosition.z - camera.position.z;
  const worldAngle = Math.atan2(dx, dz); // angle of source in world space
  const yaw = getPlayerYaw();
  // Relative angle: 0 = directly ahead, PI = behind
  let relAngle = worldAngle - yaw;
  // Normalize to [-PI, PI]
  while (relAngle > Math.PI) relAngle -= Math.PI * 2;
  while (relAngle < -Math.PI) relAngle += Math.PI * 2;

  // Find a free indicator slot (oldest if all in use)
  let best = _indicators[0];
  for (const ind of _indicators) {
    if (ind.timer <= 0) { best = ind; break; }
    if (ind.timer < best.timer) best = ind;
  }

  // Position the indicator arc
  // relAngle: 0 = ahead (top), PI/-PI = behind (bottom)
  // Map to CSS: rotate around screen center
  const angleDeg = (relAngle * 180 / Math.PI);
  best.el.style.transform = `rotate(${angleDeg}deg)`;
  best.el.style.opacity = '0.7';
  best.timer = 0.5; // fade duration
}

function updateIndicators(dt) {
  for (const ind of _indicators) {
    if (ind.timer <= 0) continue;
    ind.timer -= dt;
    if (ind.timer <= 0) {
      ind.el.style.opacity = '0';
    } else {
      ind.el.style.opacity = String(Math.min(0.7, ind.timer / 0.5 * 0.7));
    }
  }
}

// ─── TAKE DAMAGE (unified) ─────────────────────────────────
export function takeDamage(amount, sourcePosition = null) {
  if (STATE.dead || STATE.dying) return;

  STATE.health -= amount;
  STATE.timeSinceLastDamage = 0;
  STATE.isRegenerating = false;

  updateHUD();
  showDamageFlash();

  // Scale shake by damage
  const shakeScale = Math.min(1, amount / 30);
  addScreenShake(0.003 + 0.008 * shakeScale, 0.2 + 0.2 * shakeScale);

  if (STATE.onLadder) forceLadderDismount();

  // Directional indicator
  if (sourcePosition) {
    showDirectionalIndicator(sourcePosition);
  }

  if (STATE.health <= 0) {
    STATE.health = 0;
    STATE.dying = true;
    STATE.deathTimer = 0;
    // Don't set STATE.dead yet — death animation plays first
    // Don't exit pointer lock yet — camera needs to animate
  }
}

// ─── HEALTH EFFECTS (regen + vignette + desaturation) ───────

export function updateHealthEffects(dt) {
  if (STATE.dead) return;

  // Update directional indicators
  updateIndicators(dt);

  // Death animation
  if (STATE.dying) {
    STATE.deathTimer += dt;

    // Fade to black after 0.5s (camera drop handled in player.js)
    if (deathFade) {
      if (STATE.deathTimer > 0.5) {
        const fadeProgress = Math.min(1, (STATE.deathTimer - 0.5) / 1.5);
        deathFade.style.opacity = String(fadeProgress);
      }
    }

    // After 2.0s total, finalize death
    if (STATE.deathTimer >= 2.0) {
      STATE.dead = true;
      document.exitPointerLock();
      showDeathScreen();
    }
    return;
  }

  // Regen tick
  STATE.timeSinceLastDamage += dt;
  if (STATE.timeSinceLastDamage >= REGEN_DELAY && STATE.health < STATE.maxHealth) {
    STATE.isRegenerating = true;
    STATE.health = Math.min(STATE.maxHealth, STATE.health + REGEN_RATE * dt);
    updateHUD();
  } else {
    STATE.isRegenerating = false;
  }

  // Progressive screen effects based on HP
  const hp = STATE.health;
  let vignetteOpacity = 0;
  let saturation = 1.0;

  if (hp <= 70 && hp > 40) {
    vignetteOpacity = (70 - hp) / 30 * 0.3;          // 0 → 0.3
  } else if (hp <= 40 && hp > 20) {
    vignetteOpacity = 0.3 + (40 - hp) / 20 * 0.3;   // 0.3 → 0.6
    saturation = 1.0 - (40 - hp) / 20 * 0.4;        // 1.0 → 0.6
  } else if (hp <= 20) {
    vignetteOpacity = 0.6 + (20 - hp) / 20 * 0.4;   // 0.6 → 1.0
    saturation = 0.6 - (20 - hp) / 20 * 0.4;        // 0.6 → 0.2
  }

  if (damageVignette) {
    damageVignette.style.opacity = String(vignetteOpacity);
  }

  // Apply desaturation via CSS filter on canvas
  if (saturation < 1.0) {
    gameCanvas.style.filter = `saturate(${saturation.toFixed(2)})`;
  } else {
    gameCanvas.style.filter = '';
  }
}

// Reset all health effects (called on game start)
export function resetHealthEffects() {
  if (damageVignette) damageVignette.style.opacity = '0';
  if (deathFade) deathFade.style.opacity = '0';
  gameCanvas.style.filter = '';
  for (const ind of _indicators) {
    ind.timer = 0;
    ind.el.style.opacity = '0';
  }
}

// ─── ATTACHMENT CHOICE UI (Step 14d) ──────────────────────
let _attachChoiceOverlay = null;

export function showAttachmentChoice(options) {
  if (_attachChoiceOverlay) _attachChoiceOverlay.remove();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    display: flex; align-items: center; justify-content: center; gap: 40px;
    background: rgba(0,0,0,0.5); z-index: 20; pointer-events: auto;
    font-family: 'Share Tech Mono', monospace; color: #fff;
  `;

  const title = document.createElement('div');
  title.style.cssText = `
    position: absolute; top: 15%; left: 50%; transform: translateX(-50%);
    font-family: 'Rajdhani', sans-serif; font-size: 28px; color: #f39c12;
    text-transform: uppercase; letter-spacing: 4px;
  `;
  title.textContent = 'CHOOSE ATTACHMENT';
  overlay.appendChild(title);

  for (const opt of options) {
    const card = document.createElement('div');
    card.style.cssText = `
      width: 200px; padding: 20px; border: 2px solid #f39c12;
      background: rgba(46,52,64,0.9); cursor: pointer; text-align: center;
      transition: border-color 0.2s, background 0.2s;
    `;
    card.onmouseenter = () => { card.style.borderColor = '#fff'; card.style.background = 'rgba(243,156,18,0.3)'; };
    card.onmouseleave = () => { card.style.borderColor = '#f39c12'; card.style.background = 'rgba(46,52,64,0.9)'; };

    const name = document.createElement('div');
    name.style.cssText = 'font-size: 18px; font-family: Rajdhani, sans-serif; color: #f39c12; margin-bottom: 8px;';
    name.textContent = opt.name || opt.key;
    card.appendChild(name);

    const slot = document.createElement('div');
    slot.style.cssText = 'font-size: 12px; color: #aaa; margin-bottom: 12px; text-transform: uppercase;';
    slot.textContent = opt.slot;
    card.appendChild(slot);

    // Show modifiers
    const attDef = ATTACHMENT_DEFS[opt.key];
    if (attDef) {
      for (const [stat, mod] of Object.entries(attDef.modifiers)) {
        const line = document.createElement('div');
        line.style.cssText = `font-size: 11px; color: ${mod > 0 ? '#2ecc71' : '#e74c3c'};`;
        const sign = mod > 0 ? '+' : '';
        line.textContent = `${sign}${Math.round(mod * 100)}% ${stat}`;
        card.appendChild(line);
      }
      if (attDef.recoilMods) {
        for (const [axis, mod] of Object.entries(attDef.recoilMods)) {
          const line = document.createElement('div');
          line.style.cssText = `font-size: 11px; color: ${mod < 0 ? '#2ecc71' : '#e74c3c'};`;
          const sign = mod > 0 ? '+' : '';
          line.textContent = `${sign}${Math.round(mod * 100)}% ${axis} recoil`;
          card.appendChild(line);
        }
      }
    }

    card.onclick = () => {
      // Apply attachment to current weapon loadout
      const loadoutSlot = STATE.loadout.primary.weapon === STATE.currentWeapon ? 'primary' : 'secondary';
      STATE.loadout[loadoutSlot].attachments[opt.slot] = opt.key;
      overlay.remove();
      _attachChoiceOverlay = null;
      document.getElementById('game-canvas').requestPointerLock();
      // Trigger rebuild (imports would be circular, so we dispatch an event)
      window.dispatchEvent(new CustomEvent('attachment-applied'));
    };

    overlay.appendChild(card);
  }

  document.body.appendChild(overlay);
  _attachChoiceOverlay = overlay;
}
