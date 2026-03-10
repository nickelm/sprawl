import * as THREE from 'three';
import { PLAYER_HEIGHT } from './state.js';

// ─── RENDERER SETUP ────────────────────────────────────────
const canvas = document.getElementById('game-canvas');

export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 400);
scene.add(camera); // camera must be in scene for its children (weapon model) to render

// ─── LIGHTS ────────────────────────────────────────────────
export const ambientLight = new THREE.AmbientLight(0x4466aa, 0.7);
scene.add(ambientLight);

export const dirLight = new THREE.DirectionalLight(0xfff5e0, 1.3);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width  = 1024;
dirLight.shadow.mapSize.height = 1024;
dirLight.shadow.camera.near   = 1;
dirLight.shadow.camera.far    = 250;
dirLight.shadow.camera.left   = -90;
dirLight.shadow.camera.right  =  90;
dirLight.shadow.camera.top    =  90;
dirLight.shadow.camera.bottom = -90;
dirLight.shadow.bias = -0.0005;
scene.add(dirLight);
scene.add(dirLight.target); // must be in scene for shadow to track

export const playerLight = new THREE.PointLight(0xff9955, 0.6, 22);
scene.add(playerLight);

// ─── MATERIALS ─────────────────────────────────────────────
export const buildingMats = [
  new THREE.MeshPhongMaterial({ color: 0x3a3a4a, flatShading: true }),
  new THREE.MeshPhongMaterial({ color: 0x4a485a, flatShading: true }),
  new THREE.MeshPhongMaterial({ color: 0x2e3440, flatShading: true }),
  new THREE.MeshPhongMaterial({ color: 0x434c5e, flatShading: true }),
  new THREE.MeshPhongMaterial({ color: 0x5c4a3a, flatShading: true }), // warm concrete
  new THREE.MeshPhongMaterial({ color: 0x4a3830, flatShading: true }), // brick
  new THREE.MeshPhongMaterial({ color: 0x4a5545, flatShading: true }), // mossy concrete
];

export const groundMat      = new THREE.MeshLambertMaterial({ color: 0x2a2a35 });
export const roadMat        = new THREE.MeshLambertMaterial({ color: 0x1e1e28 });
export const enemyMeleeMat  = new THREE.MeshPhongMaterial({ color: 0xe74c3c, flatShading: true });
export const enemyRangedMat = new THREE.MeshPhongMaterial({ color: 0xf39c12, flatShading: true });
export const healthPickupMat = new THREE.MeshLambertMaterial({ color: 0x2ecc71, emissive: 0x2ecc71, emissiveIntensity: 0.3 });
export const ammoPickupMat   = new THREE.MeshLambertMaterial({ color: 0xf39c12, emissive: 0xf39c12, emissiveIntensity: 0.3 });

// ─── DAY / NIGHT PRESETS ───────────────────────────────────
// Each keyframe: t (0-1), sky RGB, fog RGB, fogDensity,
//   ambient {rgb, intensity}, sun {rgb, intensity}, sun offset {x,y,z}
const KF = [
  { t: 0.00, sky:[0.02,0.02,0.07], fog:[0.02,0.02,0.06], fd:0.022,
    aR:[0.04,0.05,0.12], aI:0.25, sR:[0.10,0.15,0.35], sI:0.05, sx:50,  sy:80,  sz:30 },
  { t: 0.20, sky:[0.06,0.04,0.12], fog:[0.08,0.05,0.10], fd:0.015,
    aR:[0.12,0.08,0.12], aI:0.40, sR:[0.80,0.30,0.08], sI:0.55, sx:80,  sy:12,  sz:30 }, // pre-dawn
  { t: 0.30, sky:[0.55,0.30,0.15], fog:[0.50,0.28,0.18], fd:0.010,
    aR:[0.35,0.22,0.15], aI:0.55, sR:[1.00,0.60,0.20], sI:0.90, sx:90,  sy:25,  sz:25 }, // dawn
  { t: 0.50, sky:[0.23,0.45,0.78], fog:[0.32,0.55,0.80], fd:0.007,
    aR:[0.27,0.40,0.65], aI:0.70, sR:[1.00,0.97,0.88], sI:1.30, sx:15,  sy:100, sz:20 }, // noon
  { t: 0.70, sky:[0.55,0.28,0.12], fog:[0.50,0.26,0.14], fd:0.010,
    aR:[0.35,0.20,0.12], aI:0.55, sR:[1.00,0.55,0.15], sI:0.85, sx:-90, sy:25,  sz:25 }, // dusk
  { t: 0.80, sky:[0.06,0.03,0.10], fog:[0.07,0.04,0.10], fd:0.016,
    aR:[0.10,0.06,0.12], aI:0.38, sR:[0.70,0.25,0.05], sI:0.45, sx:-80, sy:12,  sz:30 }, // post-dusk
  { t: 1.00, sky:[0.02,0.02,0.07], fog:[0.02,0.02,0.06], fd:0.022,
    aR:[0.04,0.05,0.12], aI:0.25, sR:[0.10,0.15,0.35], sI:0.05, sx:50,  sy:80,  sz:30 }, // midnight
];

// Sun direction offset from camera (updated by updateLighting, used by updateShadowCamera)
export const sunOffset = new THREE.Vector3(15, 100, 20);

export let dayTime = 0.5;

export function setDayTime(t) {
  dayTime = ((t % 1) + 1) % 1;
  updateLighting();
}

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpArr(a, b, t) { return [lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t)]; }

export function updateLighting() {
  const t = dayTime;
  let lo = KF[KF.length - 2], hi = KF[KF.length - 1];
  for (let i = 0; i < KF.length - 1; i++) {
    if (t >= KF[i].t && t <= KF[i + 1].t) { lo = KF[i]; hi = KF[i + 1]; break; }
  }
  const f = (hi.t - lo.t) < 1e-4 ? 0 : (t - lo.t) / (hi.t - lo.t);

  const sky = lerpArr(lo.sky, hi.sky, f);
  const fog = lerpArr(lo.fog, hi.fog, f);
  const aR  = lerpArr(lo.aR,  hi.aR,  f);
  const sR  = lerpArr(lo.sR,  hi.sR,  f);

  scene.background = new THREE.Color(sky[0], sky[1], sky[2]);
  scene.fog.color.setRGB(fog[0], fog[1], fog[2]);
  scene.fog.density = lerp(lo.fd, hi.fd, f);

  ambientLight.color.setRGB(aR[0], aR[1], aR[2]);
  ambientLight.intensity = lerp(lo.aI, hi.aI, f);

  dirLight.color.setRGB(sR[0], sR[1], sR[2]);
  dirLight.intensity = lerp(lo.sI, hi.sI, f);

  sunOffset.set(lerp(lo.sx, hi.sx, f), lerp(lo.sy, hi.sy, f), lerp(lo.sz, hi.sz, f));
}

// Call each frame to keep shadow volume centered on player
export function updateShadowCamera() {
  dirLight.position.set(
    camera.position.x + sunOffset.x,
    camera.position.y + sunOffset.y,
    camera.position.z + sunOffset.z,
  );
  dirLight.target.position.copy(camera.position);
  dirLight.target.updateMatrixWorld();
}

// ─── INIT / RESIZE ─────────────────────────────────────────
export function initRenderer() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene.fog = new THREE.FogExp2(0x3a70c0, 0.007);
  camera.position.set(0, PLAYER_HEIGHT, 0);
  updateLighting();
}

export function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
