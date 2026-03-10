// ─── biomes.js ────────────────────────────────────────────────────────────────
// Biome definitions and archetype selection — §8 of building-generation-spec.md

const BIOME_CONFIGS = {
  suburbs: {
    archetypeWeights: { dwelling: 0.8, strip_mall: 0.2 },
  },
  strip_mall: {
    archetypeWeights: { strip_mall: 0.7, warehouse: 0.2, office: 0.1 },
  },
  industrial: {
    archetypeWeights: { warehouse: 0.6, office: 0.2, strip_mall: 0.2 },
  },
  downtown: {
    archetypeWeights: { office: 0.5, apartment: 0.4, strip_mall: 0.1 },
  },
};

// Distance-ring biome zones centred on origin (chunk coords).
// 0–3 chunks  = suburbs
// 3–7 chunks  = strip_mall transition
// 7–12 chunks = industrial
// 12+         = downtown core
export function getBiomeAt(cx, cz) {
  const d = Math.sqrt(cx * cx + cz * cz);
  if (d < 3)  return 'suburbs';
  if (d < 7)  return 'strip_mall';
  if (d < 12) return 'industrial';
  return 'downtown';
}

// Weighted random selection from the biome's archetype probability table.
export function selectArchetype(biome, rng) {
  const weights = BIOME_CONFIGS[biome]?.archetypeWeights ?? BIOME_CONFIGS.suburbs.archetypeWeights;
  let total = 0;
  for (const w of Object.values(weights)) total += w;
  let roll = rng() * total;
  for (const [arch, w] of Object.entries(weights)) {
    roll -= w;
    if (roll <= 0) return arch;
  }
  return Object.keys(weights)[0];
}
