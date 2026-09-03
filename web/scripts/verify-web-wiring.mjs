/**
 * verify-web-wiring.mjs — static wiring checks for the web dashboard.
 *
 * WHY THIS EXISTS: this stack has no bundler and no test runner (§1 — plain
 * ES modules loaded straight from index.html), so nothing catches a broken
 * import or a CSS class that was never defined until a human opens the page
 * and sees a blank screen. A real bug of exactly that kind was made while
 * building W8 in Sprint 6: `className = 'muted'` / `'card__header'` /
 * `'card__actions'` — all classes that exist in the MOBILE app's
 * theme/app.css, not the web dashboard's base.css. They would have
 * rendered as unstyled text with no error anywhere.
 *
 * That class of bug is invisible to `node --check`, which only parses
 * syntax. This script closes the gap WITHOUT a browser, a bundler, or a
 * dependency: pure Node, regex-based, runs in well under a second.
 *
 * WHAT IT CHECKS
 *   1. Every `import { a, b } from './x.js'` resolves to a real file that
 *      actually exports `a` and `b`.
 *   2. Every literal CSS class used from JS is defined in some stylesheet
 *      that index.html actually links.
 *   3. Every stylesheet/script path referenced by index.html exists.
 *
 * WHAT IT DOES NOT CHECK (stated so nobody mistakes a pass for more than
 * it is): runtime behaviour, DOM structure, or whether a screen looks
 * right. Notably it also does NOT catch undefined identifiers — the other
 * W8 bug was `${API_BASE_URL}` where the constant is actually named
 * `BASE_URL`, a ReferenceError that only fires when that line runs.
 * Catching that needs real scope analysis (i.e. a linter), which is a
 * dependency this project has deliberately not taken on. This is a wiring
 * check, not a test suite; a browser pass remains the only thing that
 * proves a screen actually works.
 *
 * Usage:  node web/scripts/verify-web-wiring.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = join(WEB_ROOT, 'src');

let pass = 0;
let fail = 0;
const ok = (msg) => { pass += 1; if (process.env.VERBOSE) console.log(`[PASS] ${msg}`); };
const bad = (msg) => { fail += 1; console.log(`[FAIL] ${msg}`); };

/** Every .js file under web/src, recursively. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = jsFiles(SRC_ROOT);
console.log(`Baranguard web wiring check — ${files.length} JS modules under web/src\n`);

// ---------------------------------------------------------------------------
// 1. Import/export resolution
// ---------------------------------------------------------------------------

/** Named exports of a module: `export function x`, `export const x`, `export class x`. */
function exportsOf(file) {
  const source = readFileSync(file, 'utf8');
  const names = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g,
    /export\s+class\s+([A-Za-z0-9_$]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  // `export { a, b as c }`
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      const asMatch = cleaned.match(/\s+as\s+([A-Za-z0-9_$]+)$/);
      names.add(asMatch ? asMatch[1] : cleaned);
    }
  }
  return names;
}

const exportCache = new Map();
function cachedExports(file) {
  if (!exportCache.has(file)) exportCache.set(file, exportsOf(file));
  return exportCache.get(file);
}

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const rel = relative(WEB_ROOT, file).replace(/\\/g, '/');

  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[2];
    if (!specifier.startsWith('.')) continue; // bare specifiers: none in this stack

    const target = resolve(dirname(file), specifier);
    if (!existsSync(target)) {
      bad(`${rel} imports '${specifier}' — file does not exist`);
      continue;
    }
    ok(`${rel} -> ${specifier} exists`);

    const available = cachedExports(target);
    for (const raw of match[1].split(',')) {
      const cleaned = raw.trim();
      if (!cleaned) continue;
      // `import { a as b }` — the ORIGINAL name is what must be exported.
      const name = cleaned.split(/\s+as\s+/)[0].trim();
      if (!available.has(name)) {
        bad(`${rel} imports '{ ${name} }' from '${specifier}' — that module does not export it`);
      } else {
        ok(`${rel}: '${name}' is exported by ${specifier}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. CSS classes used from JS must be defined in a linked stylesheet
// ---------------------------------------------------------------------------

const indexHtml = readFileSync(join(WEB_ROOT, 'index.html'), 'utf8');

const linkedCss = [...indexHtml.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);
const definedClasses = new Set();
for (const href of linkedCss) {
  if (href.startsWith('http')) continue; // Google Fonts etc.
  const cssPath = join(WEB_ROOT, href);
  if (!existsSync(cssPath)) {
    bad(`index.html links '${href}' — file does not exist`);
    continue;
  }
  ok(`index.html -> ${href} exists`);
  const css = readFileSync(cssPath, 'utf8');
  for (const match of css.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) {
    definedClasses.add(match[1]);
  }
}

// Vendored/third-party classes we do not own and must not flag.
const EXTERNAL_PREFIXES = ['maplibregl-', 'mapboxgl-'];
/**
 * Deliberate exceptions. Kept short and individually justified — an
 * allowlist that grows without explanation would quietly defeat the check.
 *
 *   hidden    — set via the `hidden` attribute/property, not a stylesheet.
 *   kpi-card  — a semantic marker class with no styles of its own; the
 *               element carries `.card` alongside it, which does the
 *               styling. Only `.kpi-card__*` children are styled.
 */
const IGNORED = new Set(['hidden', 'kpi-card']);

function classTokensFrom(source) {
  const tokens = [];
  // className = 'a b c'   /   className = "a b"
  for (const match of source.matchAll(/className\s*=\s*['"]([^'"]+)['"]/g)) {
    tokens.push(...match[1].split(/\s+/));
  }
  // className = `a b ${expr} c`  — take only the literal chunks
  for (const match of source.matchAll(/className\s*=\s*`([^`]*)`/g)) {
    const literalOnly = match[1].replace(/\$\{[^}]*\}/g, ' ');
    tokens.push(...literalOnly.split(/\s+/));
  }
  // classList.add('a', 'b')
  for (const match of source.matchAll(/classList\.(?:add|toggle|remove)\(([^)]*)\)/g)) {
    for (const part of match[1].split(',')) {
      const literal = part.trim().match(/^['"]([^'"]+)['"]$/);
      if (literal) tokens.push(...literal[1].split(/\s+/));
    }
  }
  return tokens.filter(Boolean);
}

const unknownByFile = new Map();
for (const file of files) {
  const rel = relative(WEB_ROOT, file).replace(/\\/g, '/');
  for (const token of classTokensFrom(readFileSync(file, 'utf8'))) {
    if (IGNORED.has(token)) continue;
    // A token left dangling on a hyphen is the literal half of a computed
    // class — `'status-badge--' + state` or `` `toast--${variant}` ``. The
    // real class name only exists at runtime, so it cannot be checked
    // statically; flagging it would be pure noise.
    if (token.endsWith('-')) continue;
    if (EXTERNAL_PREFIXES.some((prefix) => token.startsWith(prefix))) continue;
    if (definedClasses.has(token)) continue;
    if (!unknownByFile.has(rel)) unknownByFile.set(rel, new Set());
    unknownByFile.get(rel).add(token);
  }
}

if (unknownByFile.size === 0) {
  ok('every CSS class used from JS is defined in a linked stylesheet');
  console.log('[PASS] every CSS class used from JS is defined in a linked stylesheet');
} else {
  for (const [file, tokens] of unknownByFile) {
    bad(`${file} uses undefined CSS class(es): ${[...tokens].join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Scripts referenced by index.html exist
// ---------------------------------------------------------------------------

for (const match of indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)) {
  const src = match[1];
  if (src.startsWith('http')) continue;
  if (existsSync(join(WEB_ROOT, src))) {
    ok(`index.html -> ${src} exists`);
  } else {
    bad(`index.html references script '${src}' — file does not exist`);
  }
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} checks passed, ${fail} failed`);
if (fail === 0) console.log('Web wiring OK.');
process.exit(fail === 0 ? 0 : 1);
