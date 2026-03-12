# Gun Workbench Spec — sprawl

## Context

A real-time 3D weapon viewer and editor. Dual-mode: runs standalone as a design tool (`workbench.html`) and integrates into the game as the loadout screen between waves.

Uses the **existing weapon geometry builder** in `src/weapons.js` — do not duplicate geometry code. The workbench imports and calls the same functions that build viewmodel/world model meshes in-game.

Read `CLAUDE.md` and `weapons-spec.md` before starting. Obey all hard rules.

---

## 1. Architecture

### 1.1 Shared Module

Create `src/workbench.js` — the workbench logic as an ES module. It imports from `src/weapons.js` (geometry builder, weapon defs, attachment defs, `computeStats()`).

```
src/workbench.js    — workbench scene, UI, controls
src/weapons.js      — weapon data + geometry (already exists)
workbench.html      — standalone entry point (imports workbench.js)
```

### 1.2 Standalone Mode

`workbench.html` at project root. Own Three.js scene, own renderer, own DOM. Opens in browser directly. Used for design iteration — tweak geometry, colors, proportions, see stats.

### 1.3 Game-Integrated Mode

Called from `src/main.js` during the **Setup** and **Reposition** phases (see wave system). The workbench renders into the game's existing renderer/canvas. Game loop pauses combat but keeps rendering. Player pointer lock releases. Workbench UI overlays the screen. Closing the workbench returns to gameplay.

```javascript
// In main.js or waves.js:
import { openWorkbench, closeWorkbench } from './workbench.js';

// On entering Setup/Reposition phase:
openWorkbench(renderer, camera, scene, currentLoadout, availableWeapons);

// On confirm/close:
const newLoadout = closeWorkbench();
```

### 1.4 API

```javascript
// workbench.js exports:

openWorkbench(renderer, camera, scene, loadout, available)
// Sets up workbench scene objects, shows UI overlay, returns nothing.
// In standalone mode: creates its own renderer/camera/scene.

closeWorkbench() → loadout
// Tears down UI, removes scene objects, returns the player's chosen loadout:
// { primary: { weapon, attachments }, secondary: { weapon, attachments } }

// Also export for standalone:
initStandalone(container)
// Creates renderer, camera, scene, starts render loop.
```

---

## 2. 3D Viewport

### 2.1 Scene Setup

- Background: dark (#1a1a22)
- Lighting: ambient (0x404050, 0.6) + directional key (warm, from upper-right) + fill (cool, from left) + rim (orange accent, from behind). Matches game lighting feel.
- Ground: `GridHelper` (subtle, toggleable)
- Weapon centered at origin, slightly above ground plane

### 2.2 Camera Controls

Orbit around the weapon. No library — minimal custom implementation:

- **Drag** (left mouse): rotate theta/phi around origin
- **Scroll**: zoom (clamp 0.15–1.5 distance)
- **Turntable**: slow auto-rotation when idle. Stops on drag, resumes after 3s of no input.

In game-integrated mode: orbit controls replace FPS controls while workbench is open. On close, restore FPS camera.

### 2.3 Weapon Display

Call the existing geometry builder from `weapons.js` to produce the weapon mesh. The workbench just mounts it at the origin.

```javascript
// pseudocode
const weaponMesh = buildWeaponGeometry(weaponDef, attachments, colors);
scene.add(weaponMesh);
```

When any parameter changes (weapon selection, attachment, color, slider), rebuild and replace the mesh. The geometry builder should already handle attachments modifying the mesh (suppressor adds cylinder at muzzle, etc.).

### 2.4 Laser Preview

When the laser sight accessory is selected, render a `THREE.Line` from the muzzle along the bore axis plus a pulsing dot on the ground plane. Visualizes what the player will see in-game.

---

## 3. UI Overlay

DOM-based. Same font stack as HUD: Share Tech Mono (data), Rajdhani (headings). Dark panel on the right side of the screen (~320px wide).

### 3.1 Weapon Selector

Grid of buttons, one per archetype. 10 buttons (pistol through shotgun). Active weapon highlighted in orange (#f39c12).

In game-integrated mode: only show weapons the player has **available** (carried + found in crates). Gray out unavailable ones.

### 3.2 Attachment Dropdowns

One `<select>` per slot: muzzle, barrel, underbarrel, magazine, optic, accessory. Options from `weapons-spec.md` §5. Selecting an attachment immediately rebuilds the weapon mesh and updates stats.

In game-integrated mode: only show attachments the player has found/earned. "None" is always available.

### 3.3 Geometry Sliders

Sliders for tweaking weapon proportions. These exist for **design iteration** — they modify parameters that feed into the geometry builder.

Parameters to expose:
- Barrel length, barrel radius
- Receiver length, height, width
- Grip length, grip drop angle
- Magazine length, width, curve

Stock dimensions are **not** sliders — they are determined by the stock attachment (full, skeleton, none). The geometry builder selects stock geometry based on the attachment choice.

Each slider: label, range input, numeric readout. Changes rebuild the mesh in real-time.

**In game-integrated mode: hide geometry sliders.** Players don't tweak geometry — they swap attachments. The sliders are a developer tool only. Gate behind a flag:

```javascript
openWorkbench(renderer, camera, scene, loadout, available, { devMode: false });
```

### 3.4 Color Pickers

Color inputs for: receiver, barrel, stock, magazine, accent. These map to the `MeshLambertMaterial` colors used by the geometry builder.

Show in both modes — cosmetic customization is gameplay-relevant (personalization).

### 3.5 Stat Readout

Display computed weapon stats after attachment modifications. Call `computeStats(weapon, attachments)` from `weapons.js`.

Show: damage, penetration, rate of fire, magazine size, reload time, ADS time, move speed, hip spread, ADS spread, range, headshot multiplier, fire mode, weight, swap time.

Format: label-value pairs, monospace. Highlight stats that differ from base (green if improved, red if worse).

### 3.6 Display Toggles

- Ground grid on/off
- Turntable on/off
- Wireframe overlay on/off (useful for checking geometry)

### 3.7 Confirm/Cancel (Game Mode Only)

In game-integrated mode, show Confirm and Cancel buttons at the bottom of the panel. Confirm applies the loadout and closes the workbench. Cancel reverts to the previous loadout.

---

## 4. Primary/Secondary Switching

The player carries two weapons. The workbench needs tabs or a toggle to switch between editing the primary and secondary weapon.

- Two slots at the top of the panel: "PRIMARY" and "SECONDARY"
- Active slot highlighted
- Clicking a slot loads that weapon into the viewer
- Each slot independently tracks weapon + attachments + colors

---

## 5. Integration Points

### 5.1 Wave System → Workbench

The wave system (when implemented) opens the workbench during Setup and Reposition phases:

```javascript
// waves.js
if (phase === 'setup' || phase === 'reposition') {
  openWorkbench(renderer, camera, scene, player.loadout, player.availableWeapons, {
    devMode: false,
    onConfirm: (loadout) => { player.loadout = loadout; resumeGame(); },
    onCancel: () => { resumeGame(); }
  });
}
```

### 5.2 Weapon Crates → Available Pool

When the player interacts with a weapon crate during Reposition, add the crate's weapon/attachments to `player.availableWeapons`. The workbench reflects the updated pool.

### 5.3 Viewmodel Update

On workbench close, the player's first-person viewmodel must rebuild to reflect the new loadout. Call the same geometry builder with the confirmed weapon + attachments.

---

## 6. Standalone Entry Point

`workbench.html`:

```html
<!DOCTYPE html>
<html>
<head><title>SPRAWL — Gun Workbench</title></head>
<body>
<script type="importmap">{ "imports": { "three": "..." } }</script>
<script type="module">
  import { initStandalone } from './src/workbench.js';
  initStandalone(document.body);
</script>
</body>
</html>
```

In standalone mode:
- All weapons available (no gating)
- Geometry sliders shown (devMode: true)
- No confirm/cancel buttons
- No primary/secondary tabs (just one weapon at a time)

---

## 7. Implementation Order

1. **`src/workbench.js` scaffold** — scene setup, orbit camera, weapon mount point. Import geometry builder from `weapons.js`.
2. **Standalone entry** — `workbench.html`, verify weapon mesh renders and rotates.
3. **Weapon selector UI** — grid buttons, swap weapon on click, rebuild mesh.
4. **Attachment dropdowns** — all 6 slots, rebuild mesh on change.
5. **Stat readout** — computed stats with diff highlighting.
6. **Geometry sliders** — parameter sliders, real-time rebuild.
7. **Color pickers** — material color customization.
8. **Laser preview** — line + dot when laser accessory selected.
9. **Game integration** — `openWorkbench`/`closeWorkbench` API, primary/secondary tabs, confirm/cancel.
10. **Wire to wave system** — open on Setup/Reposition phases.

Steps 1–6 give you a working design tool. Steps 7–10 make it a game feature.