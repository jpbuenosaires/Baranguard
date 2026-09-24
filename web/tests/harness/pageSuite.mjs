/**
 * pageSuite.mjs — the checks every data-driven screen owes its users
 * (REFERENCE.md §6: "Every data-driven screen needs all four states:
 * Loading / Empty / Error-with-retry / Populated"), generated per page ×
 * per role so a new page or role gets the full set by adding one config.
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, window, mountPage, settle, cleanup, text, click, $,
  assertNoRuntimeErrors, assertNoUnexpectedRequests, assertNoBrokenValues, assertNoStuckLoading,
  assertNoInjectedMarkup, assertAccessible, hasErrorState, findRetryButton, activeIntervalCount,
} from './render.mjs';

const LOADING = '.skeleton, [aria-busy="true"], .spinner, .loading-spinner, [role="status"][aria-label*="oading"]';

/** The page's own content area: AppShell's `.page-content`, or the root for shell-less pages. */
export function pageContent(root) {
  return root.querySelector('.page-content') ?? root;
}

function showsLoading(root) {
  const scope = pageContent(root);
  return !!scope.querySelector(LOADING) || /\bloading\b|checking|fetching/i.test(text(scope));
}

/** Records whether a loading indicator was EVER on screen, via a MutationObserver. */
function watchForLoading(root) {
  const state = { value: showsLoading(root) };
  const observer = new window.MutationObserver(() => { if (!state.value && showsLoading(root)) state.value = true; });
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
  state.stop = () => observer.disconnect();
  return state;
}

/**
 * @param {object} config
 * @param {string} config.name
 * @param {Function} config.render            the page's render*Page export
 * @param {string[]} config.roles             roles main.js lets onto this page
 * @param {*} [config.param]                  e.g. an incident id for detail pages
 * @param {string|RegExp} config.heading      expected PageHeader title
 * @param {string[]} [config.expectText]      fixture values that must appear once loaded
 * @param {(ctx) => Promise<void>} [config.openDataView]  navigate to the part of the page that loads data (e.g. a Settings section)
 * @param {string[]} [config.noDataFetchRoles] roles for which the default view fetches nothing (no loading/error state to check)
 * @param {boolean} [config.polls]            page returns a stop() handle that must clear its intervals
 */
export function describePage(config) {
  const { name, render, roles, param, heading, expectText = [], openDataView, noDataFetchRoles = [], polls = false } = config;

  describe(`${name} page`, () => {
    afterEach(() => cleanup());

    for (const role of roles) {
      const fetchesData = !noDataFetchRoles.includes(role);

      describe(`as ${role}`, () => {
        test('renders real data with no runtime errors, broken values or stuck loading', async () => {
          const ctx = mountPage(render, { role, param });
          await settle();
          if (openDataView) { await openDataView(ctx); await settle(); }
          assertNoRuntimeErrors();
          assertNoUnexpectedRequests();
          assertNoBrokenValues();
          assertNoStuckLoading();
          const title = text($('.page-header__title', ctx.root) ?? $('h1, h2', ctx.root));
          if (heading instanceof RegExp) assert.match(title, heading);
          else assert.ok(title.startsWith(heading), `page heading "${title}" should start with "${heading}"`);
          const body = text();
          for (const expected of expectText) assert.ok(body.includes(expected), `expected "${expected}" on the page`);
        });

        if (fetchesData) {
          test('shows a loading state while data is in flight', async () => {
            // Watch the page's OWN content (not the topbar, whose health
            // badge says "Checking…" on every screen) for any loading
            // indicator appearing at any point before the data lands.
            const seen = watchForLoading(window.document.getElementById('app'));
            const ctx = mountPage(render, { role, param });
            if (openDataView) await openDataView(ctx);
            await settle();
            seen.stop();
            assert.ok(seen.value, 'nothing in the page content told the user data was loading');
          });

          test('empty data renders an empty state, never an error', async () => {
            const ctx = mountPage(render, { role, param, scenario: 'empty' });
            await settle();
            if (openDataView) { await openDataView(ctx); await settle(); }
            assertNoRuntimeErrors();
            assertNoUnexpectedRequests();
            assertNoBrokenValues();
            assertNoStuckLoading();
            assert.equal(hasErrorState(pageContent(ctx.root)), false, 'an empty result was presented as an error');
          });

          test('a server failure shows an error state, and Retry recovers', async () => {
            const ctx = mountPage(render, { role, param, scenario: 'error' });
            await settle();
            if (openDataView) { await openDataView(ctx); await settle(); }
            assertNoRuntimeErrors({ allowConsoleErrors: true });
            assert.ok(hasErrorState(pageContent(ctx.root)), 'no error state shown after the server failed');
            const retry = findRetryButton(pageContent(ctx.root));
            assert.ok(retry, 'the error state has no Retry / Try again button');
            api.setScenario('populated');
            click(retry);
            await settle();
            assert.equal(hasErrorState(pageContent(ctx.root)), false, 'Retry did not recover once the server was healthy again');
            assertNoStuckLoading();
          });
        }

        test('untrusted text from the server is never rendered as markup', async () => {
          const ctx = mountPage(render, { role, param, scenario: 'xss' });
          await settle();
          if (openDataView) { await openDataView(ctx); await settle(); }
          assertNoRuntimeErrors();
          assertNoInjectedMarkup();
        });

        test('controls are labelled and named for assistive technology', async () => {
          const ctx = mountPage(render, { role, param });
          await settle();
          if (openDataView) { await openDataView(ctx); await settle(); }
          assertAccessible();
        });

        if (polls) {
          test('stop() clears the page\'s polling timers', async () => {
            const ctx = mountPage(render, { role, param });
            await settle();
            const before = activeIntervalCount();
            ctx.handle.stop();
            assert.ok(activeIntervalCount() < before, 'stop() left every interval running');
          });
        }
      });
    }
  });
}
