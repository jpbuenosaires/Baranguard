// Removes selectors that reference a class no source file mentions (see find-dead-css.mjs). A comma list loses only the
// dead selectors; a rule with none left, and any emptied at-rule, is dropped. Selectors with :not/:is/:where are kept.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const root = fileURLToPath(new URL('..', import.meta.url));
const KEEP = new Set(['tab-selected']); // added by Ionic at runtime
const dead = JSON.parse(execFileSync('node', ['scripts/find-dead-css.mjs', '--json'], { cwd: root, encoding: 'utf8' }));
const byFile = {};
for (const d of dead) if (!KEEP.has(d.cls)) (byFile[d.file] ??= new Set()).add(d.cls);

let removedSelectors = 0, removedRules = 0;
for (const [rel, set] of Object.entries(byFile)) {
  const path = root + rel;
  const raw = readFileSync(path, 'utf8');
  const crlf = raw.includes('\r\n');
  const ast = postcss.parse(raw);
  ast.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
    const kept = rule.selectors.filter((sel) => {
      if (/:(not|is|where|has)\(/.test(sel)) return true;
      const classes = [...sel.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
      const isDead = classes.some((c) => set.has(c));
      if (isDead) removedSelectors++;
      return !isDead;
    });
    if (kept.length === 0) { rule.remove(); removedRules++; }
    else if (kept.length !== rule.selectors.length) rule.selectors = kept;
  });
  ast.walkAtRules((at) => { if (at.nodes && at.nodes.length === 0 && /^(media|supports)$/.test(at.name)) at.remove(); });
  let out = ast.toString().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  writeFileSync(path, crlf ? out.replace(/\n/g, '\r\n') : out);
}
console.log(`removed ${removedSelectors} selectors, ${removedRules} whole rules`);
