import { window, cleanup, settle, text, click, key, $, $$ } from '../harness/render.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { confirmDialog, promptSelect } from '../../src/components/ConfirmDialog.js';
import { Menu, MenuItem } from '../../src/components/Menu.js';
import { XSS } from '../harness/fixtures.mjs';

afterEach(() => cleanup());
const doc = () => window.document;

function trigger() {
  const b = doc().createElement('button');
  b.textContent = 'Open';
  doc().getElementById('app').appendChild(b);
  b.focus();
  return b;
}

describe('confirmDialog', () => {
  test('is an accessible alertdialog labelled by its title', () => {
    confirmDialog({ title: 'Delete incident?', description: 'This cannot be undone.' });
    const dialog = $('[role="alertdialog"]');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(doc().getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Delete incident?');
  });

  test('focuses the SAFE action first, so a reflexive Enter does not destroy anything', () => {
    confirmDialog({ title: 'Deactivate?', danger: true, confirmLabel: 'Deactivate' });
    assert.equal(doc().activeElement.textContent, 'Cancel');
    assert.ok($('.confirm-dialog--danger'));
    assert.ok($$('.confirm-dialog button').at(-1).classList.contains('danger'));
  });

  test('confirm resolves true; cancel, Escape and backdrop resolve false', async () => {
    let p = confirmDialog({ title: 'A' });
    click($$('.confirm-dialog button').at(-1));
    assert.equal(await p, true);

    p = confirmDialog({ title: 'B' });
    click($$('.confirm-dialog button')[0]);
    assert.equal(await p, false);

    p = confirmDialog({ title: 'C' });
    key(doc(), 'Escape');
    assert.equal(await p, false);

    p = confirmDialog({ title: 'D' });
    click($('.confirm-backdrop'));
    assert.equal(await p, false);
    assert.equal($('[role="alertdialog"]'), null);
  });

  test('traps Tab inside the dialog in both directions', () => {
    confirmDialog({ title: 'Trap' });
    const [cancel, confirm] = $$('.confirm-dialog button');
    confirm.focus();
    key(doc(), 'Tab');
    assert.equal(doc().activeElement, cancel);
    key(doc(), 'Tab', { shiftKey: true });
    assert.equal(doc().activeElement, confirm);
  });

  test('returns focus to whatever opened it', async () => {
    const opener = trigger();
    const p = confirmDialog({ title: 'Focus' });
    click($$('.confirm-dialog button')[0]);
    await p;
    assert.equal(doc().activeElement, opener);
  });

  test('an async confirm that fails keeps the dialog open with the error shown, and re-enables it', async () => {
    const p = confirmDialog({ title: 'Save', onConfirmAsync: async () => { throw new Error('Server said no.'); } });
    const confirm = $$('.confirm-dialog button').at(-1);
    click(confirm);
    await settle();
    assert.ok($('[role="alertdialog"]'), 'dialog must stay open on failure');
    assert.equal(text($('.confirm-dialog__error')), 'Server said no.');
    assert.equal(confirm.disabled, false);
    click($$('.confirm-dialog button')[0]);
    assert.equal(await p, false);
  });

  test('the title and description are text, never markup', () => {
    confirmDialog({ title: XSS, description: XSS });
    assert.equal($$('[data-xss-canary]').length, 0);
  });
});

describe('promptSelect', () => {
  test('focuses the choice, returns the picked value, and null when cancelled', async () => {
    let p = promptSelect({ title: 'Assign Tanod', label: 'Tanod', options: [{ value: 4, label: 'Jose' }, { value: 5, label: 'Maria' }] });
    const select = $('#confirm-dialog-select');
    assert.equal(doc().activeElement, select);
    assert.equal($('label[for="confirm-dialog-select"]').textContent, 'Tanod');
    select.value = '5';
    click($$('.confirm-dialog button').at(-1));
    assert.equal(await p, '5');

    p = promptSelect({ title: 'Assign', label: 'Tanod', options: [{ value: 4, label: 'Jose' }] });
    key(doc(), 'Escape');
    assert.equal(await p, null);
  });
});

describe('Menu', () => {
  function build() {
    const button = doc().createElement('button');
    button.textContent = 'Account';
    const menu = Menu({ trigger: button, label: 'Account menu' });
    menu.panel.append(MenuItem({ label: 'Settings', onClick: () => {} }), MenuItem({ label: 'Sign out', danger: true, onClick: () => {} }));
    doc().getElementById('app').appendChild(menu.el);
    return { button, menu };
  }

  test('wires aria-haspopup/expanded/controls to a role="menu" panel of menuitems', () => {
    const { button, menu } = build();
    assert.equal(button.getAttribute('aria-haspopup'), 'menu');
    assert.equal(button.getAttribute('aria-controls'), menu.panel.id);
    assert.equal(menu.panel.getAttribute('role'), 'menu');
    assert.equal($$('[role="menuitem"]', menu.panel).length, 2);
    assert.equal(menu.panel.hidden, true);
  });

  test('ArrowDown opens and focuses the first item; arrows wrap; Escape closes and restores focus', () => {
    const { button, menu } = build();
    button.focus();
    key(button, 'ArrowDown');
    const items = $$('[role="menuitem"]', menu.panel);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(doc().activeElement, items[0]);
    key(menu.panel, 'ArrowUp');
    assert.equal(doc().activeElement, items[1], 'ArrowUp from the first item wraps to the last');
    key(menu.panel, 'Escape');
    assert.equal(menu.isOpen(), false);
    assert.equal(doc().activeElement, button);
  });

  test('an outside click closes it, and opening one menu closes another', () => {
    const a = build();
    const b = build();
    click(a.button);
    assert.equal(a.menu.isOpen(), true);
    click(b.button);
    assert.equal(a.menu.isOpen(), false, 'only one menu open at a time');
    click(doc().body);
    assert.equal(b.menu.isOpen(), false);
  });
});
