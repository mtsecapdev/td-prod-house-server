// The layout engine: where everything goes on a slide. layoutSlide() turns a slide's content into a list of
// boxes (shapes, texts, icons, a table, picture areas) in inches on a 13.333 x 7.5 in slide. It is the only
// place design decisions are made: the PowerPoint renderer (scripts/render_pptx.py) and the editor's preview
// (td-prod-house-client, served this file at /api/shared/slides/layout.js) only draw the boxes they are given,
// so the download and the preview match by construction.
//
// The writer fills a kind's fields (spec.js); this file picks the arrangement from what was actually written:
// one point reads as a statement, two or three as cards, more as a list; a slide with a picture keeps its text
// in the left column and the picture gets a panel on the right.
//
// Box types (every box has x, y, w, h in inches unless noted):
//   rect   fill (a colour, or 'none' with an outline colour), radius (in), alpha (0-1); editOnly: shown only in
//          the editor (an outline to type an optional text into), never drawn in the download
//   oval   fill, alpha
//   line   x1, y1, x2, y2, color, weight (pt)
//   text   text, size (pt), bold, italic, color, font ('heading'|'body'|'quote'), align ('l'|'c'|'r'),
//          anchor ('t'|'m'|'b'), lh (line height, multiple of size), caps; path (where it lives in the content,
//          for editing; absent for fixed labels), placeholder, prefix (fixed text shown before it, e.g. "— ")
//   icon   an accent circle holding the icon `name`, or without one the point's `number`; path (the entry's
//          icon, for editing)
//   table  columns, rows, colW [in], rowH [in], size; path ['columns'] / ['rows']
//   image  role 'diagram': the diagram picture's area
// Colours are names the renderers map to the template: primary, accent, accent_light, text, text_light,
// border, canvas, surface, white, on_dark (light text on the primary colour), accent_tint (a light wash of the
// accent), quote_mark.
import { KINDS, ICONS } from './spec.js';

export const W = 13.333;
export const H = 7.5;

// ── Grid ──
const M = 0.75;              // side margins
const ACCENT_Y = 0.62;       // the short accent bar over the title
const TITLE_Y = 0.78;
const TITLE_H = 1.05;
const BODY_TOP = 2.05;
const BODY_BOTTOM = 6.75;
const BODY_H = BODY_BOTTOM - BODY_TOP;
const PANEL_X = 7.55;        // the picture panel on the right
const PANEL_PAD = 0.45;
const CAPTION_H = 0.55;
const FULL_W = W - 2 * M;
const COLUMN_W = PANEL_X - M - 0.45;
const GAP = 0.35;

// Where a picture goes before the user moves it, as fractions of the slide [x, y, w, h]: the panel on the right
// (caption under it), or for a Figure slide the band under the title.
export const SIDE_BOX = [(PANEL_X + PANEL_PAD) / W, PANEL_PAD / H, (W - PANEL_X - 2 * PANEL_PAD) / W, (H - 2 * PANEL_PAD - CAPTION_H) / H];
export const FIGURE_BOX = [M / W, (BODY_TOP - 0.05) / H, FULL_W / W, (H - BODY_TOP - 0.05 - CAPTION_H - 0.35) / H];
export const CAPTION_PT = 11;

/** Where picture `index` of a slide goes before the user moves it: a Figure slide's own figure in the band, others in the panel. */
export const pictureBoxFor = (kind, index) => (kind === 'figure' && index === 0 ? FIGURE_BOX : SIDE_BOX);

// ── Text measure ──
// Estimates, shared by both renderers: an average glyph is about half the font size wide (a little more in bold).

export function lineCount(text, w, size, bold = false) {
  const perLine = Math.max(1, Math.floor((w * 72) / (size * (bold ? 0.55 : 0.5))));
  return String(text || ' ').split('\n').reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perLine)), 0);
}

export function textHeight(text, w, size, lh, bold = false) {
  return (lineCount(text, w, size, bold) * size * lh) / 72;
}

/** The largest size (down to min x size) at which text fits w x h. */
function fit(text, w, h, size, lh, bold = false, min = 0.6) {
  let s = size;
  while (s > size * min && textHeight(text, w, s, lh, bold) > h) s -= 1;
  return s;
}

const two = (n) => String(n).padStart(2, '0');
const hasIcon = (name) => Boolean(name && ICONS[name]);

// ── Builder ──

function makeSlide() {
  const boxes = [];
  const controls = [];
  const add = (box) => { boxes.push(box); return box; };
  const text = (o) => add({
    type: 'text', align: 'l', anchor: 't', font: 'body', color: 'text', lh: 1.25, bold: false, italic: false, ...o,
  });
  return { boxes, controls, add, text };
}

/**
 * The gap between `count` stacked entries whose heights add up to `used`: at least `min`, more when there is room,
 * so a short list spreads over the body instead of huddling in its middle.
 */
const spacing = (used, count, min) => (count < 2 ? 0 : Math.min(0.65, Math.max(min, (BODY_H * 0.8 - used) / (count - 1))));

/** Where a block `h` tall starts so it sits a little above the middle of the body. */
const bodyTop = (h, top = BODY_TOP, bottom = BODY_BOTTOM) => top + Math.max(0, (bottom - top - h) * 0.4);

function titleBlock(s, title, width) {
  s.add({ type: 'rect', x: M, y: ACCENT_Y, w: 0.55, h: 0.06, fill: 'accent' });
  const size = fit(title, width, TITLE_H, 30, 1.1, true);
  s.text({ x: M, y: TITLE_Y, w: width, h: TITLE_H, text: title, size, bold: true, font: 'heading', color: 'primary', lh: 1.1, path: ['title'], placeholder: 'Slide title' });
}

function slideNumber(s, number, dark = false) {
  if (!number) return;
  s.text({ x: W - 1.45, y: H - 0.55, w: 0.9, h: 0.3, text: two(number), size: 10, color: dark ? 'accent_light' : 'text_light', align: 'r' });
}

/** A point's marker: an accent circle with its icon, or its number when it has none. */
function marker(s, icon, number, x, y, size, path) {
  s.add({ type: 'icon', x, y, w: size, h: size, name: hasIcon(icon) ? icon : '', number, fill: 'accent', path });
}

function darkBackground(s) {
  s.add({ type: 'oval', x: W - 5.2, y: -2.4, w: 8, h: 8, fill: 'accent', alpha: 0.18 });
  s.add({ type: 'oval', x: W - 2.6, y: 3.9, w: 5, h: 5, fill: 'accent_light', alpha: 0.1 });
}

// ══════════════════════════════════════════════
//  KINDS
// ══════════════════════════════════════════════

function titleSlide(s, c, { titleSize = 46, label } = {}) {
  darkBackground(s);
  const size = fit(c.title, 8.6, 2.4, titleSize, 1.05, true);
  const titleH = textHeight(c.title, 8.6, size, 1.05, true);
  const top = 4.6 - titleH;
  s.add({ type: 'rect', x: M + 0.02, y: top - 0.38, w: 0.7, h: 0.08, fill: 'accent_light' });
  s.text({ x: M, y: top, w: 8.6, h: titleH + 0.1, text: c.title, size, bold: true, font: 'heading', color: 'white', lh: 1.05, path: ['title'], placeholder: label });
  s.text({ x: M, y: 4.85, w: 7.8, h: 1.3, text: c.subtitle, size: fit(c.subtitle, 7.8, 1.3, 20, 1.3), color: 'on_dark', lh: 1.3, path: ['subtitle'], placeholder: 'Subtitle' });
}

function closingSlide(s, c) {
  darkBackground(s);
  s.text({ x: M, y: 0.75, w: 6, h: 0.3, text: 'KEY TAKEAWAYS', size: 13, bold: true, color: 'accent_light' });
  s.text({ x: M, y: 1.12, w: 10, h: 0.9, text: c.title, size: fit(c.title, 10, 0.9, 34, 1.1, true), bold: true, font: 'heading', color: 'white', lh: 1.1, path: ['title'], placeholder: 'Key takeaways' });
  const takeaways = c.takeaways || [];
  const cta = String(c.call_to_action || '').trim();
  const bottom = cta ? 5.55 : 6.6;
  const textW = 9.2;
  let size = 19;
  const needed = (sz) => takeaways.reduce((h, t) => h + Math.max(0.42, textHeight(t, textW, sz, 1.3)) + 0.3, 0);
  while (size > 14 && needed(size) > bottom - 2.4) size -= 1;
  let y = 2.4;
  takeaways.forEach((t, i) => {
    const h = Math.max(0.42, textHeight(t, textW, size, 1.3));
    s.add({ type: 'icon', x: M, y: y + 0.02, w: 0.42, h: 0.42, name: 'check', fill: 'accent' });
    s.text({ x: M + 0.65, y: y + Math.max(0, (0.42 - (size * 1.3) / 72) / 2), w: textW, h, text: t, size, color: 'white', lh: 1.3, path: ['takeaways', i], placeholder: 'Takeaway' });
    s.controls.push({ path: ['takeaways'], index: i, count: takeaways.length, x: M, y, w: textW + 0.65, h });
    y += h + 0.3;
  });
  // An empty call to action is only an outline in the editor (editOnly boxes are not drawn in the download).
  s.add(cta ? { type: 'rect', x: M, y: 5.85, w: 9.8, h: 0.75, fill: 'accent', radius: 0.12 }
    : { type: 'rect', x: M, y: 5.85, w: 9.8, h: 0.75, fill: 'none', outline: 'on_dark', radius: 0.12, editOnly: true });
  s.text({ x: M + 0.3, y: 5.85, w: 9.2, h: 0.75, text: cta, size: fit(cta, 9.2, 0.75, 17, 1.2, true), bold: true, color: 'white', anchor: 'm', lh: 1.2, path: ['call_to_action'], placeholder: 'Call to action (optional)' });
}

// ── Points ──

function pointsSlide(s, c, width, panel) {
  const points = c.points || [];
  const n = points.length;
  if (!n) return;
  const entry = (i) => ({ path: ['points'], index: i, count: n, move: true });
  const heading = (p, i, x, y, w, size) => s.text({ x, y, w, h: textHeight(p.heading, w, size, 1.15, true), text: p.heading, size, bold: true, font: 'heading', color: 'primary', lh: 1.15, path: ['points', i, 'heading'], placeholder: 'Heading' });
  const detail = (p, i, x, y, w, size, h) => s.text({ x, y, w, h: h ?? textHeight(p.detail, w, size, 1.3), text: p.detail, size, lh: 1.3, path: ['points', i, 'detail'], placeholder: 'Detail' });

  if (n === 1) {
    // One point: a statement, large.
    const p = points[0];
    const tx = M + 1.25;
    const tw = width - 1.25;
    const hs = fit(p.heading, tw, 1.6, 30, 1.15, true);
    const ds = fit(p.detail, tw, 2.2, 21, 1.3);
    const hh = textHeight(p.heading, tw, hs, 1.15, true);
    const dh = textHeight(p.detail, tw, ds, 1.3);
    const top = bodyTop(Math.max(0.95, hh + 0.2 + dh));
    marker(s, p.icon, 1, M, top + 0.02, 0.95, ['points', 0, 'icon']);
    heading(p, 0, tx, top, tw, hs);
    detail(p, 0, tx, top + hh + 0.2, tw, ds, dh);
    s.controls.push({ ...entry(0), x: M, y: top, w: width, h: hh + 0.2 + dh });
    return;
  }

  if (!panel && n <= 3) {
    // Cards side by side: marker on top, heading, detail.
    const pad = 0.38;
    const mk = 0.62;
    const w = (width - GAP * (n - 1)) / n;
    const inner = w - 2 * pad;
    const hs = Math.min(...points.map((p) => fit(p.heading, inner, 0.95, 22, 1.15, true)));
    const ds = Math.min(...points.map((p) => fit(p.detail, inner, 1.9, 17, 1.3)));
    const hh = Math.max(...points.map((p) => textHeight(p.heading, inner, hs, 1.15, true)));
    const dh = Math.max(...points.map((p) => textHeight(p.detail, inner, ds, 1.3)));
    const h = 2 * pad + mk + 0.28 + hh + 0.12 + dh;
    const top = bodyTop(h);
    points.forEach((p, i) => {
      const x = M + i * (w + GAP);
      s.add({ type: 'rect', x, y: top, w, h, fill: 'canvas', radius: 0.1 });
      marker(s, p.icon, i + 1, x + pad, top + pad, mk, ['points', i, 'icon']);
      heading(p, i, x + pad, top + pad + mk + 0.28, inner, hs);
      detail(p, i, x + pad, top + pad + mk + 0.28 + hh + 0.12, inner, ds, dh);
      s.controls.push({ ...entry(i), x, y: top, w, h });
    });
    return;
  }

  if (!panel && n === 4) {
    // Two by two cards, each a row: marker left, text beside it.
    const w = (width - GAP) / 2;
    const padX = 0.35;
    const padY = 0.34;
    const mk = 0.6;
    const tw = w - 2 * padX - mk - 0.25;
    const hs = Math.min(...points.map((p) => fit(p.heading, tw, 0.7, 20, 1.15, true)));
    const ds = Math.min(...points.map((p) => fit(p.detail, tw, 1.1, 15, 1.3)));
    const rowH = (row) => Math.max(mk, ...row.map((p) => textHeight(p.heading, tw, hs, 1.15, true) + 0.08 + textHeight(p.detail, tw, ds, 1.3)));
    const h = Math.max(rowH(points.slice(0, 2)), rowH(points.slice(2))) + 2 * padY;
    const top = bodyTop(2 * h + GAP);
    points.forEach((p, i) => {
      const x = M + (i % 2) * (w + GAP);
      const y = top + Math.floor(i / 2) * (h + GAP);
      s.add({ type: 'rect', x, y, w, h, fill: 'canvas', radius: 0.1 });
      marker(s, p.icon, i + 1, x + padX, y + padY, mk, ['points', i, 'icon']);
      const tx = x + padX + mk + 0.25;
      const hh = textHeight(p.heading, tw, hs, 1.15, true);
      heading(p, i, tx, y + padY - 0.02, tw, hs);
      detail(p, i, tx, y + padY + hh + 0.06, tw, ds);
      s.controls.push({ ...entry(i), x, y, w, h });
    });
    return;
  }

  // A list: beside a picture, or more points than cards hold.
  const cols = !panel && n >= 5 ? 2 : 1;
  const colW = (width - 0.5 * (cols - 1)) / cols;
  const dense = n >= 5;
  const mk = dense ? 0.46 : 0.52;
  const tw = colW - mk - 0.25;
  const rows = Math.ceil(n / cols);
  let hs = dense ? 17 : 20;
  let ds = dense ? 14 : 16;
  const rowHeights = () => Array.from({ length: rows }, (_, r) => Math.max(mk, ...points.slice(r * cols, r * cols + cols)
    .map((p) => textHeight(p.heading, tw, hs, 1.15, true) + 0.06 + textHeight(p.detail, tw, ds, 1.3))));
  let heights = rowHeights();
  const sum = () => heights.reduce((a, b) => a + b, 0);
  while (sum() + 0.2 * (rows - 1) > BODY_H && ds > 11) { hs -= 1; ds -= 1; heights = rowHeights(); }
  const gap = spacing(sum(), rows, dense ? 0.24 : 0.34);
  let y = bodyTop(sum() + gap * (rows - 1));
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const i = r * cols + k;
      if (i >= n) break;
      const p = points[i];
      const x = M + k * (colW + 0.5);
      marker(s, p.icon, i + 1, x, y, mk, ['points', i, 'icon']);
      const hh = textHeight(p.heading, tw, hs, 1.15, true);
      heading(p, i, x + mk + 0.25, y - 0.02, tw, hs);
      detail(p, i, x + mk + 0.25, y + hh + 0.04, tw, ds);
      s.controls.push({ ...entry(i), x, y, w: colW, h: heights[r] });
    }
    y += heights[r] + gap;
  }
}

// ── Steps ──

function stepsSlide(s, c, width, panel) {
  const steps = c.steps || [];
  const n = steps.length;
  if (!n) return;
  const dated = steps.filter((st) => String(st.when || '').trim()).length >= Math.ceil(n / 2);
  const entry = (i) => ({ path: ['steps'], index: i, count: n, move: true });
  const label = (st, i, x, y, w, size, align = 'l') => s.text({ x, y, w, h: textHeight(st.label, w, size, 1.15, true), text: st.label, size, bold: true, font: 'heading', color: 'primary', lh: 1.15, align, path: ['steps', i, 'label'], placeholder: 'Step' });
  const detail = (st, i, x, y, w, size, align = 'l') => s.text({ x, y, w, h: textHeight(st.detail, w, size, 1.3), text: st.detail, size, lh: 1.3, align, path: ['steps', i, 'detail'], placeholder: 'Detail' });

  if (!panel && n <= (dated ? 6 : 5)) {
    const colW = width / n;
    const inner = colW - 0.3;
    const ls = n > 4 ? 16 : 18;
    const ds = n > 4 ? 13 : 14;
    const lh = Math.max(...steps.map((st) => textHeight(st.label, inner, ls, 1.15, true)));
    const dh = Math.max(...steps.map((st) => textHeight(st.detail, inner, ds, 1.3)));
    if (dated) {
      // A timeline: dates above the line, a dot on it, the event below.
      const block = 0.55 + 0.25 + 0.3 + lh + 0.1 + dh;
      const lineY = bodyTop(block) + 0.75;
      s.add({ type: 'line', x1: M, y1: lineY, x2: M + width, y2: lineY, color: 'border', weight: 2.5 });
      steps.forEach((st, i) => {
        const x = M + i * colW + 0.15;
        s.text({ x, y: lineY - 0.68, w: inner, h: 0.45, text: st.when, size: 17, bold: true, font: 'heading', color: 'accent', align: 'c', anchor: 'b', path: ['steps', i, 'when'], placeholder: 'Date' });
        s.add({ type: 'oval', x: x + inner / 2 - 0.14, y: lineY - 0.14, w: 0.28, h: 0.28, fill: 'accent' });
        label(st, i, x, lineY + 0.35, inner, ls, 'c');
        detail(st, i, x, lineY + 0.35 + lh + 0.1, inner, ds, 'c');
        s.controls.push({ ...entry(i), x: x - 0.1, y: lineY - 0.7, w: inner + 0.2, h: 1.05 + lh + 0.1 + dh });
      });
      return;
    }
    // A flow: numbered circles joined by a line, each step under its circle.
    const circle = 0.72;
    const block = circle + 0.3 + lh + 0.1 + dh;
    const top = bodyTop(block);
    s.add({ type: 'line', x1: M + colW / 2, y1: top + circle / 2, x2: M + colW * (n - 0.5), y2: top + circle / 2, color: 'border', weight: 2.5 });
    steps.forEach((st, i) => {
      const cx = M + colW * i + colW / 2;
      s.add({ type: 'oval', x: cx - circle / 2, y: top, w: circle, h: circle, fill: 'accent' });
      s.text({ x: cx - circle / 2, y: top, w: circle, h: circle, text: String(i + 1), size: 20, bold: true, font: 'heading', color: 'white', align: 'c', anchor: 'm', lh: 1 });
      label(st, i, cx - inner / 2, top + circle + 0.3, inner, ls, 'c');
      detail(st, i, cx - inner / 2, top + circle + 0.3 + lh + 0.1, inner, ds, 'c');
      s.controls.push({ ...entry(i), x: cx - colW / 2 + 0.05, y: top, w: colW - 0.1, h: block });
    });
    return;
  }

  // A numbered list down the slide, a thin line joining the numbers.
  const cols = !panel && n >= 6 ? 2 : 1;
  const colW = (width - 0.6 * (cols - 1)) / cols;
  const rows = Math.ceil(n / cols);
  const circle = 0.46;
  const tw = colW - circle - 0.3;
  let ls = 19;
  let ds = 15;
  const height = (st) => (dated && st.when ? 0.3 : 0) + textHeight(st.label, tw, ls, 1.15, true) + 0.05 + textHeight(st.detail, tw, ds, 1.3);
  const colSum = (k) => steps.slice(k * rows, k * rows + rows).reduce((h, st) => h + Math.max(circle, height(st)), 0);
  const tallestSum = () => Math.max(...Array.from({ length: cols }, (_, k) => colSum(k)));
  while (tallestSum() + 0.2 * (rows - 1) > BODY_H && ds > 11) { ls -= 1; ds -= 1; }
  const gap = spacing(tallestSum(), rows, n >= 6 ? 0.22 : 0.32);
  const top = bodyTop(tallestSum() + gap * (rows - 1));
  for (let k = 0; k < cols; k++) {
    const x = M + k * (colW + 0.6);
    const col = steps.slice(k * rows, k * rows + rows);
    let y = top;
    const centres = [];
    col.forEach((st, j) => {
      const i = k * rows + j;
      const h = Math.max(circle, height(st));
      centres.push(y + circle / 2);
      let ty = y - 0.02;
      if (dated && st.when) {
        s.text({ x: x + circle + 0.3, y: ty, w: tw, h: 0.28, text: st.when, size: 12, bold: true, color: 'accent', caps: true, path: ['steps', i, 'when'], placeholder: 'Date' });
        ty += 0.3;
      }
      const lh = textHeight(st.label, tw, ls, 1.15, true);
      label(st, i, x + circle + 0.3, ty, tw, ls);
      detail(st, i, x + circle + 0.3, ty + lh + 0.05, tw, ds);
      s.controls.push({ ...entry(i), x, y, w: colW, h });
      y += h + gap;
    });
    if (centres.length > 1) s.add({ type: 'line', x1: x + circle / 2, y1: centres[0], x2: x + circle / 2, y2: centres[centres.length - 1], color: 'border', weight: 2 });
    col.forEach((_, j) => {
      s.add({ type: 'oval', x, y: centres[j] - circle / 2, w: circle, h: circle, fill: 'accent' });
      s.text({ x, y: centres[j] - circle / 2, w: circle, h: circle, text: String(k * rows + j + 1), size: 15, bold: true, font: 'heading', color: 'white', align: 'c', anchor: 'm', lh: 1 });
    });
  }
}

// ── Numbers ──

function numbersSlide(s, c, width, panel) {
  const numbers = c.numbers || [];
  const n = numbers.length;
  if (!n) return;
  const entry = (i) => ({ path: ['numbers'], index: i, count: n });
  if (n === 1) {
    const st = numbers[0];
    const vs = Math.min(panel ? 88 : 110, fit(st.value, width, 1.7, 110, 1, true, 0.4));
    const ls = fit(st.label, width, 0.9, 26, 1.15, true);
    const lh = textHeight(st.label, width, ls, 1.15, true);
    const dw = Math.min(width, 8.5);
    const dh = textHeight(st.detail, dw, 18, 1.35);
    const vh = (vs * 1.05) / 72;
    const top = bodyTop(vh + 0.25 + lh + 0.15 + dh);
    s.text({ x: M, y: top, w: width, h: vh, text: st.value, size: vs, bold: true, font: 'heading', color: 'accent', lh: 1.05, path: ['numbers', 0, 'value'], placeholder: '0' });
    s.add({ type: 'rect', x: M, y: top + vh + 0.08, w: 0.55, h: 0.05, fill: 'accent' });
    s.text({ x: M, y: top + vh + 0.25, w: width, h: lh, text: st.label, size: ls, bold: true, font: 'heading', color: 'primary', lh: 1.15, path: ['numbers', 0, 'label'], placeholder: 'What it measures' });
    s.text({ x: M, y: top + vh + 0.25 + lh + 0.15, w: dw, h: dh, text: st.detail, size: 18, lh: 1.35, path: ['numbers', 0, 'detail'], placeholder: 'Why it matters' });
    s.controls.push({ ...entry(0), x: M, y: top, w: width, h: vh + 0.4 + lh + dh });
    return;
  }
  const cols = n <= 3 || !panel ? n : 2;
  const rows = Math.ceil(n / cols);
  const w = (width - GAP * (cols - 1)) / cols;
  const pad = 0.35;
  const inner = w - 2 * pad;
  const vs = Math.min(rows > 1 ? 34 : 44, ...numbers.map((st) => fit(st.value, inner, 0.75, 44, 1, true, 0.5)));
  const ls = 16;
  const ds = 13;
  const cardH = Math.max(...numbers.map((st) => 0.12 + (vs * 1.05) / 72 + 0.15 + textHeight(st.label, inner, ls, 1.15, true) + 0.08 + textHeight(st.detail, inner, ds, 1.3))) + 2 * pad;
  const top = bodyTop(rows * cardH + GAP * (rows - 1));
  numbers.forEach((st, i) => {
    const x = M + (i % cols) * (w + GAP);
    const y = top + Math.floor(i / cols) * (cardH + GAP);
    s.add({ type: 'rect', x, y, w, h: cardH, fill: 'canvas', radius: 0.1 });
    s.add({ type: 'rect', x: x + pad, y: y + pad, w: 0.45, h: 0.05, fill: 'accent' });
    const vy = y + pad + 0.12;
    const vh = (vs * 1.05) / 72;
    s.text({ x: x + pad, y: vy, w: inner, h: vh, text: st.value, size: vs, bold: true, font: 'heading', color: 'accent', lh: 1.05, path: ['numbers', i, 'value'], placeholder: '0' });
    const lh = textHeight(st.label, inner, ls, 1.15, true);
    s.text({ x: x + pad, y: vy + vh + 0.15, w: inner, h: lh, text: st.label, size: ls, bold: true, font: 'heading', color: 'primary', lh: 1.15, path: ['numbers', i, 'label'], placeholder: 'What it measures' });
    s.text({ x: x + pad, y: vy + vh + 0.15 + lh + 0.08, w: inner, h: textHeight(st.detail, inner, ds, 1.3), text: st.detail, size: ds, lh: 1.3, path: ['numbers', i, 'detail'], placeholder: 'Why it matters' });
    s.controls.push({ ...entry(i), x, y, w, h: cardH });
  });
}

// ── Statement ──

function statementSlide(s, c, width, panel, number) {
  const quoted = Boolean(String(c.attribution || '').trim());
  slideNumber(s, number);
  if (quoted) {
    titleBlock(s, c.title, width);
    s.text({ x: M - 0.08, y: BODY_TOP - 0.35, w: 1.4, h: 1.3, text: '“', size: 120, bold: true, font: 'quote', color: 'quote_mark', lh: 1 });
    const qw = width - 0.2;
    const qs = fit(c.statement, qw, 2.3, 28, 1.3);
    const qh = textHeight(c.statement, qw, qs, 1.3);
    const y = BODY_TOP + 0.6;
    s.text({ x: M + 0.2, y, w: qw, h: qh, text: c.statement, size: qs, italic: true, font: 'heading', color: 'primary', lh: 1.3, path: ['statement'], placeholder: 'The quote' });
    s.text({ x: M + 0.2, y: y + qh + 0.25, w: qw, h: 0.4, text: c.attribution, prefix: '— ', size: 16, bold: true, color: 'accent', path: ['attribution'], placeholder: 'Who said it' });
    s.text({ x: M + 0.2, y: y + qh + 0.8, w: Math.min(qw, 9), h: textHeight(c.supporting, Math.min(qw, 9), 15, 1.35), text: c.supporting, size: 15, lh: 1.35, path: ['supporting'], placeholder: 'Why it matters' });
    return;
  }
  // One message: a kicker, the statement large beside an accent bar, then its support.
  const x = M + 0.45;
  const tw = width - 0.45;
  const ss = fit(c.statement, tw, 2.7, panel ? 32 : 38, 1.12, true);
  const sh = textHeight(c.statement, tw, ss, 1.12, true);
  const sw = Math.min(tw, 9.5);
  const ph = textHeight(c.supporting, sw, 19, 1.35);
  const block = 0.45 + sh + 0.35 + ph;
  const top = bodyTop(block, 0.9, 6.75);
  s.text({ x, y: top, w: tw, h: 0.32, text: c.title, size: 14, bold: true, color: 'accent', caps: true, path: ['title'], placeholder: 'Label' });
  s.add({ type: 'rect', x: M, y: top + 0.45, w: 0.1, h: sh, fill: 'accent' });
  s.text({ x, y: top + 0.45, w: tw, h: sh, text: c.statement, size: ss, bold: true, font: 'heading', color: 'primary', lh: 1.12, path: ['statement'], placeholder: 'One message to remember' });
  s.text({ x, y: top + 0.45 + sh + 0.35, w: sw, h: ph, text: c.supporting, size: 19, lh: 1.35, path: ['supporting'], placeholder: 'Supporting context' });
}

// ── Compare ──

function compareSlide(s, c, width, panel) {
  const sides = (c.sides || []).slice(0, 2);
  const verdict = String(c.verdict || '').trim();
  const stacked = panel;
  const w = stacked ? width : (width - 0.4) / 2;
  // Stacked beside a picture, the two sides are tighter so their text keeps its size.
  const pad = stacked ? 0.3 : 0.38;
  const inner = w - 2 * pad - 0.3;
  const hs = stacked ? 19 : 22;
  const under = stacked ? 0.36 : 0.42; // heading to first point, past the accent rule
  let ps = 17;
  const sideH = (side) => textHeight(side.heading, w - 2 * pad, hs, 1.15, true) + under
    + (side.points || []).reduce((h, p) => h + textHeight(p, inner, ps, 1.3) + 0.12, 0) + 2 * pad - 0.12;
  const verdictH = verdict ? 0.75 + 0.3 : 0; // an empty verdict's outline (editor only) takes no room
  const total = () => (stacked ? sides.reduce((h, sd) => h + sideH(sd) + 0.3, -0.3) : Math.max(...sides.map(sideH))) + verdictH;
  while (total() > BODY_H && ps > 13) ps -= 1;
  const cardH = stacked ? null : Math.max(...sides.map(sideH));
  let y = bodyTop(total());
  sides.forEach((side, k) => {
    const h = cardH ?? sideH(side);
    const x = stacked ? M : M + k * (w + 0.4);
    const cy = y;
    s.add({ type: 'rect', x, y: cy, w, h, fill: 'canvas', radius: 0.1 });
    const hh = textHeight(side.heading, w - 2 * pad, hs, 1.15, true);
    s.text({ x: x + pad, y: cy + pad, w: w - 2 * pad, h: hh, text: side.heading, size: hs, bold: true, font: 'heading', color: 'primary', lh: 1.15, path: ['sides', k, 'heading'], placeholder: k ? 'Second side' : 'First side' });
    s.add({ type: 'rect', x: x + pad, y: cy + pad + hh + under / 3, w: 0.45, h: 0.05, fill: 'accent' });
    let py = cy + pad + hh + under;
    (side.points || []).forEach((p, i) => {
      const ph = textHeight(p, inner, ps, 1.3);
      s.add({ type: 'oval', x: x + pad + 0.02, y: py + (ps * 1.3) / 72 / 2 - 0.05, w: 0.1, h: 0.1, fill: 'accent' });
      s.text({ x: x + pad + 0.3, y: py, w: inner, h: ph, text: p, size: ps, lh: 1.3, path: ['sides', k, 'points', i], placeholder: 'Point' });
      s.controls.push({ path: ['sides', k, 'points'], index: i, count: side.points.length, x: x + pad, y: py, w: w - 2 * pad, h: ph });
      py += ph + 0.12;
    });
    if (stacked) y += h + 0.3;
  });
  // The verdict strip; without a verdict, only an outline to type into in the editor.
  const vy = stacked ? y : y + cardH + 0.3;
  s.add(verdict ? { type: 'rect', x: M, y: vy, w: width, h: 0.75, fill: 'accent_tint', radius: 0.1 }
    : { type: 'rect', x: M, y: vy, w: width, h: 0.75, fill: 'none', outline: 'border', radius: 0.1, editOnly: true });
  s.text({ x: M + 0.3, y: vy, w: width - 0.6, h: 0.75, text: verdict, size: fit(verdict, width - 0.6, 0.75, 16, 1.2, true), bold: true, color: 'primary', anchor: 'm', lh: 1.2, path: ['verdict'], placeholder: 'One-line conclusion (optional)' });
}

// ── Table ──

function tableSlide(s, c, width) {
  const columns = c.columns || [];
  const rows = c.rows || [];
  if (!columns.length) return;
  const size = columns.length <= 3 ? 17 : columns.length === 4 ? 15 : 13;
  // Column widths follow how much each column holds; the first (naming each row) never too narrow.
  const weight = columns.map((col, k) => Math.min(40, Math.max(8, String(col).length,
    ...rows.map((r) => String(r[k] || '').length))));
  const sum = weight.reduce((a, b) => a + b, 0);
  const colW = weight.map((wt) => (width * wt) / sum);
  const cellPad = 0.3;
  const rowHeight = (cells, sz, bold) => Math.max(0.55, Math.max(...cells.map((t, k) => textHeight(t, colW[k] - cellPad, sz, 1.2, bold))) + 0.22);
  const rowH = [rowHeight(columns, size - 1, true), ...rows.map((r) => rowHeight(columns.map((_, k) => r[k] || ''), size, false))];
  const total = rowH.reduce((a, b) => a + b, 0);
  const scale = total > BODY_H ? BODY_H / total : 1;
  const heights = rowH.map((h) => h * scale);
  const top = bodyTop(Math.min(total, BODY_H));
  s.add({ type: 'table', x: M, y: top, w: width, h: Math.min(total, BODY_H), columns, rows, colW, rowH: heights, size: scale < 1 ? Math.max(11, Math.floor(size * scale)) : size });
  let y = top + heights[0];
  rows.forEach((_, i) => {
    s.controls.push({ path: ['rows'], index: i, count: rows.length, x: M, y, w: width, h: heights[i + 1], newRow: columns.length });
    y += heights[i + 1];
  });
}

// ── Diagram and figure ──

function diagramSlide(s, c) {
  const caption = String(c.caption || '').trim();
  const top = BODY_TOP - 0.1;
  const h = BODY_BOTTOM - top - (caption ? 0.5 : 0);
  s.add({ type: 'image', role: 'diagram', x: M, y: top, w: FULL_W, h });
  s.text({ x: M, y: top + h + 0.05, w: FULL_W, h: 0.4, text: c.caption, size: 13, align: 'c', path: ['caption'], placeholder: 'Caption (optional)' });
}

function figureSlide(s) {
  s.add({ type: 'rect', x: 0, y: BODY_TOP - 0.3, w: W, h: H - BODY_TOP + 0.3, fill: 'canvas' });
}

// ══════════════════════════════════════════════

/**
 * Lays out one slide. slide: { layout, content }; number: its position (1-based) for the slide number.
 * Returns { background, boxes, controls, pictureBoxes }: controls mark each list entry (path to the list, index)
 * for the editor's add / remove / move buttons; pictureBoxes are where its unmoved pictures go (fractions of the
 * slide, one per picture).
 */
export function layoutSlide(slide, number = 0) {
  const kind = slide?.layout;
  const c = slide?.content || {};
  const spec = KINDS[kind];
  const s = makeSlide();
  const panel = Boolean(spec?.picture && c.pictures?.length);
  const width = panel ? COLUMN_W : FULL_W;
  let background = 'surface';

  if (!spec) {
    s.text({ x: M, y: 3.2, w: FULL_W, h: 1, text: 'This slide was made by an earlier version of the app. Regenerate it to use the current design.', size: 18, align: 'c', color: 'text_light' });
    return { background, boxes: s.boxes, controls: [], pictureBoxes: (c.pictures || []).map(() => SIDE_BOX) };
  }
  if (panel) s.add({ type: 'rect', x: PANEL_X, y: 0, w: W - PANEL_X, h: H, fill: 'canvas' });

  switch (kind) {
    case 'title':
      background = 'primary';
      titleSlide(s, c, { label: 'Deck title' });
      break;
    case 'section':
      background = 'primary';
      titleSlide(s, c, { titleSize: 40, label: 'Section title' });
      slideNumber(s, number, true);
      break;
    case 'closing':
      background = 'primary';
      closingSlide(s, c);
      break;
    case 'statement':
      statementSlide(s, c, width, panel, number);
      break;
    default:
      if (kind === 'figure') figureSlide(s); // the band goes under the title
      titleBlock(s, c.title, width);
      slideNumber(s, number);
      if (kind === 'points') pointsSlide(s, c, width, panel);
      else if (kind === 'steps') stepsSlide(s, c, width, panel);
      else if (kind === 'numbers') numbersSlide(s, c, width, panel);
      else if (kind === 'compare') compareSlide(s, c, width, panel);
      else if (kind === 'table') tableSlide(s, c, width);
      else if (kind === 'diagram') diagramSlide(s, c);
  }
  return { background, boxes: s.boxes, controls: s.controls, pictureBoxes: (c.pictures || []).map((_, i) => pictureBoxFor(kind, i)) };
}
