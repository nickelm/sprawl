import * as THREE from 'three';
import { STATE, enemies } from './state.js';
import { scene, camera } from './renderer.js';
import { updateHUD, setReloading, addKillFeed, showHitMarker } from './hud.js';
import { triggerRecoil, isSwitching } from './weaponView.js';
import { addScreenShake } from './player.js';
import { spawnDamageNumber } from './damageNumbers.js';
import { WEAPON_DEFS } from './weaponDefs.js';

// ─── SHOOT ─────────────────────────────────────────────────
export function shootBullet() {
  if (STATE.ammo <= 0 || STATE.reloading || STATE.dead || isSwitching()) return;
  const now = performance.now();
  if (now - STATE.lastShotTime < STATE.fireRate) return;

  STATE.lastShotTime = now;
  STATE.ammo--;
  triggerRecoil();
  addScreenShake(0.0005, 0.016);
  updateHUD();

  // Raycast hit detection
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  raycaster.far = 100;

  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    if (camera.position.distanceTo(enemy.mesh.position) > 100) continue;

    const toEnemy = enemy.mesh.position.clone().sub(camera.position);
    const ray = raycaster.ray.direction.clone();
    const proj = toEnemy.dot(ray);
    if (proj < 0) continue;

    const closest = camera.position.clone().add(ray.multiplyScalar(proj));
    const enemyCenter = enemy.mesh.position.clone();
    enemyCenter.y += 1.0;

    if (closest.distanceTo(enemyCenter) < 0.8) {
      const dmg = WEAPON_DEFS[STATE.currentWeapon].stats.damage;
      enemy.health -= dmg;
      enemy.lastDamagedTime = performance.now();

      // Hit flinch — push away from shot direction
      const flinchDir = enemy.mesh.position.clone().sub(camera.position);
      flinchDir.y = 0;
      flinchDir.normalize();
      const flinchMag = 0.1 + Math.random() * 0.1;
      enemy.flinchX = flinchDir.x * flinchMag;
      enemy.flinchZ = flinchDir.z * flinchMag;
      enemy.flinchTimer = 0.1;
      enemy.flinchDuration = 0.1;

      const isKill = enemy.health <= 0;
      spawnDamageNumber(enemyCenter, dmg, isKill);

      if (isKill) {
        enemy.alive = false;
        enemy.dying = true;
        enemy.deathTimer = 0;
        enemy.deathSpinStart = enemy.mesh.rotation.y;
        enemy.deathY = enemy.mesh.position.y;
        STATE.score++;
        addKillFeed(enemy.isRanged ? 'RANGED' : 'RUSHER');
        showHitMarker(true);
        updateHUD();
      } else {
        showHitMarker(false);
      }
      break;
    }
  }

  if (STATE.ammo <= 0) reload();
}

// ─── RELOAD ────────────────────────────────────────────────
export function reload() {
  if (STATE.reloading || STATE.ammo === STATE.maxAmmo) return;
  STATE.reloading = true;
  STATE.reloadProgress = 0;
  setReloading(true);
  setTimeout(() => {
    STATE.ammo = STATE.maxAmmo;
    STATE.reloading = false;
    STATE.reloadProgress = 0;
    setReloading(false);
    updateHUD();
  }, STATE.reloadTime);
}
