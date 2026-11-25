// Builds the icon images used on slides (scripts/icons/<name>.png): white Lucide icons on a transparent
// background, drawn on an accent-coloured circle by render_pptx.py, so one set serves every colour theme.
// The PNGs are committed: generating a deck never fetches or draws icons, which suits an air-gapped server.
//
// Run once after changing ICONS:
//   node scripts/build_icons.mjs <lucide-react package dir> <chrome-headless-shell binary>
// e.g. node scripts/build_icons.mjs ../td-prod-house-client/node_modules/lucide-react \
//        ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The icons the writer may choose from (also the enum in slideSchemas.js ICON_NAMES).
export const ICONS = [
  'activity', 'atom', 'award', 'battery', 'bolt', 'book-open', 'boxes', 'briefcase', 'building-2', 'cable',
  'calendar', 'car', 'chart-column', 'chart-pie', 'check', 'circle-check', 'circuit-board', 'clipboard-check',
  'clock', 'cloud', 'cog', 'coins', 'compass', 'construction', 'cpu', 'crosshair', 'dollar-sign', 'drill',
  'droplet', 'eye', 'factory', 'fan', 'file-text', 'flag', 'flame', 'flask-conical', 'fuel', 'gauge',
  'git-compare', 'globe', 'graduation-cap', 'hammer', 'handshake', 'hard-hat', 'heart-pulse', 'key', 'layers',
  'leaf', 'lightbulb', 'list-checks', 'lock', 'mail', 'map-pin', 'message-square', 'microscope', 'network',
  'package', 'percent', 'plane', 'plug', 'recycle', 'refresh-cw', 'rocket', 'route', 'ruler', 'scale', 'search',
  'server', 'settings', 'shield', 'shield-check', 'ship', 'star', 'sun', 'target', 'thermometer', 'timer',
  'tool-case', 'tractor', 'trending-down', 'trending-up', 'triangle-alert', 'truck', 'user', 'user-check',
  'users', 'wallet', 'warehouse', 'wind', 'workflow', 'wrench', 'zap',
];

const SIZE = 192; // px: sharp at the 0.4-0.6 in the icons are drawn at

function svgOf(node) {
  const children = node.map(([tag, attrs]) => {
    const a = Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<${tag} ${a}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [lucideDir, chrome] = process.argv.slice(2);
  if (!lucideDir || !chrome) {
    console.error('Usage: node scripts/build_icons.mjs <lucide-react dir> <chrome-headless-shell binary>');
    process.exit(1);
  }
  const out = join(dirname(fileURLToPath(import.meta.url)), 'icons');
  mkdirSync(out, { recursive: true });
  for (const name of ICONS) {
    const mod = await import(pathToFileURL(join(lucideDir, 'dist', 'esm', 'icons', `${name}.mjs`)).href);
    const html = `<html><body style="margin:0;background:transparent">${svgOf(mod.__iconNode)}</body></html>`;
    const page = join(out, `.${name}.html`);
    writeFileSync(page, html);
    execFileSync(chrome, [
      '--headless', '--no-sandbox', '--hide-scrollbars', '--default-background-color=00000000',
      `--window-size=${SIZE},${SIZE}`, `--screenshot=${join(out, `${name}.png`)}`, pathToFileURL(page).href,
    ], { stdio: 'ignore' });
    execFileSync('rm', ['-f', page]);
  }
  console.log(`${ICONS.length} icons written to ${out}`);
}
