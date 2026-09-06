/**
 * citizen-report.js — Public Citizen Report Intake Portal (§9 W19)
 * Civic service intake screen with professional branding, emergency guidance,
 * quick topic chips, GPS location capture, character counting, and a digital ticket receipt.
 *
 * Roles: Public — no session, no AppShell.
 * Reachable via `#/citizen-report` hash fragment on index.html.
 */

import { submitCitizenReport, getBarangays, ApiClientError } from '../api/apiClient.js';
import { icons } from '../components/icons.js';

const QUICK_TOPICS = [
  { label: '🚨 Emergency', tag: '[Emergency]' },
  { label: '🔥 Fire / Smoke', tag: '[Fire / Smoke Hazard]' },
  { label: '🚗 Traffic / Road', tag: '[Traffic / Road Issue]' },
  { label: '🔊 Disturbance', tag: '[Noise / Disturbance]' },
  { label: '💧 Flood / Drainage', tag: '[Flood / Drainage]' },
  { label: '🛡️ Suspicious Activity', tag: '[Suspicious Activity]' },
];

const MAX_DESCRIPTION_LENGTH = 2000;

/** @param {HTMLElement} root */
export function renderCitizenReportPage(root) {
  root.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'citizen-portal-page';

  const card = document.createElement('div');
  card.className = 'citizen-portal-card';

  page.appendChild(card);
  root.appendChild(page);

  load();

  async function load() {
    card.innerHTML = `
      <div class="state-block" role="status" aria-label="Loading form">
        <div class="skeleton skeleton--line" style="width: 50%; margin: 0 auto 1rem;"></div>
        <div class="skeleton skeleton--block" style="height: 12rem;"></div>
      </div>
    `;
    try {
      const barangays = await getBarangays();
      renderForm(card, barangays, load);
    } catch (err) {
      card.innerHTML = '';
      const block = document.createElement('div');
      block.className = 'state-block state-block--error';
      block.setAttribute('role', 'alert');
      const text = document.createElement('p');
      text.textContent = err instanceof ApiClientError ? err.message : 'Could not load the incident report form. Please try again.';
      const retryButton = document.createElement('button');
      retryButton.className = 'primary';
      retryButton.textContent = 'Retry';
      retryButton.addEventListener('click', load);
      block.append(text, retryButton);
      card.appendChild(block);
    }
  }
}

function renderForm(card, barangays, onReset) {
  card.innerHTML = '';

  // Header / Branding
  const header = document.createElement('div');
  header.className = 'citizen-portal-header';
  header.innerHTML = `
    <div class="citizen-portal-brand">
      <div class="citizen-portal-badge">${icons.shield(22)}</div>
      <span class="citizen-portal-wordmark">BARANGUARD</span>
    </div>
    <h1 class="citizen-portal-title">Public Incident Report</h1>
    <p class="citizen-portal-subtitle">Direct community incident and hazard intake for your barangay. No account required.</p>
  `;

  // Life Threat Emergency Alert Banner
  const emergencyBanner = document.createElement('div');
  emergencyBanner.className = 'citizen-emergency-banner';
  emergencyBanner.innerHTML = `
    ${icons.alertTriangle(20)}
    <div>
      <strong>Life-threatening emergency?</strong> Please call <strong>911</strong> or your local emergency hotline immediately. This web portal is monitored for standard barangay operations intake.
    </div>
  `;

  // Form
  const form = document.createElement('form');
  form.className = 'form-stack';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  // Quick Topic Chips
  const topicGroup = document.createElement('div');
  topicGroup.className = 'citizen-topic-group';

  const topicLabel = document.createElement('span');
  topicLabel.className = 'citizen-topic-label';
  topicLabel.textContent = 'Quick Topic (Tap to structure your report)';

  const topicChips = document.createElement('div');
  topicChips.className = 'citizen-topic-chips';

  let selectedTopicTag = null;

  // Barangay Selector
  const barangayLabel = document.createElement('label');
  barangayLabel.className = 'label';
  barangayLabel.htmlFor = 'citizen-report-barangay';
  barangayLabel.textContent = 'Target Barangay';

  const barangaySelect = document.createElement('select');
  barangaySelect.id = 'citizen-report-barangay';
  for (const b of barangays) {
    const option = document.createElement('option');
    option.value = String(b.barangayId);
    option.textContent = b.name;
    barangaySelect.appendChild(option);
  }

  // Description Textarea with Character Counter
  const descriptionWrap = document.createElement('div');
  descriptionWrap.className = 'citizen-textarea-wrap';

  const descriptionLabel = document.createElement('label');
  descriptionLabel.className = 'label';
  descriptionLabel.htmlFor = 'citizen-report-description';
  descriptionLabel.textContent = 'What happened & location details';

  const descriptionInput = document.createElement('textarea');
  descriptionInput.id = 'citizen-report-description';
  descriptionInput.rows = 5;
  descriptionInput.required = true;
  descriptionInput.maxLength = MAX_DESCRIPTION_LENGTH;
  descriptionInput.placeholder = 'Describe the incident, exact location or landmarks, individuals involved, and any immediate hazards…';
  descriptionInput.classList.add('textarea--resizable');

  const charCounter = document.createElement('div');
  charCounter.className = 'citizen-char-counter';
  charCounter.textContent = `0 / ${MAX_DESCRIPTION_LENGTH} characters`;

  descriptionInput.addEventListener('input', () => {
    const len = descriptionInput.value.length;
    charCounter.textContent = `${len.toLocaleString()} / ${MAX_DESCRIPTION_LENGTH.toLocaleString()} characters`;
    if (len >= MAX_DESCRIPTION_LENGTH) {
      charCounter.style.color = 'var(--color-critical)';
    } else {
      charCounter.style.color = 'var(--color-text-tertiary)';
    }
  });

  // Wire Quick Topic buttons
  QUICK_TOPICS.forEach(({ label, tag }) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'citizen-topic-chip';
    chip.textContent = label;

    chip.addEventListener('click', () => {
      const currentVal = descriptionInput.value;
      if (selectedTopicTag === tag) {
        // Unselect
        selectedTopicTag = null;
        chip.classList.remove('is-selected');
        if (currentVal.startsWith(tag + ' ')) {
          descriptionInput.value = currentVal.substring(tag.length + 1);
        }
      } else {
        // Select this chip
        topicChips.querySelectorAll('.citizen-topic-chip').forEach((c) => c.classList.remove('is-selected'));
        chip.classList.add('is-selected');

        if (selectedTopicTag && currentVal.startsWith(selectedTopicTag + ' ')) {
          descriptionInput.value = `${tag} ${currentVal.substring(selectedTopicTag.length + 1)}`;
        } else if (!currentVal.includes(tag)) {
          descriptionInput.value = `${tag} ${currentVal}`.trim();
        }
        selectedTopicTag = tag;
      }
      descriptionInput.dispatchEvent(new Event('input'));
      descriptionInput.focus();
    });

    topicChips.appendChild(chip);
  });

  topicGroup.append(topicLabel, topicChips);
  descriptionWrap.append(descriptionLabel, descriptionInput, charCounter);

  // Contact Number (Optional)
  const contactLabel = document.createElement('label');
  contactLabel.className = 'label';
  contactLabel.htmlFor = 'citizen-report-contact';
  contactLabel.textContent = 'Contact Number (Optional)';

  const contactInput = document.createElement('input');
  contactInput.id = 'citizen-report-contact';
  contactInput.type = 'tel';
  contactInput.placeholder = 'e.g. 0917-123-4567 — so desk officers can follow up or verify';

  // GPS Location Sharing Component
  let coords = null;

  const gpsBox = document.createElement('div');
  gpsBox.className = 'citizen-gps-box';

  const gpsBtn = document.createElement('button');
  gpsBtn.type = 'button';
  gpsBtn.className = 'citizen-gps-btn';
  gpsBtn.innerHTML = `${icons.mapPin(16)} Share Current GPS Location`;

  const gpsStatus = document.createElement('span');
  gpsStatus.className = 'citizen-gps-status';
  gpsStatus.textContent = 'No GPS location attached (optional)';
  gpsStatus.setAttribute('aria-live', 'polite');

  gpsBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      gpsStatus.textContent = 'Geolocation is not supported on this browser.';
      return;
    }

    gpsBtn.disabled = true;
    gpsStatus.textContent = 'Acquiring GPS location…';

    navigator.geolocation.getCurrentPosition(
      (position) => {
        coords = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        gpsBox.classList.add('has-location');
        gpsBtn.disabled = false;
        gpsBtn.innerHTML = `${icons.checkCircle(16)} Location Attached`;
        gpsStatus.innerHTML = `<span>📍 ${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}</span>`;
      },
      (error) => {
        gpsBtn.disabled = false;
        coords = null;
        gpsBox.classList.remove('has-location');
        gpsBtn.innerHTML = `${icons.mapPin(16)} Try GPS Again`;
        let msg = 'Could not acquire location.';
        if (error.code === error.PERMISSION_DENIED) {
          msg = 'Location permission was denied.';
        } else if (error.code === error.TIMEOUT) {
          msg = 'Location request timed out.';
        }
        gpsStatus.textContent = msg;
      },
      { timeout: 12000, enableHighAccuracy: true }
    );
  });

  gpsBox.append(gpsBtn, gpsStatus);

  // Data Privacy Assurance
  const privacyNotice = document.createElement('p');
  privacyNotice.className = 'note privacy-notice';
  privacyNotice.innerHTML = `
    <strong>🔒 Data Privacy Assurance (RA 10173):</strong> Your submission is forwarded directly to your barangay operations desk. Personal details are accessible only by authorized desk officers and tanods for incident resolution.
  `;

  // Submit Button
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.style.padding = '0.75rem 1.25rem';
  submitButton.style.fontSize = 'var(--font-size-md)';
  submitButton.style.fontWeight = '700';
  submitButton.textContent = 'Submit Official Incident Report';

  form.append(
    errorBox,
    topicGroup,
    barangayLabel,
    barangaySelect,
    descriptionWrap,
    contactLabel,
    contactInput,
    gpsBox,
    privacyNotice,
    submitButton
  );

  card.append(header, emergencyBanner, form);

  // Submit Handler
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const description = descriptionInput.value.trim();
    if (!description) {
      errorBox.textContent = 'Please provide details describing what happened.';
      errorBox.hidden = false;
      descriptionInput.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Submitting report to barangay…';

    try {
      const result = await submitCitizenReport({
        barangayId: Number(barangaySelect.value),
        description,
        contactNumber: contactInput.value.trim() || undefined,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
      });
      renderSuccess(card, result.reportId, barangaySelect.options[barangaySelect.selectedIndex]?.text, onReset);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'RATE_LIMITED') {
        errorBox.textContent = 'You have submitted several reports recently. Please wait a few minutes before submitting another.';
      } else {
        errorBox.textContent = err instanceof ApiClientError ? err.message : 'Something went wrong submitting your report. Please try again.';
      }
      errorBox.hidden = false;
      submitButton.disabled = false;
      submitButton.textContent = 'Submit Official Incident Report';
    }
  });
}

function renderSuccess(card, reportId, barangayName, onReset) {
  card.innerHTML = '';

  const block = document.createElement('div');
  block.className = 'state-block';
  block.style.gap = 'var(--spacing-md)';

  const iconBadge = document.createElement('div');
  iconBadge.className = 'citizen-portal-badge';
  iconBadge.style.background = 'var(--color-success)';
  iconBadge.style.margin = '0 auto';
  iconBadge.innerHTML = icons.checkCircle(28);

  const title = document.createElement('h2');
  title.className = 'citizen-portal-title';
  title.style.fontSize = '1.375rem';
  title.textContent = 'Report Successfully Received';

  const subtitle = document.createElement('p');
  subtitle.className = 'citizen-portal-subtitle';
  subtitle.textContent = `Your report has been logged with ${barangayName || 'your barangay'} operations desk.`;

  // Digital Ticket Receipt Box
  const receiptBox = document.createElement('div');
  receiptBox.className = 'citizen-receipt-box';
  receiptBox.innerHTML = `
    <span class="citizen-detail-meta-label">Reference Number</span>
    <span class="citizen-receipt-number">#REF-${reportId}</span>
    <p class="note" style="margin: 0;">Save this number to reference your report with barangay officials.</p>
  `;

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'ghost';
  copyButton.innerHTML = `${icons.copy(16)} Copy Reference Number`;
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`#REF-${reportId}`);
      copyButton.textContent = 'Copied to Clipboard!';
      setTimeout(() => {
        copyButton.innerHTML = `${icons.copy(16)} Copy Reference Number`;
      }, 2500);
    } catch {
      copyButton.textContent = 'Select and copy above';
    }
  });
  receiptBox.appendChild(copyButton);

  // 3-Step Next Steps Timeline
  const nextSteps = document.createElement('div');
  nextSteps.className = 'citizen-next-steps';
  nextSteps.innerHTML = `
    <h4 style="font-size: var(--font-size-sm); font-weight: 700; margin: 0; color: var(--color-text-primary);">What Happens Next:</h4>
    <div class="citizen-step-row">
      <div class="citizen-step-bullet">1</div>
      <div><strong>Logged & Queued:</strong> Your report is now in the desk officer's triage inbox.</div>
    </div>
    <div class="citizen-step-row">
      <div class="citizen-step-bullet">2</div>
      <div><strong>Triage Review:</strong> A duty officer evaluates severity, category, and potential hazard.</div>
    </div>
    <div class="citizen-step-row">
      <div class="citizen-step-bullet">3</div>
      <div><strong>Tanod Coordination:</strong> Responders or patrol units are dispatched if on-site intervention is necessary.</div>
    </div>
  `;

  // This is the real workflow this report enters, but it is reviewed by a
  // person opening the Citizen Reports Inbox, not an automated pipeline
  // with a guaranteed response time — the note below says so plainly,
  // and heads off a duplicate submission that would count against the
  // rate limit (RATE_LIMIT_MAX_ATTEMPTS/WINDOW_MINUTES, currently 3 per 15
  // minutes) for no benefit.
  const followUpNote = document.createElement('p');
  followUpNote.className = 'note';
  followUpNote.style.marginTop = 'var(--spacing-sm)';
  followUpNote.textContent = 'There is no automatic confirmation once a desk officer reviews this — please do not submit it again. If you left a contact number, the barangay will reach you on it.';

  // Submit another button
  const returnButton = document.createElement('button');
  returnButton.type = 'button';
  returnButton.className = 'primary';
  returnButton.style.marginTop = 'var(--spacing-md)';
  returnButton.textContent = 'Submit Another Report';
  returnButton.addEventListener('click', () => {
    onReset();
  });

  block.append(iconBadge, title, subtitle, receiptBox, nextSteps, followUpNote, returnButton);
  card.appendChild(block);
}
