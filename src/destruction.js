// Destruction system — panel and prop registry
// Full structural integrity logic is future work (priority 6).
// For now: store panel data so other systems can read HP, type, and vertex offsets.

export const panels        = new Map(); // panelId → panelData
export const props         = new Map(); // propId  → propData
// Grid-position reverse lookup: `${wallId},${gridX},${gridY}` → panelId.
// Used to resolve raycast hits on merged-quad geometry (hit point → floor(localCoord) → panel).
export const panelByGridPos = new Map();

let _nextId = 0;

export function registerPanel(data) {
  const id = data.id ?? _nextId++;
  panels.set(id, data);
  if (data.wallId !== undefined && data.gridX !== undefined && data.gridY !== undefined) {
    panelByGridPos.set(`${data.wallId},${data.gridX},${data.gridY}`, id);
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
  return p.hp;
}

export function clearBuilding(buildingId) {
  for (const [id, p] of panels) {
    if (p.buildingId !== buildingId) continue;
    if (p.wallId !== undefined && p.gridX !== undefined && p.gridY !== undefined)
      panelByGridPos.delete(`${p.wallId},${p.gridX},${p.gridY}`);
    panels.delete(id);
  }
  for (const [id, p] of props)  if (p.buildingId === buildingId) props.delete(id);
}
