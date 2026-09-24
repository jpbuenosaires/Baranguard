import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountPage, settle, cleanup, text, $ } from '../harness/render.mjs';
import { renderServiceHealthPage } from '../../src/pages/service-health.js';

describePage({
  name: 'Service Health (W20)',
  render: renderServiceHealthPage,
  roles: ['admin'],
  heading: 'Service Health',
  expectText: ['Dependency status changes'],
  polls: true,
});

describe('Service Health behaviour', () => {
  afterEach(() => cleanup());

  test('a configured-but-failing dependency is called out; not_configured is neutral (§2 Rule 6)', async () => {
    mountPage(renderServiceHealthPage, { role: 'admin' });
    await settle();
    const body = text($('.page-content'));
    assert.match(body, /1 Failing/, 'Ollama is the one configured dependency that is down');
    assert.match(body, /2 Neutral/, 'ORS and the GSM SMS gateway are unconfigured, not failing');
  });

  test('the history\'s sampling caveat is shown, not hidden', async () => {
    mountPage(renderServiceHealthPage, { role: 'admin' });
    await settle();
    assert.match(text(), /gap means no one was watching|only when a status actually changes/i);
  });

  test('a restore drill that never ran says so honestly', async () => {
    mountPage(renderServiceHealthPage, { role: 'admin' });
    await settle();
    assert.match(text($('.page-content')), /never/i);
  });
});
