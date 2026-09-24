/**
 * AiToolPanel when the local model is down — this workstation's normal
 * state (docs/REMAINING.md A2). §2 Rule 6: the panel must say so honestly
 * and never offer a Generate button that silently does nothing.
 */
import { api, window, signIn, cleanup, settle, text, $ } from '../harness/render.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AiToolPanel } from '../../src/components/AiToolPanel.js';
import { queueSmsCompose } from '../../src/api/apiClient.js';

afterEach(() => cleanup());

test('an unreachable probe is treated as unavailable: honest banner, disabled Generate, nothing queued', async () => {
  // The probe itself failing must be read as "unhealthy", never assumed fine.
  api.fail('GET', '/ai-tools/availability', 503);
  signIn('admin');
  const panel = AiToolPanel({ tool: { label: 'AI Message Composer', input: 'text', inputLabel: 'Situation', run: (v) => queueSmsCompose(v) } });
  window.document.getElementById('app').appendChild(panel.el);
  await settle();

  const banner = $('.ai-panel__banner', panel.el);
  assert.ok(banner, 'no unavailable banner');
  assert.equal(banner.getAttribute('role'), 'status');
  assert.match(text(banner), /not responding/);
  assert.match(text(banner), /Nothing is queued/);

  const generate = $('button[type="submit"]', panel.el);
  assert.equal(generate.disabled, true);
  assert.match(generate.title, /not responding/, 'a disabled control should say why');

  $('form', panel.el).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(api.callsTo('POST', '/ai-tools/sms-compose').length, 0);
  panel.stop();
});
