#!/usr/bin/env node
/**
 * Static touch-target check (Android 48dp guidance).
 *
 * 1. Scans src/**\/*.tsx for class names used on interactive elements
 *    (button, a, input, select, textarea, IonButton, IonItem/IonSegmentButton/
 *    IonTabButton/IonFabButton/IonChip with onClick/button, role=button|tab|
 *    switch|checkbox|link).
 * 2. Scans src/theme/*.css for rules on those classes that set height,
 *    min-height, width or min-width below 48px.
 * 3. A rule is OK when the same selector also gets a >=48px floor
 *    (min-height / min-width / height / width), or an expanded hit area
 *    (::after / ::before with negative inset or negative top/left/right/bottom),
 *    or the element carries .hit-48.
 * Exits non-zero when any violation remains outside ALLOW.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 48;

/** selector-substring -> reason. Every entry needs a one-line reason. */
const ALLOW = {
  // (filled in only when a control is genuinely not a touch target)
};

function walk(dir, ext, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

/* ---------- TSX: interactive class names ---------- */
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'IonButton',
  'IonSegmentButton', 'IonTabButton', 'IonFabButton', 'IonCheckbox', 'IonToggle', 'IonSelect',
  'IonInput', 'IonTextarea']);
const CLICKABLE_TAGS = new Set(['IonItem', 'IonChip', 'IonCard', 'div', 'span', 'li', 'label']);
const ROLES = /role=["'](button|tab|switch|checkbox|link)["']/;

function scanTags(src) {
  const tags = [];
  const re = /<([A-Za-z][A-Za-z0-9]*)\b/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 0, q = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === q && src[i - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth <= 0) break;
    }
    tags.push({ name: m[1], attrs: src.slice(re.lastIndex, i) });
  }
  return tags;
}

const interactive = new Map(); // class -> Set(tag)
const hit48Classes = new Set();
for (const file of walk(join(ROOT, 'src'), '.tsx')) {
  for (const t of scanTags(readFileSync(file, 'utf8'))) {
    const cn = t.attrs.match(/className=(?:"([^"]*)"|\{([^]*?)\}(?=\s+[A-Za-z-]+=|\s*\/?$))/);
    const clsText = cn ? (cn[1] ?? cn[2]) : '';
    const isInteractive = INTERACTIVE_TAGS.has(t.name) || ROLES.test(t.attrs)
      || (CLICKABLE_TAGS.has(t.name) && /\bonClick=/.test(t.attrs) && /(role=|button\b)/.test(t.attrs))
      || (t.name === 'IonItem' && /\b(onClick|button)\b/.test(t.attrs));
    if (!clsText) continue;
    const classes = clsText.match(/[A-Za-z_][\w-]*(?:__[\w-]+)?(?:--[\w-]+)?/g) || [];
    for (const c of classes) {
      if (c === 'hit-48' && isInteractive) { /* element-level utility */ }
      if (isInteractive) {
        if (!interactive.has(c)) interactive.set(c, new Set());
        interactive.get(c).add(t.name);
      }
    }
    if (isInteractive && /\bhit-48\b/.test(clsText)) {
      for (const c of classes) hit48Classes.add(c);
    }
  }
}

/* ---------- CSS ---------- */
function stripComments(s) { return s.replace(/\/\*[^]*?\*\//g, ''); }

function parseRules(css) {
  const rules = [];
  function parse(text) {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@')) {
        if (/^@(media|supports|layer)/.test(head)) parse(body);
      } else {
        rules.push({ selectors: head.split(',').map((s) => s.trim()).filter(Boolean), body });
      }
      i = j;
    }
  }
  parse(css);
  return rules;
}

function px(v) {
  v = v.trim();
  let m;
  if ((m = v.match(/^(-?[\d.]+)px$/))) return parseFloat(m[1]);
  if ((m = v.match(/^(-?[\d.]+)rem$/))) return parseFloat(m[1]) * 16;
  if ((m = v.match(/^var\(--touch-[\w-]+,\s*([\d.]+)px\)$/))) return parseFloat(m[1]);
  if (/^var\(--touch-(min-size|btn-height|input-height|fab-size|target)\)$/.test(v)) return 48;
  if (/^(48|52|56)px$/.test(v)) return parseFloat(v);
  return null;
}
function decls(body) {
  const d = {};
  for (const part of body.split(';')) {
    const k = part.indexOf(':');
    if (k < 0) continue;
    d[part.slice(0, k).trim()] = part.slice(k + 1).replace(/!important/, '').trim();
  }
  return d;
}
const negative = (v) => /^-/.test(v?.trim() ?? '') || /-\d/.test(v ?? '');

const rules = [];
for (const f of walk(join(ROOT, 'src', 'theme'), '.css')) {
  const file = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  for (const r of parseRules(stripComments(readFileSync(f, 'utf8')))) {
    for (const sel of r.selectors) rules.push({ file, sel, d: decls(r.body) });
  }
}

const floorBySel = new Map(); // selector -> {h:bool,w:bool}
const hitBySel = new Set();
for (const r of rules) {
  const pseudo = r.sel.match(/^(.*?)::?(after|before)$/);
  if (pseudo) {
    const d = r.d;
    const neg = negative(d.inset) || ['top', 'left', 'right', 'bottom'].some((k) => negative(d[k]));
    if (neg) hitBySel.add(pseudo[1]);
    continue;
  }
  const f = floorBySel.get(r.sel) || { h: false, w: false };
  for (const k of ['min-height', 'height']) if (r.d[k] && (px(r.d[k]) ?? 0) >= MIN) f.h = true;
  for (const k of ['min-width', 'width']) if (r.d[k] && (px(r.d[k]) ?? 0) >= MIN) f.w = true;
  floorBySel.set(r.sel, f);
}

const violations = [];
for (const r of rules) {
  if (/::?(after|before)$/.test(r.sel)) continue;
  const classes = r.sel.match(/\.[A-Za-z_][\w-]*/g)?.map((c) => c.slice(1)) ?? [];
  // the class that identifies the target is the LAST compound's classes
  const last = r.sel.split(/[\s>+~]+/).pop();
  const lastClasses = last.match(/\.[A-Za-z_][\w-]*/g)?.map((c) => c.slice(1)) ?? [];
  if (!lastClasses.length || !classes.length) continue;
  if (lastClasses.some((c) => c === 'hit-48')) continue;
  if (!lastClasses.some((c) => interactive.has(c))) continue;
  if (/:not\(|:disabled|::placeholder|:focus-visible|\[disabled\]/.test(last) && false) continue;
  if (lastClasses.some((c) => hit48Classes.has(c))) continue;
  const f = floorBySel.get(r.sel) || {};
  const baseSel = r.sel.replace(/:(hover|active|focus|focus-visible|disabled)\b/g, '');
  const f2 = floorBySel.get(baseSel) || {};
  const hit = hitBySel.has(r.sel) || hitBySel.has(baseSel);
  const rowH = new Set();
  for (const k of ['height', 'min-height', 'width', 'min-width']) {
    if (!r.d[k]) continue;
    const v = px(r.d[k]);
    if (v === null || v >= MIN) continue;
    const isH = k.endsWith('height');
    if (hit || (isH ? (f.h || f2.h) : (f.w || f2.w))) continue;
    rowH.add(`${k}:${r.d[k]}`);
  }
  if (!rowH.size) continue;
  const allowKey = Object.keys(ALLOW).find((a) => r.sel.includes(a));
  if (allowKey) continue;
  violations.push(`${r.file}  ${r.sel}  { ${[...rowH].join('; ')} }`);
}

const uniq = [...new Set(violations)];
console.log(`Interactive classes found in TSX: ${interactive.size}`);
console.log(`Allow-listed entries: ${Object.keys(ALLOW).length}`);
if (uniq.length) {
  console.log(`\nTouch-target violations (${uniq.length}):`);
  for (const v of uniq) console.log('  ' + v);
  process.exit(1);
}
console.log('Touch-target violations: 0');
