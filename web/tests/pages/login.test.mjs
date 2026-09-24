import { api, window, cleanup, settle, text, click, type, $, assertAccessible, assertNoRuntimeErrors } from '../harness/render.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderLoginPage } from '../../src/pages/login.js';
import * as apiClient from '../../src/api/apiClient.js';

afterEach(() => cleanup());

function mount() {
  const successes = [];
  const root = window.document.getElementById('app');
  renderLoginPage(root, (user) => successes.push(user));
  return { root, successes, form: $('form', root), user: $('#login-username'), pass: $('#login-password') };
}
const submit = (form) => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

describe('Login (W1)', () => {
  test('fields are properly labelled (placeholders are not labels)', () => {
    mount();
    assertAccessible();
  });

  test('empty fields are caught locally, flagged aria-invalid, and nothing is sent', async () => {
    const ctx = mount();
    submit(ctx.form);
    await settle();
    assert.equal(text($('#login-error')), 'Enter a username and password.');
    assert.equal(ctx.user.getAttribute('aria-invalid'), 'true');
    assert.equal(ctx.user.getAttribute('aria-describedby'), 'login-error');
    assert.equal(window.document.activeElement, ctx.user);
    assert.equal(api.calls.length, 0);
  });

  test('wrong credentials get ONE generic message (never "unknown user" vs "wrong password")', async () => {
    const ctx = mount();
    type(ctx.user, 'admin.dao');
    type(ctx.pass, 'wrong');
    submit(ctx.form);
    await settle();
    assert.equal(text($('#login-error')), 'Unable to sign in with those credentials.');
    assert.equal(ctx.successes.length, 0);
    assert.equal(apiClient.getSession(), null);
    assert.equal(ctx.user.disabled, false, 'controls must be re-enabled after a failure');
  });

  test('a network failure says so honestly instead of blaming the password', async () => {
    api.on('POST', '/auth/login', () => { throw new TypeError('Failed to fetch'); });
    const ctx = mount();
    type(ctx.user, 'admin.dao');
    type(ctx.pass, 'Correct-Horse-9');
    submit(ctx.form);
    await settle();
    assert.match(text($('#login-error')), /Could not reach the Baranguard server/);
  });

  test('controls are locked with a visible "Signing in…" state while the request is in flight', async () => {
    const ctx = mount();
    type(ctx.user, 'admin.dao');
    type(ctx.pass, 'Correct-Horse-9');
    submit(ctx.form);
    const button = $('button[type="submit"]', ctx.root);
    assert.equal(button.disabled, true, 'double-submit must be impossible');
    assert.match(text(button), /Signing in/);
    await settle();
  });

  test('correct credentials store the session and hand the user to the router', async () => {
    const ctx = mount();
    type(ctx.user, 'secretary.dao');
    type(ctx.pass, 'Correct-Horse-9');
    submit(ctx.form);
    await settle();
    assert.deepEqual(ctx.successes, [{ userId: 2, fullName: 'Liwayway Ferrer', role: 'secretary', barangayId: 1 }]);
    assertNoRuntimeErrors();
  });

  test('"Remember my username" stores only the username, never the password', async () => {
    const ctx = mount();
    type(ctx.user, 'admin.dao');
    type(ctx.pass, 'Correct-Horse-9');
    click($('input[type="checkbox"]', ctx.root));
    submit(ctx.form);
    await settle();
    assert.equal(window.localStorage.getItem('baranguard.rememberedUsername'), 'admin.dao');
    const everything = JSON.stringify({ ...window.localStorage });
    assert.doesNotMatch(everything, /Correct-Horse-9/);
    cleanup();
    window.localStorage.setItem('baranguard.rememberedUsername', 'admin.dao');
    assert.equal(mount().user.value, 'admin.dao', 'the remembered username pre-fills on the next visit');
  });

  test('the show-password toggle flips the field type and is named', () => {
    const ctx = mount();
    const toggle = [...ctx.root.querySelectorAll('button[type="button"]')].find((b) => /password/i.test(b.getAttribute('aria-label') || ''));
    assert.ok(toggle, 'no named show/hide password button');
    click(toggle);
    assert.equal(ctx.pass.type, 'text');
    click(toggle);
    assert.equal(ctx.pass.type, 'password');
  });
});
