// ─── Audio System ────────────────────────────────────────────────────────────
// Web Audio API oscillator synthesis for weapon sounds, hits, and pickups.
// No audio files — all sounds generated from oscillators + filtered noise.

let ctx;
let masterGain;
let noiseBuffer;

// ─── Shot Profiles per Archetype ─────────────────────────────────────────────
const SHOT_PROFILES = {
  pistol:       { crackFreq: 1800, crackDur: 0.010, crackWave: 'sawtooth', boomFreq: 150, boomDur: 0.10, tailDur: 0.10, tailFilter: 3000 },
  revolver:     { crackFreq: 1200, crackDur: 0.015, crackWave: 'square',   boomFreq: 100, boomDur: 0.15, tailDur: 0.20, tailFilter: 2000 },
  smg:          { crackFreq: 2000, crackDur: 0.008, crackWave: 'sawtooth', boomFreq: 180, boomDur: 0.08, tailDur: 0.08, tailFilter: 3500 },
  carbine:      { crackFreq: 1400, crackDur: 0.010, crackWave: 'sawtooth', boomFreq: 120, boomDur: 0.12, tailDur: 0.15, tailFilter: 2800 },
  ar:           { crackFreq: 1200, crackDur: 0.012, crackWave: 'sawtooth', boomFreq: 100, boomDur: 0.15, tailDur: 0.18, tailFilter: 2500 },
  battle_rifle: { crackFreq: 1000, crackDur: 0.015, crackWave: 'square',   boomFreq: 80,  boomDur: 0.18, tailDur: 0.20, tailFilter: 2000 },
  lmg:          { crackFreq: 1100, crackDur: 0.012, crackWave: 'sawtooth', boomFreq: 90,  boomDur: 0.15, tailDur: 0.20, tailFilter: 2200 },
  dmr:          { crackFreq: 1000, crackDur: 0.015, crackWave: 'square',   boomFreq: 90,  boomDur: 0.18, tailDur: 0.25, tailFilter: 2000 },
  sniper:       { crackFreq: 800,  crackDur: 0.020, crackWave: 'square',   boomFreq: 60,  boomDur: 0.20, tailDur: 0.40, tailFilter: 1500 },
  shotgun:      { crackFreq: 600,  crackDur: 0.020, crackWave: 'square',   boomFreq: 50,  boomDur: 0.22, tailDur: 0.30, tailFilter: 1200 },
};

// ─── Initialization ──────────────────────────────────────────────────────────

export function initAudio() {
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.3;
    masterGain.connect(ctx.destination);

    // Pre-generate 1 second of white noise
    const sampleRate = ctx.sampleRate;
    noiseBuffer = ctx.createBuffer(1, sampleRate, sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < sampleRate; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  } catch (e) {
    // Audio not supported — all functions will silently no-op
  }
}

function ensureContext() {
  if (!ctx) return false;
  if (ctx.state === 'suspended') ctx.resume();
  return true;
}

// ─── Shot Sound ──────────────────────────────────────────────────────────────

export function playShot(archetype, suppressed) {
  if (!ensureContext()) return;

  const p = SHOT_PROFILES[archetype] || SHOT_PROFILES.carbine;
  const t0 = ctx.currentTime;

  // Layer 1: Crack — short high-frequency burst
  if (!suppressed) {
    const crackOsc = ctx.createOscillator();
    const crackGain = ctx.createGain();
    crackOsc.type = p.crackWave;
    crackOsc.frequency.value = p.crackFreq;
    crackGain.gain.setValueAtTime(0.8, t0);
    crackGain.gain.linearRampToValueAtTime(0, t0 + p.crackDur);
    crackOsc.connect(crackGain);
    crackGain.connect(masterGain);
    crackOsc.start(t0);
    crackOsc.stop(t0 + p.crackDur + 0.01);
  }

  // Layer 2: Boom — low-frequency sine body
  const boomOsc = ctx.createOscillator();
  const boomGain = ctx.createGain();
  boomOsc.type = 'sine';
  boomOsc.frequency.value = suppressed ? p.boomFreq * 0.5 : p.boomFreq;
  const boomVol = suppressed ? 0.25 : 0.7;
  boomGain.gain.setValueAtTime(boomVol, t0);
  boomGain.gain.exponentialRampToValueAtTime(0.001, t0 + p.boomDur);
  boomOsc.connect(boomGain);
  boomGain.connect(masterGain);
  boomOsc.start(t0);
  boomOsc.stop(t0 + p.boomDur + 0.01);

  // Layer 3: Tail — filtered white noise (room reverb / echo)
  const tailSrc = ctx.createBufferSource();
  tailSrc.buffer = noiseBuffer;
  const tailFilter = ctx.createBiquadFilter();
  tailFilter.type = 'lowpass';
  tailFilter.frequency.value = p.tailFilter;
  const tailGain = ctx.createGain();
  const tailDur = suppressed ? p.tailDur * 1.3 : p.tailDur;
  const tailVol = suppressed ? 0.15 : 0.4;
  tailGain.gain.setValueAtTime(tailVol, t0);
  tailGain.gain.exponentialRampToValueAtTime(0.001, t0 + tailDur);
  tailSrc.connect(tailFilter);
  tailFilter.connect(tailGain);
  tailGain.connect(masterGain);
  tailSrc.start(t0);
  tailSrc.stop(t0 + tailDur + 0.01);
}

// ─── Reload Sound ────────────────────────────────────────────────────────────

export function playReload() {
  if (!ensureContext()) return;
  const t0 = ctx.currentTime;

  // Click — mag release (short noise burst)
  playMechanicalClick(t0, 2500, 0.03, 0.5);
  // Clack — mag insert
  playMechanicalClick(t0 + 0.3, 1800, 0.04, 0.6);
}

function playMechanicalClick(t, filterFreq, dur, vol) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterFreq;
  filter.Q.value = 2;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  src.start(t);
  src.stop(t + dur + 0.01);
}

// ─── Hit Sound ───────────────────────────────────────────────────────────────

export function playHit(isKill) {
  if (!ensureContext()) return;
  const t0 = ctx.currentTime;

  if (isKill) {
    // Kill confirm: descending two-tone
    playTone(t0, 1200, 0.03, 0.4, 'sine');
    playTone(t0 + 0.03, 800, 0.04, 0.35, 'sine');
  } else {
    // Hit marker: short high ping
    playTone(t0, 1200, 0.03, 0.3, 'sine');
  }
}

function playTone(t, freq, dur, vol, wave) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = wave;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(t);
  osc.stop(t + dur + 0.01);
}

// ─── Pickup Sound ────────────────────────────────────────────────────────────

export function playPickup() {
  if (!ensureContext()) return;
  const t0 = ctx.currentTime;
  // Ascending two-tone
  playTone(t0, 600, 0.04, 0.3, 'sine');
  playTone(t0 + 0.04, 900, 0.06, 0.25, 'sine');
}
