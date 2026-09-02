/**
 * citizen-report.js — W19 Public Citizen Report (§9): "Public form with
 * one of four barangays, description, optional contact/location,
 * rate-limit messaging, privacy notice, success confirmation, and
 * non-sensitive reference number. No internal role/account information
 * is exposed." Roles: Public — no session, no AppShell (this isn't an
 * authenticated screen, so it doesn't share the sidebar/topbar nav shell
 * the rest of the dashboard uses).
 *
 * Resolved decisions, logged in DEVLOG.md:
 *   - **Barangays come from `GET /barangays`** (added 2026-09-02
 *     architecture review — §6 "Reference / lookup"), not a hardcoded
 *     array — §8's production-realism rule: every barangay a screen
 *     offers must come from the real table, not a literal list in a
 *     component file. Public, no auth, matching this screen's own
 *     pre-auth reachability.
 *   - **Reachability.** This app has no bundler/URL router (§1) and no
 *     server-side rewrite configured for the static `web/` folder — so
 *     rather than requiring a new server path, this screen is reached via
 *     a hash fragment (`#/citizen-report`) on the same `index.html`,
 *     checked by `main.js` before its normal session-gated boot() runs.
 *     Hash fragments never hit the server, so this works identically
 *     under the PHP built-in server, Apache, or any static host with zero
 *     rewrite configuration.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { submitCitizenReport, getBarangays, ApiClientError } from '../api/apiClient.js';
import { icons } from '../components/icons.js';

/** @param {HTMLElement} root */
export function renderCitizenReportPage(root) {
  root.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'login-page';

  const card = document.createElement('div');
  card.className = 'card login-card';
  card.style.maxWidth = '480px';

  page.appendChild(card);
  root.appendChild(page);

  load();

  async function load() {
    card.innerHTML = '<div class="state-block" role="status" aria-label="Loading"><div class="skeleton" style="height:20px;width:60%;"></div><div class="skeleton" style="height:120px;width:100%;"></div></div>';
    try {
      const barangays = await getBarangays();
      renderForm(card, barangays);
    } catch (err) {
      card.innerHTML = '';
      const block = document.createElement('div');
      block.className = 'state-block state-block--error';
      block.setAttribute('role', 'alert');
      const text = document.createElement('p');
      text.textContent = err instanceof ApiClientError ? err.message : 'Could not load this form. Please try again.';
      const retryButton = document.createElement('button');
      retryButton.className = 'primary';
      retryButton.textContent = 'Retry';
      retryButton.addEventListener('click', load);
      block.append(text, retryButton);
      card.appendChild(block);
    }
  }
}

function renderForm(card, barangays) {
  card.innerHTML = '';

  const brand = document.createElement('div');
  brand.className = 'login-card__brand';
  brand.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:center; gap:10px; margin-bottom:8px;">
      <span class="icon-badge icon-badge--brand">${icons.megaphone(20)}</span>
      <span style="font-weight:700; font-size:1.1rem;">BARANGUARD</span>
    </div>
    <h2>Report an Incident</h2>
    <p>Tell your barangay what's happening — no account needed</p>
  `;

  const form = document.createElement('form');
  form.className = 'form-stack';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  const barangayLabel = document.createElement('label');
  barangayLabel.className = 'label';
  barangayLabel.htmlFor = 'citizen-report-barangay';
  barangayLabel.textContent = 'Barangay';
  const barangaySelect = document.createElement('select');
  barangaySelect.id = 'citizen-report-barangay';
  for (const b of barangays) {
    const option = document.createElement('option');
    option.value = String(b.barangayId);
    option.textContent = b.name;
    barangaySelect.appendChild(option);
  }

  const descriptionLabel = document.createElement('label');
  descriptionLabel.className = 'label';
  descriptionLabel.htmlFor = 'citizen-report-description';
  descriptionLabel.textContent = 'What happened?';
  const descriptionInput = document.createElement('textarea');
  descriptionInput.id = 'citizen-report-description';
  descriptionInput.rows = 5;
  descriptionInput.required = true;
  descriptionInput.placeholder = 'Describe what you saw or experienced, and where';
  descriptionInput.style.resize = 'vertical';

  const contactLabel = document.createElement('label');
  contactLabel.className = 'label';
  contactLabel.htmlFor = 'citizen-report-contact';
  contactLabel.textContent = 'Contact number (optional)';
  const contactInput = document.createElement('input');
  contactInput.id = 'citizen-report-contact';
  contactInput.type = 'text';
  contactInput.placeholder = 'So the barangay can follow up with you';

  let coords = null;
  const locationRow = document.createElement('div');
  locationRow.className = 'row-between';
  locationRow.style.justifyContent = 'flex-start';
  const locationButton = document.createElement('button');
  locationButton.type = 'button';
  locationButton.className = 'ghost';
  locationButton.textContent = 'Share my current location (optional)';
  const locationStatus = document.createElement('span');
  locationStatus.className = 'note';
  locationStatus.setAttribute('aria-live', 'polite');
  locationButton.addEventListener('click', () => {
    if (!navigator.geolocation) {
      locationStatus.textContent = 'Location is not available on this device.';
      return;
    }
    locationStatus.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (position) => {
        coords = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        locationStatus.textContent = 'Location added.';
      },
      () => {
        locationStatus.textContent = 'Could not get your location.';
      },
      { timeout: 10000 }
    );
  });
  locationRow.append(locationButton, locationStatus);

  const privacyNotice = document.createElement('p');
  privacyNotice.className = 'note';
  privacyNotice.style.lineHeight = '1.5';
  privacyNotice.textContent = 'Your report is sent directly to your barangay for review. Only barangay officials can see the details you submit here.';

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.textContent = 'Submit Report';

  form.append(
    errorBox,
    barangayLabel, barangaySelect,
    descriptionLabel, descriptionInput,
    contactLabel, contactInput,
    locationRow,
    privacyNotice,
    submitButton
  );
  card.append(brand, form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const description = descriptionInput.value.trim();
    if (!description) {
      errorBox.textContent = 'Please describe what happened.';
      errorBox.hidden = false;
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Submitting…';
    try {
      const result = await submitCitizenReport({
        barangayId: Number(barangaySelect.value),
        description,
        contactNumber: contactInput.value.trim() || undefined,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
      });
      renderSuccess(card, result.reportId);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'RATE_LIMITED') {
        errorBox.textContent = 'You have submitted several reports recently. Please wait a while before submitting another.';
      } else {
        errorBox.textContent = err instanceof ApiClientError ? err.message : 'Something went wrong submitting your report.';
      }
      errorBox.hidden = false;
      submitButton.disabled = false;
      submitButton.textContent = 'Submit Report';
    }
  });
}

function renderSuccess(card, reportId) {
  card.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'state-block';
  block.innerHTML = `
    <span class="icon-badge icon-badge--kpi accent-green" style="width:56px;height:56px;">${icons.checkCircle(28)}</span>
    <h3>Report received</h3>
    <p>Your reference number is <strong>#${reportId}</strong>. Keep it for your records — your barangay will follow up if you provided a contact number.</p>
  `;
  card.appendChild(block);
}
