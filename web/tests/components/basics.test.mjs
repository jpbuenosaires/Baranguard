import { window, cleanup, text, click, wait, $, $$ } from '../harness/render.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { icons } from '../../src/components/icons.js';
import { PageHeader } from '../../src/components/PageHeader.js';
import { StatStrip } from '../../src/components/StatStrip.js';
import { avatarInitials } from '../../src/components/Avatar.js';
import { InfoTip } from '../../src/components/Tooltip.js';
import { KpiCard } from '../../src/components/KpiCard.js';
import { renderLoadingSkeleton, renderErrorState } from '../../src/components/AsyncState.js';
import { showToast } from '../../src/components/Toast.js';
import { XSS } from '../harness/fixtures.mjs';

afterEach(() => cleanup());
const mount = (el) => { window.document.getElementById('app').appendChild(el); return el; };
const noInjection = () => assert.equal($$('[data-xss-canary]').length, 0, 'text was parsed as markup');

describe('icons', () => {
  test('every icon is a 24x24 stroke SVG sized in rem (scales with the UI knob)', () => {
    const names = Object.keys(icons);
    assert.ok(names.length > 30);
    for (const name of names) {
      const svg = icons[name](16);
      assert.match(svg, /^<svg /, `${name} is not an <svg>`);
      assert.match(svg, /viewBox="0 0 24 24"/, `${name} has the wrong viewBox`);
      assert.match(svg, /width="1rem" height="1rem"/, `${name} did not convert 16px to 1rem`);
    }
  });
});

describe('PageHeader', () => {
  test('renders a real <h2> title and an empty actions slot', () => {
    const { el, actions } = PageHeader({ title: 'Audit Log', subtitle: 'Immutable record', icon: icons.shield });
    mount(el);
    assert.equal(el.querySelector('h2.page-header__title').textContent, 'Audit Log');
    assert.equal(el.querySelector('.page-header__subtitle').textContent, 'Immutable record');
    assert.equal(el.querySelector('.page-header__icon').getAttribute('aria-hidden'), 'true');
    assert.equal(actions.children.length, 0);
  });

  test('title and subtitle are text, never markup', () => {
    mount(PageHeader({ title: XSS, subtitle: XSS }).el);
    noInjection();
  });
});

describe('StatStrip', () => {
  test('renders each value with its tone class', () => {
    const el = mount(StatStrip({ items: [{ label: 'Online', value: 12, tone: 'success' }, { label: 'Pending', value: 0 }] }));
    const values = $$('.stat-strip__value', el);
    assert.equal(values[0].textContent, '12');
    assert.ok(values[0].classList.contains('tone-success'));
    assert.equal(values[1].textContent, '0', 'a real 0 must still render');
  });
});

describe('Avatar initials', () => {
  test('first + last initial, uppercase; single names and blanks handled', () => {
    const initials = (name) => { const d = window.document.createElement('div'); d.innerHTML = avatarInitials(name); return d.textContent; };
    assert.equal(initials('liwayway de la ferrer'), 'LF');
    assert.equal(initials('Cher'), 'C');
    assert.equal(initials('   '), '?');
    assert.equal(initials(null), '?');
  });

  test('is decorative (aria-hidden) and deterministic per name', () => {
    assert.match(avatarInitials('Jose Reyes'), /aria-hidden="true"/);
    assert.equal(avatarInitials('Jose Reyes'), avatarInitials('Jose Reyes'));
  });

  test('a hostile name cannot inject markup', () => {
    const d = mount(window.document.createElement('div'));
    d.innerHTML = avatarInitials('<b data-xss-canary>x</b> <img data-xss-canary src=x>');
    noInjection();
  });
});

describe('InfoTip', () => {
  test('trigger is a named button described by a role="tooltip" panel with a unique id', () => {
    const a = mount(InfoTip('Counts every incident in range.'));
    const b = mount(InfoTip('Another'));
    const trigger = $('button', a);
    const panel = $('[role="tooltip"]', a);
    assert.equal(trigger.getAttribute('aria-describedby'), panel.id);
    assert.equal(trigger.getAttribute('aria-label'), 'What does this mean?');
    assert.notEqual(panel.id, $('[role="tooltip"]', b).id);
    assert.equal(panel.textContent, 'Counts every incident in range.');
  });
});

describe('KpiCard', () => {
  test('null value shows the empty marker — "no data" must not look like 0', () => {
    const el = mount(KpiCard({ label: 'Avg. Response Time', value: null }));
    assert.equal(text($('.kpi-card__value', el)), '—');
    assert.ok($('.kpi-card__value', el).classList.contains('empty'));
  });

  test('delta is a percentage against a known prior value, raw otherwise', () => {
    const pct = mount(KpiCard({ label: 'Total', value: 12, delta: 3, previousValue: 9 }));
    assert.equal(text($('.kpi-card__delta', pct)), '+33%');
    const raw = mount(KpiCard({ label: 'Total', value: 3, delta: 3, previousValue: 0 }));
    assert.equal(text($('.kpi-card__delta', raw)), '+3', 'a prior of 0 has no percentage');
  });

  test('delta colour follows the metric\'s own good direction', () => {
    const moreIncidents = mount(KpiCard({ label: 'Incidents', value: 5, delta: 2, trend: 'down-good' }));
    assert.ok($('.kpi-card__delta', moreIncidents).classList.contains('kpi-card__delta--negative'));
    const neutral = mount(KpiCard({ label: 'On duty', value: 5, delta: 2 }));
    assert.ok($('.kpi-card__delta', neutral).classList.contains('kpi-card__delta--neutral'));
  });

  test('sparkline only with at least two real points, and setDelta updates in place', () => {
    const one = mount(KpiCard({ label: 'Total', value: 1, sparkline: [4] }));
    assert.equal($('.kpi-card__sparkline', one), null);
    const two = mount(KpiCard({ label: 'Total', value: 1, sparkline: [4, 4] }));
    assert.ok($('.kpi-card__sparkline svg', two), 'a flat series must still draw (no divide-by-zero)');
    assert.doesNotMatch(two.innerHTML, /NaN/);
    two.setDelta(-2, 4);
    assert.equal(text($('.kpi-card__delta', two)), '−50%');
  });

  test('label is text, never markup', () => {
    mount(KpiCard({ label: XSS, value: 1, description: XSS }));
    noInjection();
  });
});

describe('AsyncState', () => {
  test('loading skeleton announces itself and honours count', () => {
    const container = mount(window.document.createElement('div'));
    container.textContent = 'old content';
    renderLoadingSkeleton({ container, count: 4, ariaLabel: 'Loading incidents' });
    assert.equal($$('.skeleton', container).length, 4);
    assert.equal($('[role="status"]', container).getAttribute('aria-label'), 'Loading incidents');
    assert.doesNotMatch(container.textContent, /old content/);
  });

  test('error state is an alert with a working retry and a custom label', () => {
    const container = mount(window.document.createElement('div'));
    let retried = 0;
    renderErrorState({ container, message: XSS, onRetry: () => { retried += 1; }, retryLabel: 'Retry Diagnostics' });
    assert.equal($('.state-block--error', container).getAttribute('role'), 'alert');
    noInjection();
    const retry = $('button', container);
    assert.equal(retry.textContent, 'Retry Diagnostics');
    click(retry);
    assert.equal(retried, 1);
  });
});

describe('Toast', () => {
  test('errors are alerts, everything else is status; message is text', () => {
    showToast(XSS, { variant: 'error' });
    showToast('Saved.', { variant: 'success' });
    const [err, ok] = $$('.toast');
    assert.equal(err.getAttribute('role'), 'alert');
    assert.equal(ok.getAttribute('role'), 'status');
    noInjection();
    assert.equal($('.toast-container').getAttribute('aria-live'), 'polite');
  });

  test('the close button is named and dismisses', async () => {
    showToast('Bye', { variant: 'info' });
    const close = $('.toast__close');
    assert.equal(close.getAttribute('aria-label'), 'Dismiss notification');
    click(close);
    await wait(450);
    assert.equal($$('.toast').length, 0);
  });

  test('dismisses itself after its duration', async () => {
    showToast('Auto', { duration: 50 });
    await wait(500);
    assert.equal($$('.toast').length, 0);
  });
});
