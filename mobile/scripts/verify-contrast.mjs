/**
 * verify-contrast.mjs - WCAG 2.2 AA contrast gate for the mobile design tokens.
 *
 * Reads src/theme/variables.css, resolves var() chains and color-mix(), builds
 * the light theme (:root) and the dark theme (both the prefers-color-scheme
 * block and the [data-theme="dark"] block, which must agree), then checks every
 * text/background pair the app relies on. Exits non-zero on any failure.
 *
 * Run: npm run verify.contrast
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'theme', 'variables.css'), 'utf8')
  .replace(/\r/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/* ---- parse blocks -------------------------------------------------------- */
function declsOf(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
function blocksFor(selector) {
  const res = [];
  const re = new RegExp('(?:^|\\n)\\s*' + selector + '\\s*\\{([^{}]*)\\}', 'g');
  for (const m of css.matchAll(re)) res.push(declsOf(m[1]));
  return res;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const light = Object.assign({}, ...blocksFor(':root'));
const mediaDark = Object.assign({}, ...blocksFor(esc(':root:not([data-theme="light"])')));
const attrDark = Object.assign({}, ...blocksFor(esc(':root[data-theme="dark"]')));

/* ---- colour maths -------------------------------------------------------- */
const hex2rgb = (h) => {
  h = h.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgb2hex = (a) => '#' + a.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const lum = (h) => {
  const [r, g, b] = hex2rgb(h).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

function resolve(theme, value, depth = 0) {
  if (depth > 20) throw new Error('var() cycle: ' + value);
  value = value.trim();
  let m = value.match(/^var\((--[\w-]+)(?:\s*,\s*(.+))?\)$/);
  if (m) {
    const v = theme[m[1]];
    if (v === undefined) {
      if (m[2]) return resolve(theme, m[2], depth + 1);
      throw new Error('undefined token ' + m[1]);
    }
    return resolve(theme, v, depth + 1);
  }
  m = value.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*(.+)\)$/);
  if (m) {
    const A = hex2rgb(resolve(theme, m[1], depth + 1));
    const B = hex2rgb(resolve(theme, m[3], depth + 1));
    const p = Number(m[2]) / 100;
    return rgb2hex(A.map((v, i) => v * p + B[i] * (1 - p)));
  }
  if (/^#[0-9a-f]{3,6}$/i.test(value)) return value.toLowerCase();
  throw new Error('cannot resolve colour: ' + value);
}
const themeOf = (overlay) => {
  const merged = { ...light, ...overlay };
  const out = {};
  for (const k of Object.keys(merged)) {
    try { out[k] = resolve(merged, merged[k]); } catch { /* non-colour token */ }
  }
  return out;
};

const LIGHT = themeOf({});
const DARK_MEDIA = themeOf(mediaDark);
const DARK_ATTR = themeOf(attrDark);

/* ---- pairs: [label, fg token, bg token, min ratio] ----------------------- */
const T = (n) => '--' + n;
const pairs = [
  // body text
  ['text on surface', T('color-text-primary'), T('color-surface'), 4.5],
  ['text on bg', T('color-text-primary'), T('color-bg'), 4.5],
  ['text on surface-hover', T('color-text-primary'), T('color-surface-hover'), 4.5],
  ['text on row-active', T('color-text-primary'), T('color-row-active-bg'), 4.5],
  ['secondary on surface', T('color-text-secondary'), T('color-surface'), 4.5],
  ['secondary on bg', T('color-text-secondary'), T('color-bg'), 4.5],
  ['secondary on surface-hover', T('color-text-secondary'), T('color-surface-hover'), 4.5],
  ['tertiary on surface', T('color-text-tertiary'), T('color-surface'), 4.5],
  ['tertiary on bg', T('color-text-tertiary'), T('color-bg'), 4.5],
  ['placeholder on surface', T('color-placeholder'), T('color-surface'), 4.5],
  ['placeholder on bg', T('color-placeholder'), T('color-bg'), 4.5],
  ['disabled text on surface (exempt; must stay visible, >= 2)', T('color-text-disabled'), T('color-surface'), 2],
  // links
  ['link on surface', T('color-link'), T('color-surface'), 4.5],
  ['link on bg', T('color-link'), T('color-bg'), 4.5],
  ['link on row-active', T('color-link'), T('color-row-active-bg'), 4.5],
  // text on solid fills
  ['on-primary on primary', T('color-on-primary'), T('color-primary'), 4.5],
  ['on-critical on critical', T('color-on-critical'), T('color-critical'), 4.5],
  ['on-success on success', T('color-on-success'), T('color-success'), 4.5],
  ['on-warning on warning', T('color-on-warning'), T('color-warning'), 4.5],
  ['on-info on info', T('color-on-info'), T('color-info'), 4.5],
  ['white on navy', T('color-white'), T('color-navy'), 4.5],
  ['white on critical-solid', T('color-white'), T('color-critical-solid'), 4.5],
  ['white on critical-deep', T('color-white'), T('color-critical-deep'), 4.5],
  ['white on success-solid', T('color-white'), T('color-success-solid'), 4.5],
  ['white on warning-solid', T('color-white'), T('color-warning-solid'), 4.5],
  ['white on info-solid', T('color-white'), T('color-info-solid'), 4.5],
  // status colours used as text
  ['critical as text on surface', T('color-critical'), T('color-surface'), 4.5],
  ['critical as text on bg', T('color-critical'), T('color-bg'), 4.5],
  ['warning as text on surface', T('color-warning'), T('color-surface'), 4.5],
  ['warning as text on bg', T('color-warning'), T('color-bg'), 4.5],
  ['success as text on surface', T('color-success'), T('color-surface'), 4.5],
  ['success as text on bg', T('color-success'), T('color-bg'), 4.5],
  ['info as text on surface', T('color-info'), T('color-surface'), 4.5],
  ['info as text on bg', T('color-info'), T('color-bg'), 4.5],
  // pills
  ['pill success', T('pill-success-text'), T('tint-success-bg'), 4.5],
  ['pill critical', T('pill-critical-text'), T('tint-critical-bg'), 4.5],
  ['pill warning', T('pill-warning-text'), T('tint-warning-bg'), 4.5],
  ['pill info', T('pill-info-text'), T('tint-info-bg'), 4.5],
  ['pill neutral', T('pill-neutral-text'), T('tint-neutral-bg'), 4.5],
  // non-text UI (3:1)
  ['focus ring on surface', T('color-focus'), T('color-surface'), 3],
  ['focus ring on bg', T('color-focus'), T('color-bg'), 3],
  ['primary fill vs surface (UI)', T('color-primary'), T('color-surface'), 3],
  ['critical fill vs surface (UI)', T('color-critical'), T('color-surface'), 3],
];

let failures = 0;
let total = 0;
function run(name, theme) {
  console.log(`\n== ${name}`);
  for (const [label, fg, bg, min] of pairs) {
    total++;
    const f = theme[fg], b = theme[bg];
    if (!f || !b) {
      failures++;
      console.log(`FAIL  missing token (${!f ? fg : bg})  ${label}`);
      continue;
    }
    const r = ratio(f, b);
    const ok = r >= min;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}  (min ${min})  ${label}  ${f} on ${b}`);
  }
}
run('LIGHT', LIGHT);
run('DARK (prefers-color-scheme)', DARK_MEDIA);
run('DARK ([data-theme="dark"])', DARK_ATTR);

// the two dark blocks must resolve identically for every token they set
for (const k of new Set([...Object.keys(mediaDark), ...Object.keys(attrDark)])) {
  total++;
  if (DARK_MEDIA[k] !== DARK_ATTR[k]) {
    failures++;
    console.log(`FAIL  dark blocks disagree on ${k}: ${DARK_MEDIA[k]} vs ${DARK_ATTR[k]}`);
  }
}

console.log(`\n${total - failures}/${total} checks passed, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
