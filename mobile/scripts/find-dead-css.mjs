// Lists class selectors in src/theme/*.css that no source file mentions. Conservative: a class counts as used if its full
// name appears in any .ts/.tsx/.html source, or if a dynamic prefix (`foo-${x}`, 'foo-' + x) in source could build it.
// Usage: node scripts/find-dead-css.mjs [--json]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (d, out = []) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const src = walk(join(root, 'src'));
const code = src.filter((f) => ['.ts', '.tsx'].includes(extname(f)) && !/\.test\./.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n') +
  '\n' + readFileSync(join(root, 'index.html'), 'utf8');
const cssFiles = src.filter((f) => extname(f) === '.css');

// Dynamic prefixes: text immediately before `${` or a closing quote followed by `+` inside a class-ish string.
const prefixes = new Set();
for (const m of code.matchAll(/([a-z][a-z0-9_-]*-)\$\{/gi)) prefixes.add(m[1]);
for (const m of code.matchAll(/['"`]([a-z][a-z0-9_-]*-)['"`]\s*\+/gi)) prefixes.add(m[1]);

const used = (name) => code.includes(name) || [...prefixes].some((p) => name.startsWith(p));

const dead = [];
for (const f of cssFiles) {
  const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set();
  // Only look in selector positions (text before `{`), not in declaration values like 0.5s or #fff.
  for (const sel of css.matchAll(/([^{}]+)\{/g)) {
    if (/^\s*@(keyframes|media|supports|font-face)/.test(sel[1])) continue;
    for (const m of sel[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) names.add(m[1]);
  }
  for (const n of names) if (!used(n)) dead.push({ file: f.slice(root.length), cls: n });
}
if (process.argv.includes('--json')) console.log(JSON.stringify(dead, null, 1));
else {
  const by = {};
  for (const d of dead) (by[d.file] ??= []).push(d.cls);
  for (const [f, c] of Object.entries(by)) console.log(`${f} (${c.length}): ${c.join(' ')}`);
  console.log(`\n${dead.length} classes with no source reference`);
}
