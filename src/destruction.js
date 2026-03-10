// Destruction system — panel and prop registry
// Tracks panel data (HP, type, vertex offsets) and handles slab re-splitting
// when panels in merged meshes are destroyed.

export const panels        = new Map(); // panelId → panelData
export const props         = new Map(); // propId  → propData
// Grid-position reverse lookup: `${wallId},${gridX},${gridY}` → panelId.
// Used to resolve raycast hits on merged-quad geometry (hit point → floor(localCoord) → panel).
export const panelByGridPos = new Map();
// Wall-level grouping: wallId → Set<panelId>. Used for slab re-splitting.
export const panelsByWall   = new Map();

let _nextId = 0;
let _slabGroupId = 0;

export function nextSlabGroupId() { return _slabGroupId++; }

export function registerPanel(data) {
  const id = data.id ?? _nextId++;
  panels.set(id, data);
  if (data.wallId !== undefined && data.gridX !== undefined && data.gridY !== undefined) {
    panelByGridPos.set(`${data.wallId},${data.gridX},${data.gridY}`, id);
  }
  if (data.wallId !== undefined) {
    const key = `${data.buildingId},${data.wallId}`;
    if (!panelsByWall.has(key)) panelsByWall.set(key, new Set());
    panelsByWall.get(key).add(id);
  }
  return id;
}

export function registerProp(data) {
  const id = data.id ?? _nextId++;
  props.set(id, data);
  return id;
}

export function damagePanel(id, amount) {
  const p = panels.get(id);
  if (!p) return;
  p.hp = Math.max(0, p.hp - amount);
  // When HP reaches 0, the containing merged slab should be re-split.
  // The caller (weapons/player) is responsible for triggering rebuildMergedSlab()
  // via the buildings module, passing p.buildingId and p.wallId.
  return p.hp;
}

export function clearBuilding(buildingId) {
  for (const [id, p] of panels) {
    if (p.buildingId !== buildingId) continue;
    if (p.wallId !== undefined && p.gridX !== undefined && p.gridY !== undefined)
      panelByGridPos.delete(`${p.wallId},${p.gridX},${p.gridY}`);
    if (p.wallId !== undefined) {
      const key = `${p.buildingId},${p.wallId}`;
      const set = panelsByWall.get(key);
      if (set) { set.delete(id); if (set.size === 0) panelsByWall.delete(key); }
    }
    panels.delete(id);
  }
  for (const [id, p] of props)  if (p.buildingId === buildingId) props.delete(id);
}
