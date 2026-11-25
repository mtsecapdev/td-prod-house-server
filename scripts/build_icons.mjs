// Builds the icon images used on slides (shared/icons/<name>.png): white Lucide icons on a transparent
// background, drawn on an accent-coloured circle, so one set serves every colour theme. The list and each
// icon's meaning live in shared/slides/spec.js (ICONS). The PNGs are committed: generating a deck never fetches
// or draws icons, which suits an air-gapped server.
//
// Run after changing ICONS (only missing images are drawn):
//   node scripts/build_icons.mjs <lucide-react package dir> <chrome-headless-shell binary>
// e.g. node scripts/build_icons.mjs ../td-prod-house-client/node_modules/lucide-react \
//        ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ICON_NAMES } from '../shared/slides/spec.js';

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
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'icons');
  mkdirSync(out, { recursive: true });
  // Images of icons no longer in the list go.
  for (const f of readdirSync(out)) if (!ICON_NAMES.includes(f.replace(/\.png$/, ''))) rmSync(join(out, f));
  for (const name of ICON_NAMES) {
    if (existsSync(join(out, `${name}.png`))) continue;
    const mod = await import(pathToFileURL(join(lucideDir, 'dist', 'esm', 'icons', `${name}.mjs`)).href);
    const html = `<html><body style="margin:0;background:transparent">${svgOf(mod.__iconNode)}</body></html>`;
    const page = join(out, `.${name}.html`);
    writeFileSync(page, html);
    execFileSync(chrome, [
      '--headless', '--no-sandbox', '--hide-scrollbars', '--default-background-color=00000000',
      `--window-size=${SIZE},${SIZE}`, `--screenshot=${join(out, `${name}.png`)}`, pathToFileURL(page).href,
    ], { stdio: 'ignore' });
    rmSync(page);
  }
  console.log(`${ICON_NAMES.length} icons in ${out}`);
}
