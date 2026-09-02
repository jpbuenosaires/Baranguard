/**
 * citizen-reports-inbox.js — W16 Citizen Reports Inbox, list only (§9):
 * "Displays contact/description only as permitted. Conversion is
 * disabled once converted and is idempotent on retries." This cut is
 * explicitly "list only" per Sprint_Prompts.md's own checklist entry —
 * `POST /citizen-reports/:id/convert` is a separate, unbuilt endpoint, so
 * there's no convert action/button here yet. Roles: Secretary, Admin
 * (§7 "View citizen report inbox").
 *
 * Shows the unconverted queue (`?status=unconverted`) — the actionable
 * "inbox" set, not a historical log of every report ever submitted.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getCitizenReports, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { icons } from '../components/icons.js';

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 */
export function renderCitizenReportsInboxPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'citizen-inbox', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { content } = shell;
  root.appendChild(shell.el);

  content.innerHTML = `<h2 style="margin-bottom:16px; display:flex; align-items:center; gap:10px;">${icons.inbox(22)}Citizen Reports</h2>`;
  const body = document.createElement('div');
  content.appendChild(body);

  load();

  async function load() {
    renderLoading(body);
    try {
      const result = await getCitizenReports({ status: 'unconverted', limit: 100 });
      if (result.items.length === 0) {
        renderEmpty(body);
      } else {
        renderList(body, result.items);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading citizen reports.';
      renderError(body, message, load);
    }
  }
}

function renderList(container, items) {
  container.innerHTML = '';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  for (const report of items) {
    const row = document.createElement('div');
    row.className = 'card';
    row.style.padding = '16px';
    const contactLine = report.contactNumber
      ? `<div class="label" style="text-transform:none; font-weight:400; margin-top:4px;">Contact: ${escapeHtml(report.contactNumber)}</div>`
      : '';
    row.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <strong>Report #${report.reportId}</strong>
        <span class="status-pill status-pill--pending">Unconverted</span>
      </div>
      <p style="margin-top:8px;">${escapeHtml(report.description)}</p>
      ${contactLine}
      <div class="label" style="text-transform:none; font-weight:400; margin-top:4px;">${new Date(report.submittedAt).toLocaleString()}</div>
    `;
    list.appendChild(row);
  }
  container.appendChild(list);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  for (let i = 0; i < 3; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.style.cssText = 'height:96px; border-radius:12px;';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

function renderEmpty(container) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = `
    <h3>Inbox is empty</h3>
    <p>No unconverted citizen reports right now. New public submissions will appear here.</p>
  `;
  container.appendChild(block);
}

function renderError(container, message, onRetry) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block state-block--error';
  const text = document.createElement('p');
  text.textContent = message;
  const retryButton = document.createElement('button');
  retryButton.className = 'primary';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}
