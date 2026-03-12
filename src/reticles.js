// ─── RETICLE & CROSSHAIR SYSTEM ───────────────────────────
// SVG reticles for optic types, dynamic hipfire crosshair, scope overlay.
// All rendering is DOM-based (consistent with HUD approach).

const DEG = Math.PI / 180;

// ─── DOM REFERENCES ───────────────────────────────────────
let crosshairContainer = null;
let xhairTop = null, xhairBottom = null, xhairLeft = null, xhairRight = null;
let adsReticle = null;
let scopeOverlay = null;
let scopeBlur = null;
let scopeRing = null;

// ─── INIT ─────────────────────────────────────────────────

export function initCrosshair() {
  crosshairContainer = document.getElementById('crosshair');
  if (!crosshairContainer) return;

  // Clear old static crosshair content
  crosshairContainer.innerHTML = '';
  // Remove pseudo-element styling by adding a class
  crosshairContainer.classList.add('dynamic');

  // Create 4 dynamic crosshair lines
  xhairTop = createLine('xhair-top');
  xhairBottom = createLine('xhair-bottom');
  xhairLeft = createLine('xhair-left');
  xhairRight = createLine('xhair-right');

  crosshairContainer.appendChild(xhairTop);
  crosshairContainer.appendChild(xhairBottom);
  crosshairContainer.appendChild(xhairLeft);
  crosshairContainer.appendChild(xhairRight);

  // Get or create reticle container
  adsReticle = document.getElementById('ads-reticle');
  if (!adsReticle) {
    adsReticle = document.createElement('div');
    adsReticle.id = 'ads-reticle';
    document.getElementById('hud').appendChild(adsReticle);
  }

  // Get or create scope overlay
  scopeOverlay = document.getElementById('scope-overlay');
  if (!scopeOverlay) {
    scopeOverlay = document.createElement('div');
    scopeOverlay.id = 'scope-overlay';
    document.body.appendChild(scopeOverlay);
  }

  // Scope blur and ring (Step 13)
  scopeBlur = document.getElementById('scope-blur');
  scopeRing = document.getElementById('scope-ring');
}

function createLine(id) {
  const el = document.createElement('div');
  el.id = id;
  el.className = 'xhair-line';
  return el;
}

// ─── UPDATE CROSSHAIR ─────────────────────────────────────
// Called each frame with current spread angle and ADS blend.

export function updateCrosshair(spreadDeg, adsBlend, fov) {
  if (!crosshairContainer) return;

  // Convert spread angle to pixel offset at screen center
  // Project spread cone at a reference distance onto the screen
  const fovRad = (fov || 80) * DEG;
  const screenH = window.innerHeight;
  const spreadRad = spreadDeg * DEG;
  const spreadPixels = Math.tan(spreadRad) / Math.tan(fovRad / 2) * (screenH / 2);

  // Clamp spread display
  const offset = Math.max(4, Math.min(80, spreadPixels));
  const lineLen = 10;

  // Position lines (offset from center)
  if (xhairTop) {
    xhairTop.style.transform = `translate(-50%, 0) translateY(${-offset - lineLen}px)`;
    xhairTop.style.height = lineLen + 'px';
  }
  if (xhairBottom) {
    xhairBottom.style.transform = `translate(-50%, 0) translateY(${offset}px)`;
    xhairBottom.style.height = lineLen + 'px';
  }
  if (xhairLeft) {
    xhairLeft.style.transform = `translate(0, -50%) translateX(${-offset - lineLen}px)`;
    xhairLeft.style.width = lineLen + 'px';
  }
  if (xhairRight) {
    xhairRight.style.transform = `translate(0, -50%) translateX(${offset}px)`;
    xhairRight.style.width = lineLen + 'px';
  }

  // Fade crosshair out during ADS, reticle in
  const crosshairOpacity = Math.max(0, 1 - adsBlend * 2); // fades out by 50% blend
  const reticleOpacity = Math.max(0, (adsBlend - 0.5) * 2); // fades in after 50% blend

  crosshairContainer.style.opacity = crosshairOpacity.toFixed(3);

  if (adsReticle) {
    adsReticle.style.opacity = reticleOpacity.toFixed(3);
    adsReticle.style.display = reticleOpacity > 0.01 ? 'block' : 'none';
  }

  // Scope overlay, blur, and ring for scoped optics (Step 13)
  const isScoped = scopeOverlay && scopeOverlay._scoped;
  if (isScoped) {
    const scopeBlend = Math.max(0, (adsBlend - 0.7) / 0.3); // fades in during last 30%
    const opStr = scopeBlend.toFixed(3);
    const show = scopeBlend > 0.01;

    scopeOverlay.style.opacity = opStr;
    scopeOverlay.style.display = show ? 'block' : 'none';

    if (scopeBlur) {
      scopeBlur.style.opacity = opStr;
      scopeBlur.style.display = show ? 'block' : 'none';
    }
    if (scopeRing) {
      scopeRing.style.opacity = opStr;
      scopeRing.style.display = show ? 'block' : 'none';
    }
  } else {
    if (scopeOverlay) scopeOverlay.style.display = 'none';
    if (scopeBlur) scopeBlur.style.display = 'none';
    if (scopeRing) scopeRing.style.display = 'none';
  }
}

// ─── SET RETICLE ──────────────────────────────────────────
// Changes the ADS reticle based on optic type.

export function setReticle(opticType) {
  if (!adsReticle) return;
  adsReticle.innerHTML = '';

  let svg = null;
  let scoped = false;

  switch (opticType) {
    case 'red_dot':
      svg = createRedDotSVG();
      break;
    case 'holographic':
      svg = createHoloSVG();
      break;
    case 'acog':
      svg = createACOGSVG();
      scoped = true;
      break;
    case 'mil_dot':
      svg = createMilDotSVG();
      scoped = true;
      break;
    case 'fine_crosshair':
      svg = createFineCrosshairSVG();
      scoped = true;
      break;
    case 'none':
    default:
      // Iron sights — no reticle overlay
      break;
  }

  if (svg) {
    adsReticle.appendChild(svg);
  }

  if (scopeOverlay) {
    scopeOverlay._scoped = scoped;
  }
}

// ─── SVG RETICLE FACTORIES ────────────────────────────────

function createSVG(width, height) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.position = 'absolute';
  svg.style.top = '50%';
  svg.style.left = '50%';
  svg.style.transform = `translate(-50%, -50%)`;
  svg.style.pointerEvents = 'none';
  return svg;
}

function createRedDotSVG() {
  const svg = createSVG(20, 20);
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', 10);
  circle.setAttribute('cy', 10);
  circle.setAttribute('r', 3);
  circle.setAttribute('fill', '#ff0000');
  circle.setAttribute('filter', 'url(#glow)');

  // Glow filter
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
  filter.setAttribute('id', 'glow');
  const blur = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur');
  blur.setAttribute('stdDeviation', '2');
  blur.setAttribute('result', 'coloredBlur');
  const merge = document.createElementNS('http://www.w3.org/2000/svg', 'feMerge');
  const mn1 = document.createElementNS('http://www.w3.org/2000/svg', 'feMergeNode');
  mn1.setAttribute('in', 'coloredBlur');
  const mn2 = document.createElementNS('http://www.w3.org/2000/svg', 'feMergeNode');
  mn2.setAttribute('in', 'SourceGraphic');
  merge.appendChild(mn1);
  merge.appendChild(mn2);
  filter.appendChild(blur);
  filter.appendChild(merge);
  defs.appendChild(filter);
  svg.appendChild(defs);
  svg.appendChild(circle);
  return svg;
}

function createHoloSVG() {
  const svg = createSVG(60, 60);
  const cx = 30, cy = 30;

  // Outer circle
  const outerCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  outerCircle.setAttribute('cx', cx);
  outerCircle.setAttribute('cy', cy);
  outerCircle.setAttribute('r', 20);
  outerCircle.setAttribute('fill', 'none');
  outerCircle.setAttribute('stroke', '#ff0000');
  outerCircle.setAttribute('stroke-width', '2');
  outerCircle.setAttribute('opacity', '0.9');
  svg.appendChild(outerCircle);

  // Center dot
  const centerDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  centerDot.setAttribute('cx', cx);
  centerDot.setAttribute('cy', cy);
  centerDot.setAttribute('r', 1.5);
  centerDot.setAttribute('fill', '#ff0000');
  svg.appendChild(centerDot);

  return svg;
}

function createACOGSVG() {
  const svg = createSVG(100, 100);
  const cx = 50, cy = 50;

  // Chevron (inverted V)
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chevron.setAttribute('d', `M${cx - 12},${cy + 10} L${cx},${cy} L${cx + 12},${cy + 10}`);
  chevron.setAttribute('fill', 'none');
  chevron.setAttribute('stroke', '#ff0000');
  chevron.setAttribute('stroke-width', '2');
  svg.appendChild(chevron);

  // BDC hash marks below chevron
  for (let i = 1; i <= 3; i++) {
    const y = cy + 10 + i * 10;
    const halfW = 5;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', cx - halfW);
    line.setAttribute('y1', y);
    line.setAttribute('x2', cx + halfW);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', '#ff0000');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('opacity', '0.7');
    svg.appendChild(line);
  }

  // Thin vertical line above chevron
  const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  vLine.setAttribute('x1', cx);
  vLine.setAttribute('y1', cy - 20);
  vLine.setAttribute('x2', cx);
  vLine.setAttribute('y2', cy - 4);
  vLine.setAttribute('stroke', '#ff0000');
  vLine.setAttribute('stroke-width', '1');
  vLine.setAttribute('opacity', '0.6');
  svg.appendChild(vLine);

  return svg;
}

function createMilDotSVG() {
  const svg = createSVG(200, 200);
  const cx = 100, cy = 100;
  const gap = 8;
  const lineLen = 80;

  // Create outlined crosshair lines with dots
  const attrs = { stroke: '#000', 'stroke-width': '1.5' };
  const outlineAttrs = { stroke: 'rgba(255,255,255,0.5)', 'stroke-width': '3' };

  // Helper to add outlined line
  function addLine(x1, y1, x2, y2) {
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    Object.entries(outlineAttrs).forEach(([k, v]) => outline.setAttribute(k, v));
    outline.setAttribute('x1', x1); outline.setAttribute('y1', y1);
    outline.setAttribute('x2', x2); outline.setAttribute('y2', y2);
    svg.appendChild(outline);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    Object.entries(attrs).forEach(([k, v]) => line.setAttribute(k, v));
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    svg.appendChild(line);
  }

  // Top
  addLine(cx, cy - gap, cx, cy - gap - lineLen);
  // Bottom
  addLine(cx, cy + gap, cx, cy + gap + lineLen);
  // Left
  addLine(cx - gap, cy, cx - gap - lineLen, cy);
  // Right
  addLine(cx + gap, cy, cx + gap + lineLen, cy);

  // Mil dots along each axis
  const dotInterval = 16;
  for (let i = 1; i <= 4; i++) {
    const positions = [
      [cx, cy - gap - i * dotInterval],
      [cx, cy + gap + i * dotInterval],
      [cx - gap - i * dotInterval, cy],
      [cx + gap + i * dotInterval, cy],
    ];
    for (const [dx, dy] of positions) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', dx);
      dot.setAttribute('cy', dy);
      dot.setAttribute('r', 2);
      dot.setAttribute('fill', '#000');
      dot.setAttribute('stroke', 'rgba(255,255,255,0.5)');
      dot.setAttribute('stroke-width', '1');
      svg.appendChild(dot);
    }
  }

  return svg;
}

function createFineCrosshairSVG() {
  const svg = createSVG(160, 160);
  const cx = 80, cy = 80;
  const gap = 6;
  const lineLen = 60;

  function addLine(x1, y1, x2, y2) {
    // White outline
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    outline.setAttribute('x1', x1); outline.setAttribute('y1', y1);
    outline.setAttribute('x2', x2); outline.setAttribute('y2', y2);
    outline.setAttribute('stroke', 'rgba(255,255,255,0.4)');
    outline.setAttribute('stroke-width', '2.5');
    svg.appendChild(outline);

    // Black line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', '#000');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
  }

  addLine(cx, cy - gap, cx, cy - gap - lineLen);
  addLine(cx, cy + gap, cx, cy + gap + lineLen);
  addLine(cx - gap, cy, cx - gap - lineLen, cy);
  addLine(cx + gap, cy, cx + gap + lineLen, cy);

  return svg;
}
