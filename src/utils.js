// ─── SEEDED RNG ────────────────────────────────────────────
export function seededRNG(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

export function chunkSeed(cx, cz) {
  return ((cx * 73856093) ^ (cz * 19349663)) & 0x7FFFFFFF;
}

export function chunkKey(cx, cz) { return `${cx},${cz}`; }

// ─── PERLIN NOISE ───────────────────────────────────────────
export function createPerlin(seed) {
  // Build permutation table shuffled with LCG
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed >>> 0;
  for (let i = 255; i > 0; i--) {
    s = Math.imul(s, 1664525) + 1013904223 >>> 0;
    const j = s % (i + 1);
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function lerp(a, b, t) { return a + t * (b - a); }
  function grad(h, x, y) {
    const u = (h & 4) ? y : x;
    const v = (h & 4) ? x : y;
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }

  return function noise(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const a = perm[X] + Y, b = perm[X + 1] + Y;
    return lerp(
      lerp(grad(perm[a],     x,     y), grad(perm[b],     x - 1, y),     u),
      lerp(grad(perm[a + 1], x,     y - 1), grad(perm[b + 1], x - 1, y - 1), u),
      v
    );
  };
}
