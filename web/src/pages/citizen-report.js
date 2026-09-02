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
 *   - **The four barangays are hardcoded here.** §6 never documents a
 *     `GET /barangays` (or similar) endpoint anywhere, and §5 states the
 *     four rows are deterministic/fixed/"never regenerated" — matching
 *     `migrations/0002_seed_barangays.sql` exactly (Dao=1,
 *     Binanuahan=2, Marifosque=3, Banuyo=4) is the only way this public,
 *     unauthenticated form can offer a barangay choice at all without
 *     inventing a new endpoint outside this sprint's scope.
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

import { submitCitizenReport, ApiClientError } from '../api/apiClient.js';
import { icons } from '../components/icons.js';

const BARANGAYS = [
  { id: 1, name: 'Dao' },
  { id: 2, name: 'Binanuahan' },
  { id: 3, name: 'Marifosque' },
  { id: 4, name: 'Banuyo' },
];

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

  renderForm(card);
}

function renderForm(card) {
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
  form.style.cssText = 'display:flex; flex-direction:column; gap:12px;';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.hidden = true;

  const barangayLabel = document.createElement('label');
  barangayLabel.className = 'label';
  barangayLabel.textContent = 'Barangay';
  const barangaySelect = document.createElement('select');
  for (const b of BARANGAYS) {
    const option = document.createElement('option');
    option.value = String(b.id);
    option.textContent = b.name;
    barangaySelect.appendChild(option);
  }

  const descriptionLabel = document.createElement('label');
  descriptionLabel.className = 'label';
  descriptionLabel.textContent = 'What happened?';
  const descriptionInput = document.createElement('textarea');
  descriptionInput.rows = 5;
  descriptionInput.required = true;
  descriptionInput.placeholder = 'Describe what you saw or experienced, and where';
  descriptionInput.style.cssText = 'width:100%; font-family:inherit; font-size:0.875rem; padding:8px 16px; border:1px solid var(--color-border); border-radius:10px; resize:vertical;';

  const contactLabel = document.createElement('label');
  contactLabel.className = 'label';
  contactLabel.textContent = 'Contact number (optional)';
  const contactInput = document.createElement('input');
  contactInput.type = 'text';
  contactInput.placeholder = 'So the barangay can follow up with you';

  let coords = null;
  const locationRow = document.createElement('div');
  locationRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
  const locationButton = document.createElement('button');
  locationButton.type = 'button';
  locationButton.className = 'ghost';
  locationButton.textContent = 'Share my current location (optional)';
  const locationStatus = document.createElement('span');
  locationStatus.className = 'label';
  locationStatus.style.cssText = 'text-transform:none; font-weight:400;';
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
  privacyNotice.className = 'label';
  privacyNotice.style.cssText = 'text-transform:none; font-weight:400; line-height:1.5;';
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
