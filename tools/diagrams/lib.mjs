/**
 * Drawing and animation helpers for the README diagrams.
 *
 * Frames are rendered to PNG with node-canvas and assembled by ffmpeg. Colours
 * are chosen to sit on their own dark card so the result reads correctly against
 * both the light and dark GitHub themes.
 */
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const SCALE = 2;
export const W = 760;
export const H = 430;
export const FPS = 20;

export const C = {
  bg: '#0f1318',
  panel: '#171d26',
  panelEdge: '#283345',
  text: '#d7e0ec',
  dim: '#8793a6',
  faint: '#5a6475',
  idle: '#3a4659',
  changed: '#f0a23c',
  ok: '#6fd58a',
  move: '#58b6e8',
  stale: '#e8697d',
};

const SANS = 'Helvetica';
const MONO = 'Menlo';

export const ease = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
export const clamp01 = t => Math.max(0, Math.min(1, t));
/** Progress of a sub-interval of a step, for staging several beats in one step. */
export const phase = (t, from, to) => clamp01((t - from) / (to - from));

export function createSurface() {
  const canvas = createCanvas(W * SCALE, H * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'middle';
  return { canvas, ctx };
}

export function font(ctx, size, { bold = false, mono = false } = {}) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${mono ? MONO : SANS}`;
}

export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function fillRound(ctx, x, y, w, h, r, fill, stroke, lineWidth = 1) {
  roundRect(ctx, x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

export function text(ctx, str, x, y, { size = 12, color = C.text, align = 'left', bold = false, mono = false, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  font(ctx, size, { bold, mono });
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(str, x, y);
  ctx.restore();
}

/** A small rounded label, used for hashes and counters. */
export function chip(ctx, str, x, y, { color = C.dim, bg = '#10151c', size = 10, align = 'left', mono = true, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  font(ctx, size, { mono });
  const w = ctx.measureText(str).width + 12;
  const h = size + 9;
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  fillRound(ctx, left, y - h / 2, w, h, 4, bg, color, 1);
  text(ctx, str, left + 6, y + 0.5, { size, color, mono });
  ctx.restore();
  return { w, h };
}

export function line(ctx, x1, y1, x2, y2, { color = C.idle, width = 1.2, alpha = 1, dash = null } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

export function arrow(ctx, x1, y1, x2, y2, { color = C.dim, width = 1.6, head = 6, alpha = 1, dash = null } = {}) {
  line(ctx, x1, y1, x2, y2, { color, width, alpha, dash });
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(a - 0.4), y2 - head * Math.sin(a - 0.4));
  ctx.lineTo(x2 - head * Math.cos(a + 0.4), y2 - head * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ─── Tree layout ──────────────────────────────────────────────────────────────

/**
 * Lay out a three-level tree inside `box` from a list of leaf-group sizes.
 *
 * `groups` of [3, 3, 3] gives a root over three internal nodes, each over three
 * leaves. Returns nodes keyed by id ('root', 'i0', 'l0-1') with positions.
 */
export function layoutTree(box, groups, { nodeW = 26, nodeH = 15, leafW = null } = {}) {
  const nodes = new Map();
  const edges = [];
  const leafCount = groups.reduce((a, b) => a + b, 0);
  const lw = leafW ?? Math.min(nodeW, (box.w - 6 * (leafCount - 1)) / leafCount);
  const rowY = [box.y, box.y + box.h / 2, box.y + box.h];

  const gap = leafCount > 1 ? (box.w - lw * leafCount) / (leafCount - 1) : 0;
  let index = 0;
  groups.forEach((size, g) => {
    const leafIds = [];
    for (let i = 0; i < size; i++) {
      const id = `l${g}-${i}`;
      const x = box.x + index * (lw + gap);
      nodes.set(id, { id, kind: 'leaf', x, y: rowY[2], w: lw, h: nodeH, cx: x + lw / 2 });
      leafIds.push(id);
      index++;
    }
    const first = nodes.get(leafIds[0]);
    const last = nodes.get(leafIds[leafIds.length - 1]);
    const cx = (first.cx + last.cx) / 2;
    const id = `i${g}`;
    nodes.set(id, { id, kind: 'internal', x: cx - nodeW / 2, y: rowY[1], w: nodeW, h: nodeH, cx });
    for (const leaf of leafIds) edges.push([id, leaf]);
  });

  const internals = groups.map((_, g) => nodes.get(`i${g}`));
  const rootCx = (internals[0].cx + internals[internals.length - 1].cx) / 2;
  nodes.set('root', {
    id: 'root', kind: 'root', x: rootCx - nodeW / 2, y: rowY[0], w: nodeW, h: nodeH, cx: rootCx,
  });
  for (const node of internals) edges.push(['root', node.id]);

  return { nodes, edges, box };
}

/**
 * Draw a laid-out tree. `state(id)` returns `{ color, fill, alpha, glow }` per
 * node; edges inherit the dimmer of their two endpoints.
 */
export function drawTree(ctx, tree, state = () => ({})) {
  for (const [from, to] of tree.edges) {
    const a = tree.nodes.get(from);
    const b = tree.nodes.get(to);
    const sa = state(from) ?? {};
    const sb = state(to) ?? {};
    const lit = sa.color && sa.color === sb.color ? sa.color : null;
    line(ctx, a.cx, a.y + a.h, b.cx, b.y, {
      color: lit ?? C.idle,
      alpha: Math.min(sa.alpha ?? 1, sb.alpha ?? 1) * (lit ? 0.9 : 0.5),
      width: lit ? 1.5 : 1.1,
    });
  }

  for (const node of tree.nodes.values()) {
    const s = state(node.id) ?? {};
    if ((s.alpha ?? 1) <= 0.01) continue;
    ctx.save();
    ctx.globalAlpha = s.alpha ?? 1;
    if (s.glow) {
      ctx.shadowColor = s.color ?? C.changed;
      ctx.shadowBlur = 10 * s.glow;
    }
    fillRound(
      ctx, node.x, node.y, node.w, node.h, 3.5,
      s.fill ?? C.panel, s.color ?? C.idle, s.color ? 1.5 : 1
    );
    ctx.restore();
  }
}

/** Every node id on the path from the root down to a leaf. */
export function pathToLeaf(leafId) {
  const group = leafId.slice(1).split('-')[0];
  return ['root', `i${group}`, leafId];
}

// ─── Chrome ───────────────────────────────────────────────────────────────────

export function drawFrame(ctx, { title, caption, captionColor = C.dim }) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  text(ctx, title, 24, 28, { size: 15, bold: true, color: C.text });
  line(ctx, 24, 46, W - 24, 46, { color: C.panelEdge, alpha: 0.8 });

  if (caption) {
    text(ctx, caption, 24, H - 24, { size: 12.5, color: captionColor });
  }
}

/** A centred note in the band between the panels and the caption. */
export function statusLine(ctx, str, { color = C.faint, y = H - 62, size = 10.5 } = {}) {
  if (!str) return;
  text(ctx, str, W / 2, y, { size, color, align: 'center' });
}

export function panel(ctx, { x, y, w, h, label, sublabel }) {
  fillRound(ctx, x, y, w, h, 7, '#131920', C.panelEdge, 1);
  if (label) text(ctx, label, x + 14, y + 20, { size: 12, bold: true, color: C.text });
  if (sublabel) text(ctx, sublabel, x + w - 14, y + 20, { size: 10.5, color: C.faint, align: 'right' });
}

// ─── Timeline → GIF ───────────────────────────────────────────────────────────

/**
 * Render `steps` to an animated GIF.
 *
 * Each step is `{ seconds, caption, draw(ctx, t, helpers) }` where `t` runs 0→1.
 * A two-pass ffmpeg palette gives flat colours without dithering noise.
 */
export async function renderGif({ name, title, steps, outDir, tmpRoot }) {
  const frameDir = join(tmpRoot, name);
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const { canvas, ctx } = createSurface();
  let frameIndex = 0;

  for (const step of steps) {
    const frames = Math.max(1, Math.round(step.seconds * FPS));
    for (let f = 0; f < frames; f++) {
      const t = frames === 1 ? 1 : f / (frames - 1);
      drawFrame(ctx, { title, caption: typeof step.caption === 'function' ? step.caption(t) : step.caption });
      step.draw(ctx, t);
      writeFileSync(
        join(frameDir, `f${String(frameIndex++).padStart(5, '0')}.png`),
        canvas.toBuffer('image/png')
      );
    }
  }

  const pattern = join(frameDir, 'f%05d.png');
  const palette = join(frameDir, 'palette.png');
  const out = join(outDir, `${name}.gif`);

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', pattern,
    '-vf', `scale=${W}:-1:flags=lanczos,palettegen=max_colors=96:stats_mode=full`,
    palette,
  ]);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', pattern,
    '-i', palette,
    '-lavfi', `scale=${W}:-1:flags=lanczos[s];[s][1:v]paletteuse=dither=none`,
    '-loop', '0',
    out,
  ]);

  rmSync(frameDir, { recursive: true, force: true });
  return { out, frames: frameIndex };
}
