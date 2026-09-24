import { api, window, signIn, cleanup, settle, text, $ } from '../harness/render.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AiToolPanel } from '../../src/components/AiToolPanel.js';

afterEach(() => cleanup());

test('no model configured is a neutral notice, and explains there is no cloud fallback (§2 Rule 5)', async () => {
  api.on('GET', '/ai-tools/availability', () => ({ status: 200, body: { ollama: 'not_configured' } }));
  signIn('secretary');
  const panel = AiToolPanel({ tool: { label: 'AI Blotter Assistant', input: 'none', run: async () => ({ jobId: 1 }) } });
  window.document.getElementById('app').appendChild(panel.el);
  await settle();
  const banner = $('.ai-panel__banner', panel.el);
  assert.ok(banner.classList.contains('ai-panel__banner--neutral'), 'not_configured is neutral, not an alarm');
  assert.match(text(banner), /No AI model is configured/);
  assert.match(text(banner), /no cloud fallback/i);
  assert.equal($('button[type="submit"]', panel.el).disabled, true);
  panel.stop();
});
