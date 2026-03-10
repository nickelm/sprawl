import { camera } from './renderer.js';
import * as THREE from 'three';

const MAX_NUMBERS = 20;
const DURATION = 0.8;       // seconds
const RISE_SPEED = 1.0;     // world units per second

const activeNumbers = [];
const hudEl = document.getElementById('hud');

const _vec = new THREE.Vector3();

export function spawnDamageNumber(worldPos, damage, isKill) {
  // Cap active numbers
  if (activeNumbers.length >= MAX_NUMBERS) {
    const oldest = activeNumbers.shift();
    oldest.el.remove();
  }

  const el = document.createElement('div');
  el.textContent = damage;
  el.style.cssText = `
    position: absolute;
    pointer-events: none;
    z-index: 12;
    font-family: 'Share Tech Mono', monospace;
    font-size: 16px;
    font-weight: bold;
    color: ${isKill ? '#e74c3c' : '#ffffff'};
    text-shadow: 0 0 4px rgba(0,0,0,0.8);
    white-space: nowrap;
  `;
  hudEl.appendChild(el);

  activeNumbers.push({
    el,
    x: worldPos.x + (Math.random() - 0.5) * 0.5,
    y: worldPos.y,
    z: worldPos.z + (Math.random() - 0.5) * 0.5,
    elapsed: 0,
  });
}

export function updateDamageNumbers(dt) {
  for (let i = activeNumbers.length - 1; i >= 0; i--) {
    const num = activeNumbers[i];
    num.elapsed += dt;

    if (num.elapsed > DURATION) {
      num.el.remove();
      activeNumbers.splice(i, 1);
      continue;
    }

    // Rise
    num.y += RISE_SPEED * dt;

    // Project to screen
    _vec.set(num.x, num.y, num.z);
    _vec.project(camera);

    // Behind camera check
    if (_vec.z > 1) {
      num.el.style.display = 'none';
      continue;
    }

    const x = (_vec.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_vec.y * 0.5 + 0.5) * window.innerHeight;

    num.el.style.display = '';
    num.el.style.left = x + 'px';
    num.el.style.top = y + 'px';
    num.el.style.opacity = 1 - (num.elapsed / DURATION);
  }
}

export function clearDamageNumbers() {
  for (const num of activeNumbers) num.el.remove();
  activeNumbers.length = 0;
}
