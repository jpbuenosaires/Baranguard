/**
 * settings.js — W15 Settings/Account (§9), restyled in Phase 7 of the
 * mockup-driven UI round 2 (see .claude/plans/clever-wishing-hummingbird.md)
 * to the mockup's section-rail + panel layout. Only W15's REAL, already-
 * built fields moved into it: Profile, Password, Appearance. The
 * mockup's system-wide sections (notification rules, security policy, GIS
 * parameters, SMS gateway credentials, backups) are W21 — "no sprint
 * assignment, schema, or endpoints" per the Master Reference — and are
 * not built or shown here; see the plan's own substitution table.
 *
 * Resolved decision, logged in DEVLOG.md: §6 has no "GET /users/me" or
 * profile-read endpoint at all — self profile data is whatever the login
 * response already put in the session (`full_name`, `role`; no
 * `username`/`contact_number`). So this page can prefill and display
 * `full_name`, but the contact-number field is a blind "type a new value
 * to change it, leave blank to keep the current one" input.
 *
 * Appearance section: the theme toggle moves HERE (the topbar toggle
 * stays too — both control the same `localStorage` value, same precedent
 * as any duplicate control reading shared state) plus a real "Default
 * landing page" preference that `main.js`'s `boot()` actually reads. "Date
 * format" was in the mockup but deliberately NOT built — this app has no
 * shared date-formatting helper and no other screen honours a per-user
 * format, so the control would change nothing anywhere: exactly the kind
 * of decorative-does-nothing control §8 forbids. Real scope only.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { updateProfile, changePassword, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { icons } from '../components/icons.js';

const ROLE_LABELS = { admin: 'Admin', secretary: 'Secretary', punong_barangay: 'Punong Barangay', tanod: 'Tanod' };

const THEME_KEY = 'baranguard.theme';
export const DEFAULT_PAGE_KEY = 'baranguard.defaultPage';

const SECTIONS = [
  { key: 'profile', label: 'Profile', icon: icons.users },
  { key: 'password', label: 'Password', icon: icons.lock },
  { key: 'appearance', label: 'Appearance', icon: icons.settings },
];

/**
 * @param {HTMLElement} root
 * @param {{userId:number, fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string) => void} navigate
 */
export function renderSettingsPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'settings', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({ title: 'Settings', subtitle: 'Manage your profile, password, and display preferences', icon: icons.settings });
  header.appendChild(pageHeader.el);

  const layout = document.createElement('div');
  layout.className = 'settings-layout';
  content.appendChild(layout);

  const rail = document.createElement('nav');
  rail.className = 'settings-rail';
  rail.setAttribute('aria-label', 'Settings sections');

  const panel = document.createElement('div');
  panel.className = 'settings-panel';

  let activeSection = 'profile';
  const railButtons = {};
  for (const section of SECTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-rail__item';
    button.innerHTML = `<span class="settings-rail__icon" aria-hidden="true">${section.icon(18)}</span><span>${section.label}</span>`;
    button.addEventListener('click', () => { activeSection = section.key; renderPanel(); syncRail(); });
    railButtons[section.key] = button;
    rail.appendChild(button);
  }
  function syncRail() {
    for (const [key, button] of Object.entries(railButtons)) {
      const active = key === activeSection;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    }
  }
  syncRail();

  function renderPanel() {
    panel.innerHTML = '';
    if (activeSection === 'profile') panel.appendChild(buildProfileCard(user, shell.setFullName));
    else if (activeSection === 'password') panel.appendChild(buildPasswordCard());
    else panel.appendChild(buildAppearanceCard(user.role));
  }
  renderPanel();

  layout.append(rail, panel);
}

function buildProfileCard(user, onFullNameSaved) {
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h3');
  heading.textContent = 'Profile';

  const roleLine = document.createElement('p');
  roleLine.className = 'note';
  roleLine.classList.add('settings-role-line');
  roleLine.textContent = `Role: ${ROLE_LABELS[user.role] || user.role}`;

  const form = document.createElement('form');
  form.className = 'form-stack';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;
  const successBox = document.createElement('div');
  successBox.className = 'login-form__error';
  successBox.setAttribute('role', 'status');
  successBox.classList.add('inline-success');
  successBox.hidden = true;

  const nameLabel = document.createElement('label');
  nameLabel.className = 'label';
  nameLabel.htmlFor = 'settings-fullname';
  nameLabel.textContent = 'Full name';
  const nameInput = document.createElement('input');
  nameInput.id = 'settings-fullname';
  nameInput.type = 'text';
  nameInput.value = user.fullName;
  nameInput.required = true;

  const contactLabel = document.createElement('label');
  contactLabel.className = 'label';
  contactLabel.htmlFor = 'settings-contact';
  contactLabel.textContent = 'Contact number';
  const contactInput = document.createElement('input');
  contactInput.id = 'settings-contact';
  contactInput.type = 'text';
  contactInput.placeholder = 'Enter a new number to update it — leave blank to keep the current one';

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'primary';
  saveButton.textContent = 'Save changes';

  form.append(errorBox, successBox, nameLabel, nameInput, contactLabel, contactInput, saveButton);
  card.append(heading, roleLine, form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    successBox.hidden = true;

    const fullName = nameInput.value.trim();
    if (!fullName) {
      errorBox.textContent = 'Full name cannot be empty.';
      errorBox.hidden = false;
      return;
    }

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      await updateProfile(user.userId, {
        fullName,
        contactNumber: contactInput.value.trim() ? contactInput.value.trim() : undefined,
      });
      contactInput.value = '';
      onFullNameSaved(fullName);
      successBox.textContent = 'Profile updated.';
      successBox.hidden = false;
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not save your profile.';
      errorBox.textContent = message;
      errorBox.hidden = false;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save changes';
    }
  });

  return card;
}

function buildPasswordCard() {
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h3');
  heading.textContent = 'Change Password';

  const form = document.createElement('form');
  form.className = 'form-stack';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;
  const successBox = document.createElement('div');
  successBox.className = 'login-form__error';
  successBox.setAttribute('role', 'status');
  successBox.classList.add('inline-success');
  successBox.hidden = true;

  const currentLabel = document.createElement('label');
  currentLabel.className = 'sr-only';
  currentLabel.htmlFor = 'settings-current-password';
  currentLabel.textContent = 'Current password';
  const currentInput = document.createElement('input');
  currentInput.id = 'settings-current-password';
  currentInput.type = 'password';
  currentInput.placeholder = 'Current password';
  currentInput.autocomplete = 'current-password';
  currentInput.required = true;

  const newLabel = document.createElement('label');
  newLabel.className = 'sr-only';
  newLabel.htmlFor = 'settings-new-password';
  newLabel.textContent = 'New password (min. 12 characters, upper/lower/digit)';
  const newInput = document.createElement('input');
  newInput.id = 'settings-new-password';
  newInput.type = 'password';
  newInput.placeholder = 'New password (min. 12 characters, upper/lower/digit)';
  newInput.autocomplete = 'new-password';
  newInput.required = true;

  const confirmLabel = document.createElement('label');
  confirmLabel.className = 'sr-only';
  confirmLabel.htmlFor = 'settings-confirm-password';
  confirmLabel.textContent = 'Confirm new password';
  const confirmInput = document.createElement('input');
  confirmInput.id = 'settings-confirm-password';
  confirmInput.type = 'password';
  confirmInput.placeholder = 'Confirm new password';
  confirmInput.autocomplete = 'new-password';
  confirmInput.required = true;

  // audit W15: the policy was enforced on both client and server but never
  // stated — the user discovered it by being rejected. Each rule ticks as
  // it is met, so the requirement is visible before submitting.
  const RULES = [
    { text: 'At least 12 characters', test: (v) => v.length >= 12 },
    { text: 'An uppercase letter', test: (v) => /[A-Z]/.test(v) },
    { text: 'A lowercase letter', test: (v) => /[a-z]/.test(v) },
    { text: 'A number', test: (v) => /\d/.test(v) },
  ];
  const rulesList = document.createElement('ul');
  rulesList.className = 'password-rules';
  rulesList.id = 'settings-password-rules';
  const ruleItems = RULES.map((rule) => {
    const li = document.createElement('li');
    li.className = 'password-rules__item';
    const mark = document.createElement('span');
    mark.className = 'password-rules__mark';
    mark.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = rule.text;
    li.append(mark, label);
    rulesList.appendChild(li);
    return { rule, li };
  });
  newInput.setAttribute('aria-describedby', 'settings-password-rules');
  newInput.addEventListener('input', () => {
    for (const { rule, li } of ruleItems) {
      li.classList.toggle('is-met', rule.test(newInput.value));
    }
  });

  // audit W15: changing a password revokes this user's OTHER sessions
  // (server-side, verified back in Sprint 1) and the UI never said so.
  const sessionNotice = document.createElement('p');
  sessionNotice.className = 'note';
  sessionNotice.textContent = 'Changing your password signs you out on any other device. This one stays signed in.';

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.textContent = 'Update password';

  form.append(errorBox, successBox, currentLabel, currentInput, newLabel, newInput, rulesList, confirmLabel, confirmInput, sessionNotice, submitButton);
  card.appendChild(heading);
  card.appendChild(form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    successBox.hidden = true;

    if (newInput.value !== confirmInput.value) {
      errorBox.textContent = 'New password and confirmation do not match.';
      errorBox.hidden = false;
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Updating…';
    try {
      await changePassword(currentInput.value, newInput.value);
      currentInput.value = '';
      newInput.value = '';
      confirmInput.value = '';
      successBox.textContent = 'Password updated. Your other signed-in sessions have been signed out.';
      successBox.hidden = false;
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not update your password.';
      errorBox.textContent = message;
      errorBox.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Update password';
    }
  });

  return card;
}

/**
 * Appearance — theme (real, shared with the topbar toggle) and Default
 * landing page (real — `main.js`'s `boot()` reads `DEFAULT_PAGE_KEY` and
 * only honours a value that's actually a page the caller's role can see,
 * falling back to the normal first-match otherwise).
 */
function buildAppearanceCard(role) {
  const card = document.createElement('div');
  card.className = 'card';
  const heading = document.createElement('h3');
  heading.textContent = 'Appearance';
  card.appendChild(heading);

  const themeRow = document.createElement('div');
  themeRow.className = 'row-between settings-pref-row';
  const themeLabel = document.createElement('span');
  themeLabel.textContent = 'Theme';
  const themeToggle = document.createElement('button');
  themeToggle.type = 'button';
  themeToggle.className = 'ghost';
  const isDark = () => {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const syncThemeButton = () => { themeToggle.textContent = isDark() ? 'Switch to light' : 'Switch to dark'; };
  syncThemeButton();
  themeToggle.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
    syncThemeButton();
  });
  themeRow.append(themeLabel, themeToggle);

  const landingRow = document.createElement('div');
  landingRow.className = 'row-between settings-pref-row';
  const landingLabel = document.createElement('label');
  landingLabel.htmlFor = 'settings-default-page';
  landingLabel.textContent = 'Default landing page';
  const landingSelect = document.createElement('select');
  landingSelect.id = 'settings-default-page';
  const optionForRole = LANDING_OPTIONS.filter((o) => o.roles.includes(role));
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Automatic (first available screen)';
  landingSelect.appendChild(auto);
  for (const opt of optionForRole) {
    const el = document.createElement('option');
    el.value = opt.key;
    el.textContent = opt.label;
    landingSelect.appendChild(el);
  }
  try { landingSelect.value = localStorage.getItem(DEFAULT_PAGE_KEY) || ''; } catch { /* private mode */ }
  landingSelect.addEventListener('change', () => {
    try {
      if (landingSelect.value) localStorage.setItem(DEFAULT_PAGE_KEY, landingSelect.value);
      else localStorage.removeItem(DEFAULT_PAGE_KEY);
    } catch { /* private mode — preference just won't persist */ }
  });
  landingRow.append(landingLabel, landingSelect);

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = 'Applies the next time you sign in.';

  card.append(themeRow, landingRow, note);
  return card;
}

// Mirrors main.js's PAGE_ROLES exactly (kept here rather than imported, to
// avoid a settings.js -> main.js import cycle — main.js already imports
// every page module, including this one).
const LANDING_OPTIONS = [
  { key: 'dashboard', label: 'Dashboard', roles: ['admin', 'punong_barangay'] },
  { key: 'dispatch', label: 'Dispatch Center', roles: ['admin'] },
  { key: 'incident-management', label: 'Incident Management', roles: ['admin', 'secretary'] },
  { key: 'gis', label: 'Live Map', roles: ['admin', 'punong_barangay'] },
  { key: 'heatmap', label: 'Historical Heatmap', roles: ['admin', 'punong_barangay'] },
  { key: 'blotter', label: 'Electronic Blotter', roles: ['admin', 'secretary', 'punong_barangay'] },
  { key: 'reports', label: 'Analytics', roles: ['admin', 'punong_barangay'] },
  { key: 'citizen-inbox', label: 'Citizen Reports', roles: ['admin', 'secretary'] },
  { key: 'scheduler', label: 'Shift Scheduler', roles: ['admin'] },
  { key: 'swap-requests', label: 'Swap Requests', roles: ['admin'] },
  { key: 'fatigue', label: 'Fatigue Flags', roles: ['admin', 'punong_barangay'] },
  { key: 'sms-log', label: 'SMS Activity Log', roles: ['admin'] },
  { key: 'audit-log', label: 'Audit Log', roles: ['admin'] },
  { key: 'service-health', label: 'Service Health', roles: ['admin'] },
];
