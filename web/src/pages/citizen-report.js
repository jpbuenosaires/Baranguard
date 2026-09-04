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
  card.classList.add('settings-column');

  page.appendChild(card);
  root.appendChild(page);

  load();

  async function load() {
    card.innerHTML = '<div class="state-block" role="status" aria-label="Loading"><div class="skeleton skeleton--line"></div><div class="skeleton skeleton--block"></div></div>';
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
    <div class="citizen-report__brand">
      <span class="icon-badge icon-badge--brand">${icons.megaphone(20)}</span>
      <span class="citizen-report__wordmark">BARANGUARD</span>
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
  descriptionInput.classList.add('textarea--resizable');

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
  locationRow.classList.add('row-start');
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
  privacyNotice.classList.add('privacy-notice');
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
    <span class="icon-badge icon-badge--kpi icon-badge--success accent-green">${icons.checkCircle(28)}</span>
    <h3>Report received</h3>
    <p>Keep this reference number. It is how the barangay can find your report.</p>
  `;

  // audit W19: the reference used to sit as plain text inside a sentence —
  // the citizen's only proof they filed anything, to be transcribed by
  // hand off a phone screen. It gets its own line and a copy button.
  const referenceRow = document.createElement('div');
  referenceRow.className = 'citizen-report__reference-row';
  const reference = document.createElement('span');
  reference.className = 'citizen-report__reference';
  reference.textContent = `#${reportId}`;
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'ghost';
  copyButton.textContent = 'Copy';
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`#${reportId}`);
      copyButton.textContent = 'Copied';
      setTimeout(() => { copyButton.textContent = 'Copy'; }, 2000);
    } catch {
      // Clipboard access can be refused (no permission, or a non-secure
      // origin — likely on a LAN address). Selecting the number is the
      // fallback that always works, so say so rather than failing quietly.
      copyButton.textContent = 'Select it above';
    }
  });
  referenceRow.append(reference, copyButton);
  block.appendChild(referenceRow);

  // audit W19: the success state confirmed receipt but said nothing about
  // what happens next — which is what stops a worried reporter filing the
  // same thing three times.
  const next = document.createElement('p');
  next.className = 'note';
  next.textContent = 'A barangay officer will review this report. There is no automatic SMS confirmation yet, so please do not submit it again — if you left a contact number, the barangay will reach you on it.';
  block.appendChild(next);

  card.appendChild(block);
}
