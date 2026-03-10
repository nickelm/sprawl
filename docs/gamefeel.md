# sprawl — Game Feel Specification

This document specifies the "game feel" systems: hit feedback, weapon heft, and sound design. These systems are critical to making the game satisfying to play. Every shot the player fires should feel consequential.

## Hit Feedback

Hit feedback is a layered system. Multiple simultaneous signals confirm a hit. All layers fire together on the same frame.

### Hit Markers

A small white crosshair-style X flashes at screen center on every hit. On kill, the marker changes.

- **Normal hit:** White X, ~20px, opacity 1.0 → 0.0 over 150ms. Thin lines (2px).
- **Headshot / kill:** Red X, ~28px, opacity 1.0 → 0.0 over 250ms. Thicker lines (3px). Briefly scales up to 1.3x then back to 1.0x (pop effect, ~80ms).
- **Implementation:** DOM element centered on crosshair, animated with CSS transitions or JS. Reset and re-trigger on each hit. Use a class swap for normal vs kill variants.

### Hit Sounds

Synthesized with Web Audio API. No sample files.

- **Normal hit:** Short tick. High-frequency noise burst (~3000-5000Hz bandpass), 30ms duration, sharp attack, fast decay. Quiet but distinct — should cut through gunfire.
- **Kill confirm:** Two-tone. Same tick but followed immediately (~50ms gap) by a lower, slightly longer tone (~800Hz sine, 60ms, fast decay). The "double tap" sound is satisfying and unmistakable.
- **Headshot (if implemented):** Higher-pitched tick with a slight metallic ring.

### Enemy Flinch

On hit, the enemy mesh reacts physically:

- **Hit flinch:** Translate the enemy mesh 0.1-0.2 units away from the shot direction. Snap back over 100ms (lerp). Slight rotation offset (~5°) on the torso if the model supports it.
- **Heavy hit / stagger:** Larger displacement (0.3-0.4 units), slower recovery (200ms). Used for shotgun hits or critical hits.
- **Kill:** Enemy collapses. Simplest version: rapid Y-axis rotation (spin ~90°) + fall to ground (Y position lerps to 0 over 300ms) + fade out after 3 seconds. More advanced: simple ragdoll using 2-3 body segments with basic physics.

### Damage Numbers (Optional)

Floating numbers above the enemy showing damage dealt:

- White text, 14-18px, Share Tech Mono font
- Spawns at enemy hit position, drifts upward (1 unit/sec) and fades over 800ms
- Kill damage shown in red
- Slight random horizontal offset so sequential hits don't stack perfectly
- Can be toggled in settings

## Weapon Heft

The weapon must feel like it has mass. Every state (idle, walking, sprinting, shooting, reloading) has distinct weapon behavior.

### Weapon Model

A simple low-poly gun rendered in the player's view (Three.js object attached to the camera, offset to lower-right). Doesn't need to be detailed — a blocky rifle shape reads fine in the BattleBit aesthetic. Key parts:

- Body (rectangular box)
- Barrel (thinner box extending forward)
- Magazine (box below)
- Stock (box extending back)

All dark gray/black materials. The model exists so recoil and bob have something to animate.

### Recoil

On each shot:

- **Camera pitch:** Kick up 1.5-2.5° (randomized per shot). Recovers to original pitch over 200ms (smooth lerp). If the player fires rapidly, recoil accumulates — the camera climbs.
- **Camera yaw:** Random horizontal drift ±0.3-0.8° per shot. This is what makes sustained fire inaccurate.
- **Weapon model kick:** The gun model rotates up ~5° and translates back ~0.05 units. Returns over 120ms. This is separate from and faster than the camera recovery.
- **Recovery:** Camera recoil recovers automatically when not firing (200ms to neutral). The player can also pull down to compensate manually during sustained fire. Weapon model recovery is always automatic.

### Weapon Bob

Procedural animation on the weapon model, not the camera:

- **Idle:** Very subtle figure-8 sway. Horizontal: sin(t * 1.5) * 0.003. Vertical: sin(t * 3) * 0.002. Barely perceptible — just enough to feel alive.
- **Walking:** More pronounced bob synced to footsteps. Horizontal: sin(t * 8) * 0.015. Vertical: abs(sin(t * 8)) * 0.02. The abs() on vertical creates a bouncing motion rather than a swing.
- **Sprinting:** Aggressive diagonal bob. Horizontal: sin(t * 10) * 0.03. Vertical: abs(sin(t * 10)) * 0.04. Rotation: slight roll ±3° synced to horizontal. The weapon should feel like it's swinging.
- **ADS (aim down sights):** Minimal bob. Reduce all amplitudes by 70%. Weapon model moves to center-screen position.

### Aim Down Sights (ADS)

Right-click toggles ADS:

- FOV narrows from 75° to 55° over 150ms (smooth lerp)
- Weapon model moves from lower-right to center-screen
- Movement speed reduced by 40%
- Recoil reduced by 30%
- Weapon bob reduced by 70%
- Slight vignette overlay at screen edges (CSS)

### Muzzle Flash

On each shot, a 3D muzzle flash at the barrel tip:

- Billboard quad (always faces camera) with bright yellow-white color
- Size: randomized 0.3-0.5 units
- Duration: 1 frame (removed next frame). Some shots randomly skip the flash (~20%) for variation.
- Emissive material so it glows against dark environments
- Spawns a brief point light (range 5, intensity 1.0, warm yellow) that decays over 50ms

### Screen Shake

Subtle camera perturbation for impacts:

- **Player shooting:** Tiny shake, 0.5px amplitude, 1 frame. Barely noticeable but contributes to feeling.
- **Taking damage:** Medium shake, 3-5px amplitude, decays over 200ms. Direction biased toward the damage source.
- **Nearby explosion:** Large shake, 8-12px amplitude, decays over 400ms. Low-frequency oscillation (feels heavy, not jittery).
- **Implementation:** Apply random offset to camera position each frame, multiplied by a shake intensity that decays exponentially.

## Sound Design

All sounds synthesized with Web Audio API. No external audio files. Each sound is built from oscillators, noise generators, and filters.

### Sound Architecture

```
AudioContext
├── masterGain (volume control)
├── weaponBus (gain node)
│   ├── playerGunshot
│   ├── reload sounds
│   └── ads click
├── impactBus (gain node)
│   ├── hitMarker tick
│   ├── killConfirm
│   ├── bulletImpact
│   └── explosion
├── enemyBus (gain node, affected by distance)
│   ├── enemyGunshot
│   └── enemyFootsteps
├── playerBus (gain node)
│   ├── footsteps
│   ├── damage taken
│   └── heartbeat (low health)
└── ambienceBus (gain node)
    └── wind / distant sounds
```

### Sound Recipes

Each sound described as a synthesis recipe.

**Player Gunshot:**
- Layer 1 (crack): White noise → bandpass filter (2000Hz, Q=5) → gain envelope (attack 1ms, decay 40ms). Gain 0.4.
- Layer 2 (thump): Sine oscillator 80Hz → gain envelope (attack 1ms, decay 80ms). Start at 80Hz, pitch-sweep down to 40Hz over 80ms. Gain 0.3.
- Layer 3 (tail): White noise → lowpass filter (800Hz) → gain envelope (attack 5ms, decay 200ms). Gain 0.15. This is the "room tone" of the shot.
- Total duration: ~200ms.
- Randomize filter frequencies ±10% per shot for variation.

**Hit Marker Tick:**
- White noise → bandpass filter (4000Hz, Q=10) → gain envelope (attack 0.5ms, decay 25ms). Gain 0.25.
- Very short, very sharp. Must be clearly audible above gunfire.

**Kill Confirm:**
- Same tick as hit marker, plus:
- Sine oscillator at 600Hz → gain envelope (attack 1ms, decay 80ms), delayed 40ms after the tick. Gain 0.2.
- The combination reads as "tick-thump" — satisfying confirmation.

**Reload:**
- Sequence of 3 sounds over ~2000ms:
  1. Magazine out (t=0ms): Noise burst → bandpass 1500Hz, 60ms decay. A "click-slide."
  2. Magazine in (t=1200ms): Similar but lower pitch (1000Hz), slightly longer (80ms). A heavier "chunk."
  3. Charging handle (t=1600ms): Noise burst → bandpass 2000Hz, 40ms decay, followed by lower noise burst 800Hz 50ms. "Click-clack."

**Footsteps:**
- Noise burst → lowpass filter (400Hz) → gain envelope (attack 2ms, decay 60ms). Gain 0.1.
- Triggered at the bottom of each weapon bob cycle (synced to walk animation).
- Pitch varies ±15% per step for natural feel.
- Sprint footsteps: same but louder (gain 0.15), faster rate.

**Explosion:**
- Layer 1 (initial): White noise → lowpass (300Hz, Q=1) → gain envelope (attack 1ms, decay 500ms). Gain 0.6.
- Layer 2 (sub-bass): Sine 40Hz → gain envelope (attack 5ms, decay 600ms), pitch sweep down to 20Hz. Gain 0.4.
- Layer 3 (debris): White noise → bandpass (2000Hz, Q=2) → gain envelope (attack 50ms, decay 400ms). Gain 0.2. Delayed 50ms. Represents debris scatter.
- Total duration: ~700ms. Apply convolver reverb if available for tail.

**Enemy Gunshot (distant):**
- Same recipe as player gunshot but:
  - Lowpass filter applied to entire output, cutoff proportional to distance (closer = higher cutoff)
  - Gain attenuated by 1/distance²
  - Slight delay proportional to distance (speed of sound: ~3ms per unit distance)
  - Stereo panning based on enemy position relative to player facing direction

**Bullet Impact (on environment):**
- Noise burst → bandpass (3000Hz, Q=3) → gain envelope (attack 0.5ms, decay 40ms). Gain 0.15.
- Spatialized: panned and attenuated by distance to impact point.

**Damage Taken:**
- Low sine sweep (200Hz → 100Hz over 200ms) → gain 0.3.
- Layer with a filtered noise thump (lowpass 500Hz, 100ms decay, gain 0.2).
- Triggers simultaneously with the damage flash visual.

**Low Health Heartbeat:**
- When health < 25%:
- Sine oscillator 50Hz, gain envelope pulsing at ~1.2Hz (72 BPM). Gain 0.15.
- Subtle bass throb. Adds tension without being annoying.
- Fades in as health decreases below 25%.

**Wave Start Siren / Horn:**
- Sine oscillator sweep 300Hz → 600Hz over 1.5s → back to 300Hz over 1.5s. Gain 0.2.
- Single sweep signals "wave incoming." Gives the player a moment to ready up.

### Spatial Audio

- Enemy sounds use Web Audio API's PannerNode for 3D spatialization
- Distance attenuation model: inverse distance, rolloff factor 1.0, ref distance 5, max distance 100
- Player sounds (gunshot, footsteps, reload) are non-spatialized (play at center)
- Hit marker and kill confirm sounds are non-spatialized UI sounds

### Mix Levels

Relative volume priorities (loudest to quietest):
1. Player gunshot (it's YOUR gun, it should dominate)
2. Hit marker / kill confirm (feedback must cut through)
3. Damage taken
4. Explosions
5. Enemy gunfire (should be present but not overwhelming)
6. Footsteps
7. Ambience
8. Heartbeat

## Implementation Notes

- All sound synthesis should be centralized in `audio.js` as factory functions (e.g., `playGunshot()`, `playHitMarker()`, `playKillConfirm(position)`).
- Pre-create oscillator/filter node chains where possible. Don't allocate in hot paths.
- Hit marker visuals go in `hud.js`. The weapon model and recoil system go in `weapons.js` or a new `weaponView.js`. Screen shake is a camera modifier in `player.js`.
- Weapon bob phase should be driven by actual movement distance, not time, so the bob stops when you stop.