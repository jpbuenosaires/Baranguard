import { describePage } from '../harness/pageSuite.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, window, mountPage, settle, cleanup, text, click, type, key, buttonByText, $, $$ } from '../harness/render.mjs';
import { renderSettingsPage, DEFAULT_PAGE_KEY } from '../../src/pages/settings.js';

const openSection = (label) => async () => { click(buttonByText(new RegExp(`^${label}`, 'i'))); };

describePage({
  name: 'Settings (W15)',
  render: renderSettingsPage,
  roles: ['admin', 'secretary', 'punong_barangay'],
  heading: 'Settings',
  noDataFetchRoles: ['admin', 'secretary', 'punong_barangay'], // the default Profile section fetches nothing
});

describePage({
  name: 'Settings › General (W21)',
  render: renderSettingsPage,
  roles: ['admin'],
  heading: 'Settings',
  openDataView: openSection('General'),
});

describe('Settings behaviour', () => {
  afterEach(() => cleanup());

  for (const role of ['secretary', 'punong_barangay']) {
    test(`${role} has no System Configuration sections`, async () => {
      mountPage(renderSettingsPage, { role });
      await settle();
      for (const label of ['General', 'SOS Fallback']) {
        assert.equal(buttonByText(new RegExp(`^${label}`, 'i')), undefined, `${role} must not see ${label}`);
      }
      assert.equal(api.callsTo('GET', '/system-settings').length, 0);
    });
  }

  test('saving General sends only the three general.* keys', async () => {
    mountPage(renderSettingsPage, { role: 'admin' });
    await settle();
    await openSection('General')();
    await settle();
    const name = $$('input', $('.page-content')).find((i) => i.value === 'Baranguard');
    assert.ok(name, 'system name field not found');
    type(name, 'Baranguard Dao');
    click(buttonByText(/^save/i, $('.page-content')));
    await settle();
    const [call] = api.callsTo('PATCH', '/system-settings');
    assert.ok(call, 'PATCH /system-settings was not sent');
    const keys = Object.keys(call.body.settings);
    assert.ok(keys.every((k) => k.startsWith('general.')), `unexpected keys sent: ${keys}`);
    assert.equal(call.body.settings['general.system_name'], 'Baranguard Dao');
  });

  const themeCard = (label) => $$('.settings-theme-card').find((el) => new RegExp(label, 'i').test(text(el)));

  test('the theme choice applies immediately and persists across reloads', async () => {
    mountPage(renderSettingsPage, { role: 'secretary' });
    await settle();
    await openSection('Appearance')();
    await settle();
    const dark = themeCard('Dark Mode');
    assert.ok(dark, 'no Dark Mode option in Appearance');
    click(dark);
    await settle();
    assert.equal(window.localStorage.getItem('baranguard.theme'), 'dark');
    assert.equal(window.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.ok(dark.classList.contains('is-active'), 'the chosen theme should show as selected');
  });

  test('the theme cards work from the keyboard (they are role="button" divs)', async () => {
    mountPage(renderSettingsPage, { role: 'secretary' });
    await settle();
    await openSection('Appearance')();
    await settle();
    const dark = themeCard('Dark Mode');
    dark.focus();
    key(dark, 'Enter');
    await settle();
    assert.equal(window.document.documentElement.getAttribute('data-theme'), 'dark',
      'Enter on a focused role="button" must activate it — a <div> does not get this for free the way <button> does');
    const light = themeCard('Light Mode');
    light.focus();
    key(light, ' ');
    await settle();
    assert.equal(window.document.documentElement.getAttribute('data-theme'), 'light', 'Space must activate it too');
  });

  test('the default landing page only offers screens this role can open', async () => {
    const SECRETARY_PAGES = ['incident-management', 'citizen-inbox', 'settings'];
    mountPage(renderSettingsPage, { role: 'secretary' });
    await settle();
    await openSection('Appearance')();
    await settle();
    const select = $('#settings-default-page');
    assert.ok(select, 'no landing-page picker');
    const offered = [...select.options].map((o) => o.value).filter(Boolean);
    assert.deepEqual(offered.filter((v) => !SECRETARY_PAGES.includes(v)), [], 'offers a page main.js would refuse');
    type(select, 'citizen-inbox');
    await settle();
    assert.equal(window.localStorage.getItem(DEFAULT_PAGE_KEY), 'citizen-inbox');
  });
});
