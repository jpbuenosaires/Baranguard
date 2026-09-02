/**
 * blotter-list.js — W6 Electronic Blotter List (§9): "Server-provided
 * redacted excerpt only. New-entry form derives source server-side."
 * Roles: Admin, Secretary (full — list + new-entry form), Punong Barangay
 * (redacted/read-only — list only, no new-entry form per §7 "Web-side
 * incident entry": PB has no access to that action).
 *
 * The list reuses `GET /incidents` (already built for W3's dispatch
 * queue) with no status filter — a blotter ledger shows every incident,
 * not just pending ones. Only the same redacted item shape W3 already
 * gets (no raw_narrative — that's Secretary-only, via a different,
 * unbuilt detail endpoint) — matches "Server-provided redacted excerpt
 * only" exactly.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { getIncidents, createIncident, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { icons } from '../components/icons.js';

const INCIDENT_TYPE_LABELS = {
  theft: 'Theft', physical_injury: 'Physical Injury', disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute', vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident', fire: 'Fire',
  medical_emergency: 'Medical Emergency', missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint', other: 'Other',
};
const STATUS_PILL_CLASS = { pending: 'status-pill--pending', dispatched: 'status-pill--info', resolved: 'status-pill--success' };

/**
 * @param {HTMLElement} root
 * @param {{fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 */
export function renderBlotterListPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const canCreate = user.role === 'admin' || user.role === 'secretary';

  const shell = AppShell(user, 'blotter', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { content } = shell;
  root.appendChild(shell.el);

  content.innerHTML = `<h2 style="margin-bottom:16px; display:flex; align-items:center; gap:10px;">${icons.fileText(22)}Electronic Blotter</h2>`;

  const layout = document.createElement('div');
  layout.style.cssText = canCreate ? 'display:grid; grid-template-columns: 1fr 360px; gap:16px; align-items:start;' : '';
  content.appendChild(layout);

  const listPane = document.createElement('div');
  layout.appendChild(listPane);

  let formPane = null;
  if (canCreate) {
    formPane = buildNewEntryForm(() => load());
    layout.appendChild(formPane);
  }

  load();

  async function load() {
    renderLoading(listPane);
    try {
      const result = await getIncidents({ limit: 100 });
      if (result.items.length === 0) {
        renderEmpty(listPane);
      } else {
        renderList(listPane, result.items);
      }
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading the blotter.';
      renderError(listPane, message, load);
    }
  }
}

function buildNewEntryForm(onCreated) {
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h3');
  heading.textContent = 'New Entry';
  heading.style.marginBottom = '16px';

  const form = document.createElement('form');
  form.style.cssText = 'display:flex; flex-direction:column; gap:12px;';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.hidden = true;

  const typeLabel = document.createElement('label');
  typeLabel.className = 'label';
  typeLabel.textContent = 'Incident Type';
  const typeSelect = document.createElement('select');
  for (const [value, label] of Object.entries(INCIDENT_TYPE_LABELS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    typeSelect.appendChild(option);
  }

  const narrativeLabel = document.createElement('label');
  narrativeLabel.className = 'label';
  narrativeLabel.textContent = 'Narrative';
  const narrativeInput = document.createElement('textarea');
  narrativeInput.rows = 5;
  narrativeInput.required = true;
  narrativeInput.style.cssText = 'width:100%; font-family:inherit; font-size:0.875rem; padding:8px 16px; border:1px solid var(--color-border); border-radius:10px; resize:vertical;';

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.textContent = 'Log Entry';

  form.append(errorBox, typeLabel, typeSelect, narrativeLabel, narrativeInput, submitButton);
  card.append(heading, form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const rawNarrative = narrativeInput.value.trim();
    if (!rawNarrative) {
      errorBox.textContent = 'Enter a narrative for this entry.';
      errorBox.hidden = false;
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Logging…';
    try {
      await createIncident({
        incidentType: typeSelect.value,
        rawNarrative,
        idempotencyKey: crypto.randomUUID(),
      });
      narrativeInput.value = '';
      typeSelect.selectedIndex = 0;
      onCreated();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not log this entry.';
      errorBox.textContent = message;
      errorBox.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Log Entry';
    }
  });

  return card;
}

function renderList(container, items) {
  container.innerHTML = '';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  for (const incident of items) {
    const row = document.createElement('div');
    row.className = 'card';
    row.style.padding = '16px';
    const pillClass = STATUS_PILL_CLASS[incident.status] || 'status-pill--neutral';
    row.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <strong>${INCIDENT_TYPE_LABELS[incident.incidentType] || incident.incidentType}</strong>
        <span class="status-pill ${pillClass}">${incident.status}</span>
      </div>
      <div class="label" style="text-transform:none; font-weight:400;">
        Incident #${incident.incidentId} · ${new Date(incident.createdAt).toLocaleString()} · source: ${incident.source}
      </div>
    `;
    list.appendChild(row);
  }
  container.appendChild(list);
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  for (let i = 0; i < 4; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.style.cssText = 'height:64px; border-radius:12px;';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

function renderEmpty(container) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block';
  block.innerHTML = `
    <h3>No blotter entries yet</h3>
    <p>Once incidents are logged, they'll appear here as a running blotter ledger.</p>
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
