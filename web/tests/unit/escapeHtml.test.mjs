import '../harness/render.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../../src/utils/escapeHtml.js';

test('escapes all five HTML-significant characters', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('escapes & first, so existing entities are not double-decoded into markup', () => {
  assert.equal(escapeHtml('&lt;script&gt;'), '&amp;lt;script&amp;gt;');
});

test('null and undefined become empty; 0 and false are kept (the old private copies lost 0)', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});

test('an escaped payload stays inert when parsed as HTML', () => {
  const div = document.createElement('div');
  div.innerHTML = `<span title="${escapeHtml('" onmouseover="alert(1)')}">${escapeHtml('<img src=x onerror=alert(1)>')}</span>`;
  assert.equal(div.querySelector('img'), null);
  assert.equal(div.querySelector('span').getAttribute('onmouseover'), null);
  assert.equal(div.textContent, '<img src=x onerror=alert(1)>');
});
