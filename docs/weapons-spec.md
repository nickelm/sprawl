# Weapon & Attachment System — sprawl

## Context

This spec defines the weapon archetypes, attachment system, optics, and firing model for `sprawl`. All weapons feed into the existing ballistics pipeline (`destruction-spec.md` §1). The weapon system is the player's primary interface with combat — it must feel snappy and readable in the BattleBit arcade style.

Implement primarily in `src/weapons.js` (weapon definitions, firing model, recoil), `src/optics.js` (new file — optic rendering modes), `src/hud.js` (crosshair, ammo, optic overlays), `src/player.js` (ADS, weapon switching, movement speed), `src/audio.js` (per-weapon sound profiles), `src/renderer.js` (thermal/NV post-processing).

Read `CLAUDE.md` and `destruction-spec.md` before starting. Obey all hard rules (no textures, `MeshLambertMaterial` with `flatShading: true`, etc.).

---

## 1. Design Principles

- **Arcade handling.** ADS is fast (100–250ms). Recoil is learnable, not punishing. Movement stays high. The challenge comes from enemy tactics, not from wrestling your weapon.
- **Each archetype feels distinct.** Not just stat variations — different recoil shapes, different audio signatures, different movement speeds. A player should know which weapon they're holding without looking at the HUD.
- **Attachments are tradeoffs.** Every attachment has a cost. Extended mag = slower reload. Heavy barrel = less recoil + slower ADS. No free upgrades.
- **Optics change how you see.** Not just zoom levels. Each optic is a different rendering mode with a unique reticle. Thermal and NV recolor the scene.
- **Weapons are geometry.** No textures. Each weapon is a distinct silhouette built from boxes, cylinders, and wedges. Readable at a glance.

---

## 2. Weapon Archetypes

Ten archetypes. Each has a base weapon with default stats. Attachments modify from this baseline.

### 2.1 Stat Definitions

| Stat | Unit | Description |
|------|------|-------------|
| `damage` | HP | Per-hit damage (feeds into ballistics pipeline) |
| `penetration` | budget | Penetration budget per `destruction-spec.md` §1.3 |
| `rateOfFire` | rounds/sec | Cyclic rate. Semi-auto weapons: max click rate capped at this |
| `magSize` | rounds | Magazine capacity |
| `reloadTime` | seconds | Full reload (empty mag). Tactical reload (round in chamber) = 70% of this |
| `adsTime` | seconds | Time to reach full ADS zoom from hipfire |
| `moveSpeed` | multiplier | Player movement speed while this weapon is active (1.0 = base 6 m/s) |
| `adsSpeed` | multiplier | Movement speed while ADS'd (fraction of moveSpeed) |
| `spread.hip` | degrees | Hipfire accuracy cone half-angle |
| `spread.ads` | degrees | ADS accuracy cone half-angle |
| `recoilPattern` | vector[] | Per-shot recoil displacement sequence (see §3) |
| `range` | meters | Max effective range (raycast distance) |
| `headshotMult` | multiplier | Damage multiplier for headshots |
| `fireMode` | enum | `auto`, `semi`, `burst3`, `pump` |
| `weight` | kg | Affects swap speed. Lighter = faster swap. |

### 2.2 Base Weapon Table

| # | Archetype | Weapon Name | Damage | Pen | RoF | Mag | Reload | ADS | Move | Hip° | ADS° | Range | HS | Mode | Weight |
|---|-----------|------------|--------|-----|-----|-----|--------|-----|------|------|------|-------|----|------|--------|
| 1 | Pistol | M9A1 | 22 | 0.4 | 6 | 15 | 1.4 | 0.10 | 1.00 | 4.0 | 1.5 | 50 | 1.8 | semi | 1.0 |
| 2 | Revolver | .357 Magnum | 55 | 0.7 | 1.5 | 6 | 2.8 | 0.15 | 0.98 | 3.0 | 0.8 | 60 | 2.0 | semi | 1.2 |
| 3 | SMG | MP7 | 20 | 0.3 | 15 | 40 | 1.8 | 0.10 | 0.97 | 5.0 | 2.0 | 40 | 1.5 | auto | 2.0 |
| 4 | Carbine | M4 | 28 | 0.6 | 12 | 30 | 2.0 | 0.15 | 0.93 | 3.5 | 1.2 | 80 | 1.8 | auto | 3.0 |
| 5 | AR | AK-74 | 32 | 0.8 | 10 | 30 | 2.3 | 0.18 | 0.90 | 3.5 | 1.0 | 90 | 1.8 | auto | 3.5 |
| 6 | Battle Rifle | SCAR-H | 40 | 0.9 | 8 | 20 | 2.5 | 0.20 | 0.87 | 3.0 | 0.8 | 100 | 2.0 | semi | 4.0 |
| 7 | LMG | M249 | 30 | 0.8 | 13 | 100 | 4.5 | 0.25 | 0.80 | 5.0 | 2.5 | 90 | 1.5 | auto | 7.0 |
| 8 | DMR | MK14 | 45 | 1.0 | 4 | 20 | 2.2 | 0.20 | 0.88 | 2.5 | 0.5 | 120 | 2.5 | semi | 4.2 |
| 9 | Sniper | M24 | 90 | 1.5 | 1 | 5 | 3.0 | 0.25 | 0.82 | 3.0 | 0.2 | 200 | 3.0 | semi | 5.5 |
| 10 | Shotgun | M870 | 12×8 | 0.2 | 1.2 | 6 | 0.5/shell | 0.18 | 0.92 | — | — | 20 | 1.5 | pump | 3.5 |

**Shotgun notes:** Fires 8 pellets per shot, each dealing 12 damage. Total potential damage = 96 at point blank. Pellets spread in a random cone (8° hip, 5° ADS). Each pellet is a separate raycast through the ballistics pipeline. Penetration budget per pellet is low (0.2) — shotguns don't punch through walls. Reload is per-shell (0.5s each), interruptible — fire at any point during reload to use loaded shells.

### 2.3 Weapon Geometry

Each weapon is built from primitive Three.js geometry. No textures. Color from materials only. All weapons use `MeshLambertMaterial({ flatShading: true })`.

The weapon viewmodel (first-person) is a simplified version positioned in the lower-right viewport. The world model (dropped weapons, enemy weapons) is smaller and lower detail.

**Geometry vocabulary:**
- `BoxGeometry` — receivers, magazines, stocks, rails
- `CylinderGeometry` — barrels, suppressors, scopes, grips
- `WedgeGeometry` (custom) — angled stocks, trigger guards, iron sight posts

**Silhouette priorities** (what makes each weapon instantly recognizable):

| Archetype | Key Visual Feature |
|-----------|-------------------|
| Pistol | Short, compact. No stock. Visible slide on top. |
| Revolver | Visible cylinder (6 small cylinders in ring). Long barrel. |
| SMG | Compact body, long magazine extending down, stubby barrel. |
| Carbine | Medium barrel, magazine well, collapsible stock (thin box). |
| AR | Longer barrel than carbine, curved magazine, full stock. |
| Battle Rifle | Thick receiver, straight magazine, heavy stock. Bulkier than AR. |
| LMG | Long barrel, bipod legs (two thin cylinders), box magazine underneath. |
| DMR | Long barrel, slim profile, straight magazine, cheek rest on stock. |
| Sniper | Longest barrel, bolt handle (small cylinder on right side), heavy stock. |
| Shotgun | Thick barrel, pump slide (cylinder under barrel), no magazine visible. |

**Color scheme:**
- Receiver/body: dark gray (#3a3a3a)
- Barrel/metal parts: darker (#2a2a2a)
- Stock/grip: slightly warm dark (#3d3530) — subtle, not obviously brown
- Magazine: match receiver
- Accents (safety, bolt handle): medium gray (#5a5a5a)

### 2.4 Weapon Swap

- Swap time = `0.3 + weight * 0.02` seconds. Pistol swap: 0.32s. LMG swap: 0.44s.
- Player carries two weapons (primary + secondary) and can swap with a key press.
- Swap animation: current weapon lowers (lerp down over 60% of swap time), new weapon raises (lerp up over 40%).
- Cannot fire during swap.

---

## 3. Recoil System

### 3.1 Recoil Pattern

Each weapon has a **recoil pattern**: a sequence of 2D vectors (pitch, yaw) applied to the camera per shot. The pattern is deterministic — same weapon, same sequence. Skilled players learn to counteract.

Pattern length = magazine size. After the pattern repeats (sustained fire past one mag), it loops.

```javascript
// Example: AK-74 recoil pattern (first 10 shots)
// Positive pitch = camera kicks up. Positive yaw = camera kicks right.
recoilPattern: [
  { pitch: 0.6, yaw: 0.0 },   // shot 1: straight up
  { pitch: 0.7, yaw: 0.1 },   // shot 2: up-right
  { pitch: 0.5, yaw: 0.2 },   // shot 3: up-right
  { pitch: 0.4, yaw: -0.1 },  // shot 4: up, slight left
  { pitch: 0.5, yaw: -0.2 },  // shot 5: up-left
  { pitch: 0.3, yaw: -0.3 },  // shot 6: drifts left
  { pitch: 0.3, yaw: 0.1 },   // shot 7: recovers right
  { pitch: 0.4, yaw: 0.2 },   // shot 8: up-right
  { pitch: 0.3, yaw: -0.1 },  // shot 9: slight left
  { pitch: 0.3, yaw: 0.0 },   // shot 10: straight up
  // ... continues for full magazine
]
```

**Pattern shapes per archetype:**

| Archetype | Pattern Shape | Character |
|-----------|--------------|-----------|
| Pistol | Straight up, sharp snap | Quick recovery between shots |
| Revolver | Heavy upward kick | Slow enough to re-aim between shots |
| SMG | Tight vertical with slight wander | Easy to control, low per-shot kick |
| Carbine | Moderate vertical, mild rightward drift | Predictable, good for beginners |
| AR | Vertical then S-curve (right-left-right) | Classic learnable pattern |
| Battle Rifle | Heavy vertical, alternating left-right | Punchy, requires compensation |
| LMG | Wide vertical with random horizontal jitter | Hard to control precisely, area suppression |
| DMR | Sharp upward snap, fast recovery | Designed for paced semi-auto fire |
| Sniper | Massive upward kick | Forces re-acquisition between shots |
| Shotgun | Heavy upward + random | Pump delay makes recoil less relevant |

### 3.2 Recoil Application

Per shot:
1. Look up current pattern index (shot count modulo pattern length).
2. Apply the pattern vector to camera pitch/yaw.
3. Add random perturbation: ±15% on each axis (prevents perfect memorization).
4. **ADS reduces recoil by 30%.** Multiply pattern vector by 0.7 when ADS'd.
5. **Crouching reduces recoil by 15%.** Multiplies with ADS reduction.
6. Camera displacement is applied instantly on the fire frame.

### 3.3 Recoil Recovery

After each shot, the camera drifts back toward the pre-shot orientation:

- Recovery rate: weapon-specific, 3–8 degrees/second.
- Recovery starts after a delay equal to `1 / rateOfFire` (next shot timing).
- Sustained fire accumulates recoil faster than recovery removes it — the pattern "stacks."
- Releasing the trigger lets recovery catch up over 0.3–0.5 seconds.

### 3.4 Visual Recoil (Weapon Model)

Separate from camera recoil. The weapon model kicks independently:
- Upward rotation proportional to pattern pitch.
- Slight backward translation (0.5–2cm depending on weapon weight).
- Recovery via spring-damper: `stiffness = 20, damping = 8`. Heavier weapons have lower stiffness (slower return).
- This is cosmetic — it doesn't affect where bullets go.

---

## 4. Firing Model — Hipfire vs ADS

Hipfire and ADS are two distinct combat modes, not just a spread toggle. They differ in spread behavior, recoil handling, movement, visual feedback, and which weapons excel. The design goal: **SMGs and shotguns are hipfire weapons. DMRs and snipers are ADS weapons. ARs and carbines reward switching between both.**

### 4.1 Hipfire

Hipfire is the default state. Weapon is held at the hip (lower-right viewport position). No zoom. Full movement speed.

**Spread model:**

```javascript
currentSpread = baseSpread
  * movementMultiplier    // 1.0 still, 1.3 walking, 1.8 sprinting, 0.85 crouched-still
  * sustainedFireMult     // grows per shot, decays over time
  * weaponHipFactor       // per-archetype modifier (see §4.3)
```

- `sustainedFireMult` starts at 1.0. Each shot adds `spreadPerShot` (weapon-specific, 0.3°–0.8°). Decays at `spreadDecayRate` (3°/s) when not firing. Capped at `2.5 × baseSpread`.
- Bullets sample uniformly from the spread cone. Each shot gets an independent random direction within the cone.

**Hipfire recoil:** Full recoil pattern applies (§3). No reduction. The camera kicks hard. For automatic weapons at sustained fire, the crosshair is bouncing and the spread is blooming — this is intentional. Hipfire with an LMG is suppressive, not precise.

**Crosshair (DOM overlay):**
- Four lines forming a dynamic cross, gap at center.
- Lines move outward as spread increases, inward as it decreases.
- Color: white with 1px dark outline for contrast.
- Lines are thin (2px) and minimal — not distracting.
- Crosshair shows *actual current spread* in real-time. The distance from center to each line tip maps linearly to the spread cone angle projected at 10m distance.

**Screen visibility:** Full FOV (80°). Full peripheral vision. Weapon model occupies minimal screen space (lower-right corner). The player sees the battlefield.

### 4.2 ADS (Aim Down Sights)

ADS is entered by holding right mouse button. Weapon moves to screen center. Optic determines zoom and reticle.

**Spread model:**

```javascript
currentSpread = baseADSSpread
  * adsMovementMult       // 1.0 still, 1.1 walking (barely penalized), N/A sprinting (can't sprint in ADS)
  * adsSustainedFireMult  // grows at HALF the hipfire rate
  * weaponADSFactor       // per-archetype modifier (see §4.3)
```

- ADS spread does not increase while moving (walking). This is the key reward: you can strafe and shoot accurately in ADS.
- Sustained fire spread growth is halved compared to hipfire. ADS sustained fire stays tight longer.
- Crouching in ADS: additional -15% spread (multiplied in).

**ADS recoil:** Recoil pattern is multiplied by `0.7` (30% reduction). ADS is more controllable. Combined with crouching: `0.7 × 0.85 = 0.595` (40% reduction). A crouched ADS player with a compensator has very manageable recoil.

**ADS transition:**
1. Weapon model lerps from hip position to screen center over `adsTime`.
2. FOV lerps from 80° to optic-specific FOV (65° for 1× optics, down to 5° for 12× scope).
3. Crosshair fades out. Optic reticle fades in.
4. For scoped optics (≥4×): scope overlay (black surround) fades in during last 30% of transition.
5. For thermal/NV: post-processing shader blends in over the transition.

**ADS restrictions:**
- Cannot sprint. ADS is released if sprint is pressed.
- Movement speed = `moveSpeed × adsSpeed` (typically 40–60% of base).
- Cannot swap weapons.
- Can reload (ADS drops on reload start, re-enters on reload complete if still holding ADS button).

**Screen visibility:** Reduced. Weapon model occludes center-right of screen. Scoped optics add a black surround that kills peripheral vision. The player trades battlefield awareness for precision. A flanker approaching from the left is invisible to a scoped sniper.

### 4.3 Hipfire/ADS Affinity per Archetype

Each archetype has a **hipfire factor** and **ADS factor** that tilt it toward one mode. These multiply the base spread values — lower = tighter = better.

| Archetype | Hip Factor | ADS Factor | Best Mode | Reasoning |
|-----------|-----------|-----------|-----------|-----------|
| Pistol | 0.8 | 0.9 | Hipfire | Fast, close. ADS works but no real advantage. |
| Revolver | 1.0 | 0.7 | ADS | Slow fire rate means you should aim each shot. |
| SMG | **0.6** | 1.0 | **Hipfire** | CQB king. Tight hipfire, ADS offers no edge. |
| Carbine | 0.9 | 0.8 | Hybrid | Good at both. Jack of all trades. |
| AR | 1.0 | 0.7 | ADS-leaning | Hipfire works close, ADS is clearly better at range. |
| Battle Rifle | 1.2 | 0.6 | ADS | Hipfire is punishing. ADS makes it shine. |
| LMG | 1.3 | 0.9 | Neither (area) | Hipfire is a firehose. ADS is slightly better. Bipod changes everything (§4.4). |
| DMR | **1.5** | **0.5** | **ADS** | Hipfire is nearly useless. ADS is surgical. |
| Sniper | **1.8** | **0.3** | **ADS** | Hipfire is a desperation move. ADS or die. |
| Shotgun | **0.5** | 0.8 | **Hipfire** | Spread pattern makes ADS pointless. Hipfire is natural. |

The SMG's 0.6 hipfire factor means its effective hipfire spread is `5.0° × 0.6 = 3.0°` — tighter than most weapons' ADS spread. An SMG player running and gunning from the hip is more effective than the same player trying to ADS with a battle rifle at close range. This is the archetype identity.

The sniper's 1.8 hipfire factor means its effective hipfire spread is `3.0° × 1.8 = 5.4°` — a coin flip at anything beyond 10m. The sniper *must* ADS. But its 0.3 ADS factor gives `0.2° × 0.3 = 0.06°` — a laser beam.

### 4.4 Stance Modifiers (Unified)

All spread and recoil modifiers from stance, applied multiplicatively:

| Stance | Spread Mult (Hip) | Spread Mult (ADS) | Recoil Mult | Move Speed |
|--------|-------------------|-------------------|-------------|------------|
| Standing still | 1.0 | 1.0 | 1.0 | 0 |
| Walking | 1.3 | 1.0 | 1.1 | moveSpeed |
| Sprinting | 1.8 | N/A (no ADS) | N/A | moveSpeed × 1.5 |
| Crouched still | 0.85 | 0.85 | 0.85 | 0 |
| Crouched moving | 1.0 | 0.9 | 0.9 | moveSpeed × 0.6 |
| Prone still | 0.7 | 0.7 | 0.7 | 0 |
| Prone moving | 0.85 | 0.8 | 0.8 | moveSpeed × 0.3 |
| Bipod deployed | 0.5 | 0.4 | 0.4 | 0 (stationary) |
| Jumping/airborne | 2.5 | 2.0 | 1.5 | — |

**Bipod deployed** is the LMG's secret weapon. An LMG with bipod, crouched behind cover, ADS'd: spread = `2.5° × 0.9 × 0.4 = 0.9°`, recoil = `pattern × 0.7 × 0.4 = 0.28×`. It becomes a laser — at the cost of zero mobility. Stand up to move and you're back to firehose mode.

### 4.5 Laser Sight, Flashlight, IR Laser (Accessory Slot)

These are **information tools** mounted on the weapon's side rail. They don't change spread, recoil, or any ballistic stat. They change what you *know* — and what the enemy knows about you.

#### Laser Sight

The laser projects a ray along the weapon's bore axis and places a visible dot on whatever surface the ray hits. It tells you where your barrel is pointing in 3D space.

**Why this matters for hipfire:** The crosshair is a 2D overlay. It can't communicate depth. When you're sweeping a doorway at 3m and a hallway opens to 20m behind it, the crosshair looks the same in both cases — but the laser dot is *on the door frame* vs. *on the far wall*. You get spatial awareness of your aim point that no 2D reticle can provide.

**Implementation:**
- Raycast from weapon muzzle along bore axis every frame → hit point on geometry.
- Laser line: `THREE.Line` from muzzle to hit point. `LineBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.5 })`.
- Laser dot: `PlaneGeometry` billboard at hit point. `MeshBasicMaterial({ color: 0xff0000 })`, 2cm radius, slight scale pulse (±0.5cm at 4Hz) for visibility.
- Dot conforms to surface normal (rotate billboard to face hit normal, not camera).
- Max range: 100m. No dot rendered beyond this.

**ADS behavior:** Laser stays active during ADS. It's a physical device on the weapon — it doesn't know you're looking through a scope. However, the optic reticle provides the same information more precisely, so the laser is redundant in ADS. Players may choose to toggle it off (key: `L`) to avoid detection.

**No stat changes.** Zero spread modification. Zero recoil modification. The laser is information, not magic accuracy.

**AI detection:** Enemies detect the laser dot on surfaces within 15m of them. A detected dot alerts the enemy to "threat from direction X" without revealing exact player position. Sweeping the laser across an enemy's cover position is like shining a spotlight on yourself.

**Geometry:** Small red cylinder (0.5cm diameter, 3cm long) mounted on the weapon's side rail.

#### Flashlight

White directional light cone from the weapon's rail. Illuminates dark interiors and blinds enemies at close range.

**Implementation:**
- `THREE.SpotLight` attached to weapon muzzle. Cone angle: 30°. Range: 25m. Intensity: 2.0.
- Color: warm white (#fff4e0).
- Toggle on/off: key `L` (shared with laser — only one active at a time, or cycle through off → laser → flashlight → off).

**Gameplay effects:**
- Illuminates dark building interiors. Without a flashlight or NV, interior rooms beyond window light are hard to read.
- **Close-range blind:** Enemies within 8m facing the flashlight get a debuff: +50% spread (they flinch/squint), lasts as long as the light is on them. Not a stun — they still shoot, just worse.
- **AI detection:** Flashlight is a beacon. All enemies with line-of-sight within 60m are alerted to player position. Much more conspicuous than the laser.

**Geometry:** Small cylinder on side rail, wider lens face (0.8cm diameter).

#### IR Laser

Invisible to the naked eye. Visible only through Night Vision (§6.4).

**Implementation:**
- Same raycast-and-dot as visible laser, but rendered only when NV post-processing is active.
- In NV mode: bright green line and dot (high visibility against the green-tinted scene).
- Without NV: not rendered at all. No visible indication to anyone not wearing NVGs.

**Gameplay:** Pair with suppressor + NV for a stealth loadout. You get the bore-axis information of a laser without revealing yourself to enemies (enemies don't have NVGs — yet). In later waves, if NV-equipped enemies are introduced, the IR laser becomes detectable.

**Geometry:** Same as laser sight, dark housing instead of red.

### 4.3 Fire Modes

- **`auto`**: hold trigger = continuous fire at `rateOfFire`.
- **`semi`**: one shot per click. Click rate capped at `rateOfFire`.
- **`burst3`**: three shots per click at `rateOfFire` speed, then forced pause of `0.15s`.
- **`pump`**: fire, then pump animation (`0.6s`), then ready. Cannot fire during pump.

Some weapons support mode switching (e.g., carbine can toggle `auto`/`semi`). Defined per weapon. Toggle key: `B`.

### 4.4 Reload

- **Full reload** (empty magazine): `reloadTime` seconds. Weapon cannot fire during reload.
- **Tactical reload** (rounds remaining): `reloadTime × 0.7` seconds. One round stays chambered — new mag has `magSize + 1`.
- **Shotgun reload**: per-shell, `0.5s` per shell. Can interrupt at any time to fire loaded shells. This is the "tactical" feel — always topping off.
- **LMG reload**: long (4.5s). Punishes poor ammo management. The long reload is the LMG's primary weakness.
- Reload animation: weapon model drops down (magazine out), pauses, raises back (magazine in). Simple lerp sequence.
- Sprint cancels reload. Weapon swap cancels reload.

### 4.5 Bullet Properties (Ballistics Pipeline Interface)

Each shot creates a bullet with properties fed to `ballistics.js`:

```javascript
{
  origin: Vector3,         // muzzle position (camera pos + weapon offset)
  direction: Vector3,      // camera forward + spread perturbation
  damage: weapon.damage,   // modified by attachments
  penetration: weapon.penetration,
  range: weapon.range,
  tracerColor: weapon.tracerColor || 0xffaa33,
  isTracer: (shotCount % weapon.tracerInterval) === 0,
  isExplosive: false,
  owner: 'player'          // or enemy ID, for damage attribution
}
```

Shotgun fires `pelletCount` bullets per trigger pull, each with independent spread sampling and the per-pellet damage/penetration values.

---

## 5. Attachment System

Seven slots per weapon. Each attachment modifies base stats with explicit tradeoffs, except accessory items which are information tools.

### 5.1 Slots

| Slot | Function | Available On |
|------|----------|-------------|
| **Muzzle** | Recoil, sound, flash | All except revolver, shotgun |
| **Barrel** | Range, accuracy, handling | All except pistol, revolver |
| **Underbarrel** | Recoil, ADS stability | Carbine, AR, battle rifle, LMG, DMR, sniper |
| **Stock** | Recoil, ADS speed, mobility | All except pistol, revolver |
| **Magazine** | Capacity, reload speed | All |
| **Optic** | Zoom, reticle, vision mode | All |
| **Accessory** | Information tools (laser, flashlight, IR laser) | All except revolver |

### 5.2 Attachment Table

#### Muzzle

| Attachment | Effect | Tradeoff |
|------------|--------|----------|
| **Suppressor** | -100% muzzle flash, AI hearing range ×0.3, no tracer | -10% damage, -5% range |
| **Compensator** | -20% vertical recoil | +10% horizontal recoil spread |
| **Flash Hider** | -80% muzzle flash, -10% vertical recoil | None (weak but free) |
| **Muzzle Brake** | -15% horizontal recoil | +5% vertical recoil |

#### Barrel

| Attachment | Effect | Tradeoff |
|------------|--------|----------|
| **Long Barrel** | +15% range, -10% ADS spread | +10% ADS time, -3% move speed |
| **Short Barrel** | -10% ADS time, +3% move speed | -15% range, +10% ADS spread |
| **Heavy Barrel** | -20% spread (both hip and ADS) | +15% ADS time, -5% move speed |

#### Underbarrel

| Attachment | Effect | Tradeoff |
|------------|--------|----------|
| **Vertical Grip** | -15% vertical recoil | +5% ADS time |
| **Angled Grip** | -10% ADS time | -5% vertical recoil (mild) |
| **Stubby Grip** | -10% sustained fire spread buildup | +5% ADS time |
| **Bipod** | -60% recoil when prone/mounted, -40% when crouched | +15% ADS time standing, no benefit standing |

#### Stock

Each weapon has a default stock type baked into its base stats. Swapping stocks modifies from that baseline. Weapons without stocks (pistol, revolver) don't have this slot.

| Attachment | Effect | Tradeoff | Geometry |
|------------|--------|----------|----------|
| **Full Stock** | -20% recoil (both axes) | +10% ADS time, -5% move speed | Solid box, full width, buttpad |
| **No Stock** | -15% ADS time, +5% move speed | +25% recoil (both axes) | Stock geometry removed entirely |
| **Skeleton Stock** | -10% ADS time, +3% move speed | +10% recoil | Wire frame: two thin rails + minimal buttpad |

**Default stock per archetype:**

| Archetype | Default Stock | Notes |
|-----------|--------------|-------|
| SMG | Skeleton | Light and fast by default |
| Carbine | Full | Standard military config |
| AR | Full | Standard military config |
| Battle Rifle | Full | Needs recoil control |
| LMG | Full | Heavy weapon, needs stability |
| DMR | Full | Precision demands stability |
| Sniper | Full | Heavy stock with cheek rest |
| Shotgun | Full | Tames the kick |

Swapping away from the default stock applies the stat deltas. Example: M4 (default full stock) switched to no stock gets -15% ADS time, +5% move speed, +25% recoil relative to its base stats. This turns it into a CQB carbine — faster handling, harder to control at range.

**Geometry notes:**
- **Full stock**: solid `BoxGeometry`, width matches receiver, extends behind receiver. Buttpad (slightly wider box) at the end.
- **No stock**: buffer tube only — thin cylinder stub extending ~3cm behind receiver. Minimal.
- **Skeleton stock**: two thin parallel rails (`BoxGeometry`, ~2mm × 2mm cross-section) connecting receiver to a small buttpad. Open frame, visually distinct from full stock.

#### Magazine

| Attachment | Effect | Tradeoff |
|------------|--------|----------|
| **Extended Mag** | +50% mag capacity (round up) | +15% reload time |
| **Fast Mag** | -30% reload time | None (rare/late-game find) |
| **Drum Mag** | +100% mag capacity | +30% reload time, -5% ADS time, -3% move speed |

#### Accessory

No stat modifications. These are information/utility tools. See §4.5 for full details.

| Attachment | Effect | Tradeoff |
|------------|--------|----------|
| **Laser Sight** | Visible red laser dot on geometry along bore axis | AI detects dot within 15m |
| **Flashlight** | SpotLight cone illuminates 25m, blinds enemies within 8m (+50% their spread) | AI detects light within 60m — highly conspicuous |
| **IR Laser** | Laser dot visible only through Night Vision | Invisible without NV. Future: NV-equipped enemies can detect |

Only one accessory active at a time. Toggle with `L` key (cycle: off → laser → flashlight → IR → off).

#### Optic

See §6 (dedicated section).

### 5.3 Stat Modification

Attachments modify base stats multiplicatively. Order doesn't matter — all multipliers apply to the base value.

```javascript
function computeStats(weapon, attachments) {
  const stats = { ...weapon.baseStats };
  for (const att of attachments) {
    for (const [stat, modifier] of Object.entries(att.modifiers)) {
      stats[stat] *= (1 + modifier); // modifier is signed: -0.2 = 20% reduction
    }
  }
  return stats;
}
```

### 5.4 Attachment Geometry

Each attachment adds or replaces geometry on the weapon model:
- **Suppressor**: long cylinder at muzzle end. Dark gray (#2a2a2a), slightly wider than barrel.
- **Compensator**: short cylinder with side cuts (two flat faces shaved off). 
- **Grips**: small box or cylinder under the forend. Vertical grip = tall thin box. Angled = wedge.
- **Extended mag**: taller version of the base magazine box.
- **Drum mag**: cylinder replacing the magazine box.
- **Bipod**: two thin cylinders folded under the barrel (deploy animation when prone/crouching).

---

## 6. Optics System

Each optic changes: FOV (zoom), reticle shape, and optionally the rendering mode. Optics are the most visually complex attachment.

### 6.1 Optic Table

| Optic | Zoom | FOV (ADS) | Reticle | Render Mode | Available On |
|-------|------|-----------|---------|-------------|-------------|
| **Iron Sights** | 1.0× | 65° | Weapon geometry (post + notch) | Normal | All (default) |
| **Red Dot** | 1.0× | 65° | Small red dot, centered | Normal | All |
| **Holographic** | 1.0× | 65° | Circle + dot, slight parallax | Normal | All except sniper |
| **ACOG 4×** | 4.0× | 20° | Chevron reticle, BDC marks | Normal | AR, carbine, battle rifle, LMG, DMR |
| **DMR Scope 6×** | 6.0× | 12° | Mil-dot reticle, rangefinder | Normal | DMR, sniper, battle rifle |
| **Sniper Scope 8×** | 8.0× | 8° | Fine crosshair, mil hash marks | Scope overlay (black surround) | Sniper, DMR |
| **Sniper Scope 12×** | 12.0× | 5° | Fine crosshair, mil hash marks | Scope overlay | Sniper only |
| **Thermal 2.5×** | 2.5× | 30° | Simple crosshair | Thermal (§6.3) | All except pistol, revolver, shotgun |
| **Night Vision 1×** | 1.0× | 55° | None (full-screen effect) | NV (§6.4) | Helmet mount (always available, toggle key) |

### 6.2 Reticle Rendering

Reticles are DOM overlays (consistent with HUD approach). When ADS is active, the reticle element appears at screen center.

Each reticle is an SVG element:
- **Red dot**: `<circle>` r=2px, red (#ff0000), slight glow (`drop-shadow`).
- **Holographic**: `<circle>` r=16px stroke + `<circle>` r=1px center, red. 2px stroke width.
- **ACOG chevron**: `<path>` drawing an inverted V, with horizontal hash marks below for BDC (bullet drop compensation). Red (#ff0000).
- **Mil-dot**: `<line>` crosshair with small `<circle>` dots at regular intervals along each axis. Black with thin white outline for visibility.
- **Fine crosshair**: thin `<line>` cross with a gap at center. Black with white outline.

All reticles have a thin dark outline to ensure visibility against bright backgrounds.

### 6.3 Thermal Optic Rendering

Thermal view replaces the scene rendering with a heat-based color map. Implementation via post-processing:

1. Render the scene to an offscreen `WebGLRenderTarget`.
2. Apply a custom `ShaderMaterial` full-screen quad that:
   - Converts each pixel to grayscale (luminance).
   - Maps luminance through a thermal palette: dark blue (#000033) → purple (#330066) → red (#cc0000) → orange (#ff6600) → yellow (#ffff00) → white (#ffffff).
   - **Heat sources** (enemies, muzzle flashes, explosions) are tagged with a `heat` uniform on their materials. The shader samples a second render target (heat mask) where hot objects are rendered white. The thermal shader blends this heat mask as elevated luminance before palette mapping.
3. Result: cold structures are dark blue/purple. Warm enemies are bright orange/yellow/white. Recent gunfire and explosions flare hot.

**Enemy visibility in thermal:** Enemies render with a `heat` material override (emissive white in the heat pass). They are immediately visible against cold backgrounds. This is the primary advantage of thermal — enemies cannot hide in shadows or dark interiors.

**Downsides of thermal:**
- 2.5× zoom locks you to medium range — no close quarters snap-shooting.
- Reduced detail: structural edges and panel damage are harder to read. You see shapes, not details.
- Muzzle flashes and explosions bloom intensely, temporarily blinding the optic.

### 6.4 Night Vision Rendering

Night vision amplifies ambient light. Full-screen effect (not ADS-dependent — toggle with a key, simulating helmet-mounted NVGs).

1. Render scene normally.
2. Post-processing shader:
   - Convert to grayscale luminance.
   - Apply green tint: multiply by `vec3(0.2, 1.0, 0.2)`.
   - Amplify: multiply luminance by 3.0 (configurable). Dark areas become visible.
   - Add noise: per-pixel random offset ±5% luminance (TV static effect). Noise changes per frame.
   - Add bloom: bright sources (muzzle flash, tracers) bloom heavily. Prevents looking at bright objects while using NV.
   - Vignette: darken edges to simulate tube-based NVG field of view.
3. Result: green-tinted view where dark areas are visible. Bright lights are blinding.

**Gameplay effect:** NV lets you see in dark areas (building interiors, nighttime if implemented). Muzzle flashes (yours and enemies') are disorienting. A suppressed weapon + NV = stealth gameplay. An unsuppressed weapon + NV = you blind yourself.

### 6.5 Scope Overlay (High-Zoom Optics)

Sniper and DMR scopes use a **scope overlay** instead of full-screen zoom:

1. Main view renders at reduced FOV (zoomed).
2. A circular mask (DOM overlay, black outside the circle) frames the zoomed view.
3. Outside the scope circle: blurred or darkened (CSS `backdrop-filter: blur(4px)` on the overlay).
4. Scope ring: thin black circle at the mask edge.
5. Reticle (mil-dot or crosshair) renders inside the circle.

This means the player has tunnel vision when scoped — peripheral awareness is lost. Creating vulnerability to flankers.

### 6.6 ADS Transition

When entering ADS:
1. Weapon model lerps to center screen over `adsTime`.
2. FOV lerps from 80° (hipfire) to optic FOV.
3. Crosshair fades, reticle fades in.
4. For scoped optics: scope overlay fades in during the last 30% of `adsTime`.
5. For thermal/NV: shader effect fades in (blend factor 0→1 over `adsTime`).

---

## 7. AI Weapon Interaction

### 7.1 Suppressor Effect on AI

The suppressor's primary value is tactical, not ballistic.

**Without suppressor:**
- Firing generates a sound event at `hearingRadius = 80m`.
- All enemies within radius are alerted to player position.
- Muzzle flash is visible — enemies with line-of-sight can detect the player even if they weren't already aware.

**With suppressor:**
- Hearing radius reduced to `80 × 0.3 = 24m`.
- No muzzle flash — enemies must have line-of-sight AND be looking toward the player to detect via visual.
- Bullet impacts still generate sound (enemy near an impact point is alerted to "fire from direction X" but not the exact source position).

### 7.2 Enemy Weapon Assignments

Enemies carry specific weapon archetypes that determine their ballistic behavior:

| Enemy Type | Weapon | Fire Mode | Notes |
|------------|--------|-----------|-------|
| Rifleman | AR (AK-74 stats) | Auto, 2–4 round bursts | Pauses between bursts, accurate |
| Flanker | SMG (MP7 stats) | Auto, sustained | Sprays while moving, inaccurate |
| Heavy | LMG (M249 stats) | Auto, long bursts (10–20 rds) | Suppressive fire, wide spread |
| RPG | RPG launcher (special) | Single shot | Explosive projectile, long reload |

Enemy bullets go through the same ballistics pipeline. Their misses damage the environment. A Heavy's sustained fire chews through walls — this is how suppression becomes physical.

---

## 8. Loadout & Progression

### 8.1 Starting Loadout

Run starts with:
- **Primary**: M4 Carbine (iron sights, no attachments)
- **Secondary**: M9A1 Pistol (iron sights, no attachments)
- **Grenades**: 2

### 8.2 Weapon Acquisition

During **Reposition phases** (between wave sets), the player finds weapon crates in the environment:
- Crate contains one random weapon (archetype + 0–2 random attachments).
- Player can swap their primary or secondary for the crate weapon.
- Dropped weapon stays at the crate location (can return to pick it back up if the player hasn't moved to a new defense position).

**Wave completion rewards**: after every 3rd wave, a guaranteed attachment drop. Player picks from 2 random options. Attachment applies to currently held weapon.

### 8.3 Ammo

- Ammo is per-archetype, not per-weapon. If you find an AK-74 and are carrying an M4, switching to the AK gives you whatever "rifle ammo" you had.
- Ammo types: **pistol**, **rifle**, **heavy** (LMG/battle rifle), **sniper**, **shotgun shells**.
- Starting ammo: 4 magazines worth for primary, 3 for secondary.
- Resupply between waves: +2 magazines for each carried weapon.
- Scavenge during reposition: ammo pickups in the environment (small boxes, give 1 magazine).

### 8.4 No Crafting

No crafting, no gunsmithing bench, no disassembly. Attachments are found and applied. This keeps the flow fast — the game is about shooting and positioning, not inventory management.

---

## 9. Weapon Feel (Audio + Visual)

### 9.1 Audio Profiles

Each weapon has a distinct sound. Use Web Audio API oscillator synthesis — no audio files.

**Sound layers per shot:**
1. **Crack**: short burst (5–20ms), saw/square wave, frequency 800–2000Hz. Higher for pistols, lower for rifles.
2. **Boom**: longer decay (50–200ms), low-frequency sine, 80–200Hz. Heavier for shotgun/sniper.
3. **Tail**: filtered noise, 100–500ms decay. Simulates room reverb / outdoor echo.

| Archetype | Crack Freq | Boom Freq | Tail Length | Character |
|-----------|-----------|-----------|-------------|-----------|
| Pistol | 1800Hz | 150Hz | 100ms | Sharp snap |
| Revolver | 1200Hz | 100Hz | 200ms | Deep boom |
| SMG | 2000Hz | 180Hz | 80ms | Rapid tapping |
| Carbine | 1400Hz | 120Hz | 150ms | Balanced crack |
| AR | 1200Hz | 100Hz | 180ms | Heavy crack |
| Battle Rifle | 1000Hz | 80Hz | 200ms | Thumping |
| LMG | 1100Hz | 90Hz | 200ms | Rolling thunder |
| DMR | 1000Hz | 90Hz | 250ms | Deliberate boom |
| Sniper | 800Hz | 60Hz | 400ms | Massive report |
| Shotgun | 600Hz | 50Hz | 300ms | Deep blast |

**Suppressor effect on audio:** Remove crack layer entirely. Reduce boom frequency by 50% and volume by 70%. Extend tail slightly. Result: a muffled "thump" instead of a sharp crack.

### 9.2 Muzzle Flash

Geometry-based (no textures, no sprites):
- 3–5 thin `PlaneGeometry` quads arranged in a star pattern at the muzzle.
- `MeshBasicMaterial` (not Lambert — flash is emissive), color yellow-orange (#ffaa33).
- Random rotation per frame. Random scale 0.8–1.2×.
- Duration: 1 frame (removed next frame). Creates a flicker effect at high fire rates.
- Suppressor: no flash geometry spawned.

### 9.3 Weapon Bob

Camera/weapon bob while moving:
- **Walk**: sinusoidal bob. Amplitude 1.5cm vertical, 0.8cm horizontal. Frequency matches step rate (~2Hz).
- **Sprint**: larger amplitude (3cm V, 1.5cm H), higher frequency (~3Hz). Weapon tilts forward slightly.
- **ADS**: bob reduced to 20% amplitude. Player feels stable when aiming.
- **Crouch-walk**: bob at 50% amplitude, 70% frequency. Slower, more deliberate.

### 9.4 Ejection (Cosmetic)

On each shot, spawn a small brass-colored box (1cm × 0.5cm × 0.5cm) from the weapon's ejection port:
- Initial velocity: right + up + slight random.
- Gravity + spin. Despawns after 1 second or on ground contact.
- Object pooled (shared with debris pool).
- Revolver: no ejection (casings stay in cylinder). Eject all on reload.
- Shotgun: eject shell on pump action.

---

## 10. Implementation Order

1. **Weapon data structures** — `WeaponDef`, `AttachmentDef`, stat tables, `computeStats()`.
2. **Weapon geometry builder** — procedural mesh generation per archetype. Viewmodel + world model.
3. **Firing model** — fire modes, spread, bullet creation feeding into ballistics pipeline.
4. **Recoil system** — pattern storage, per-shot application, recovery.
5. **ADS** — FOV transition, weapon centering, spread switch, movement speed change.
6. **Reticle overlays** — SVG reticles for each optic type. DOM overlay management.
7. **Weapon swap + reload** — animation sequences, state machine, ammo tracking.
8. **Audio profiles** — Web Audio synthesis per archetype.
9. **Muzzle flash + ejection** — geometry spawning, pooling.
10. **Attachment stat modification** — modifier application, geometry additions.
11. **Optic rendering: thermal** — heat pass, palette shader, post-processing.
12. **Optic rendering: NV** — amplification shader, noise, bloom.
13. **Scope overlay** — circular mask, blur, high-zoom optics.
14. **Loadout system** — weapon crates, wave rewards, swap UI.
15. **AI weapon integration** — enemy weapon assignments, suppressor hearing reduction.

Steps 1–6 are minimum viable weapons. Steps 7–10 complete the core feel. Steps 11–15 add depth.

---

## 11. Performance Notes

- Weapon geometry is static per configuration — rebuild only on attachment change, not per frame.
- Recoil pattern lookup is O(1) (array index).
- Muzzle flash + ejected brass use the debris object pool.
- Thermal/NV post-processing adds one extra render pass. Budget: <2ms on mid-range GPU. Skip on low-end (setting toggle).
- Shotgun multi-raycast (8 rays per shot) fits within the per-frame raycast budget (50 max) since fire rate is low (1.2 rps).
- Audio synthesis is cheap — one oscillator node per shot, auto-disconnects after decay.