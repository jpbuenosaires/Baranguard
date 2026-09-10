/**
 * settings.js — W15 Settings/Account & W21 System Configuration
 *
 * Fully overhauled with:
 * - Baranguard Design Tokens & light/dark theme contrast compliance
 * - Categorized Multi-Tier Settings Rail (Account Settings vs System Configuration)
 * - User Identity Hero Card with initials avatar and role badge
 * - Enhanced Password Security with eye show/hide toggles & real-time policy checklist
 * - Visual Interactive Theme Selector Cards (Light & Dark mode)
 * - Municipal Deployment Branding editor
 * - SMS Gateway Telemetry with live sender preview and API key reveal toggle
 *
 * kebab-case filename per §4.
 */

import {
  updateProfile, changePassword, getSystemSettings, updateSystemSettings, logout, ApiClientError,
} from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { avatarInitials } from '../components/Avatar.js';
import { showToast } from '../components/Toast.js';
import { icons } from '../components/icons.js';

const ROLE_LABELS = {
  admin: 'Admin',
  secretary: 'Secretary',
  punong_barangay: 'Punong Barangay',
  tanod: 'Tanod',
};

const THEME_KEY = 'baranguard.theme';
export const DEFAULT_PAGE_KEY = 'baranguard.defaultPage';

const ACCOUNT_SECTIONS = [
  { key: 'profile', label: 'Profile', subLabel: 'Personal details & contact info', icon: icons.users },
  { key: 'password', label: 'Password', subLabel: 'Security & authentication', icon: icons.lock },
  { key: 'appearance', label: 'Appearance', subLabel: 'Theme & landing screen', icon: icons.sun },
];

const SYSTEM_SECTIONS = [
  { key: 'general', label: 'General', subLabel: 'Municipal & jurisdiction branding', icon: icons.shield },
  { key: 'sms-gateway', label: 'SMS Gateway', subLabel: 'Semaphore integration & credentials', icon: icons.messageSquare },
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

  const isAdmin = user.role === 'admin';
  const pageHeader = PageHeader({
    title: 'Settings',
    subtitle: isAdmin
      ? 'Manage personal profile, display preferences, and municipal system configuration'
      : 'Manage your personal profile, security credentials, and display preferences',
    icon: icons.settings,
  });
  header.appendChild(pageHeader.el);

  const layout = document.createElement('div');
  layout.className = 'settings-layout';
  content.appendChild(layout);

  // Settings Rail Navigation
  const rail = document.createElement('nav');
  rail.className = 'settings-rail';
  rail.setAttribute('aria-label', 'Settings navigation');

  const panel = document.createElement('div');
  panel.className = 'settings-panel';

  let activeSection = 'profile';
  const railButtons = {};

  function appendRailSection(title, items) {
    const headerEl = document.createElement('div');
    headerEl.className = 'settings-rail__header';
    headerEl.textContent = title;
    rail.appendChild(headerEl);

    items.forEach((section) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-rail__item';
      button.innerHTML = `
        <span class="settings-rail__icon" aria-hidden="true">${section.icon(18)}</span>
        <div class="settings-rail__text-wrap">
          <span class="settings-rail__title">${section.label}</span>
          <span class="settings-rail__desc">${section.subLabel}</span>
        </div>
      `;

      button.addEventListener('click', () => {
        activeSection = section.key;
        renderPanel();
        syncRail();
      });

      railButtons[section.key] = button;
      rail.appendChild(button);
    });
  }

  appendRailSection('Account Settings', ACCOUNT_SECTIONS);
  if (isAdmin) {
    appendRailSection('System Configuration', SYSTEM_SECTIONS);
  }

  function syncRail() {
    for (const [key, button] of Object.entries(railButtons)) {
      const active = key === activeSection;
      button.classList.toggle('is-active', active);
      if (active) {
        button.setAttribute('aria-current', 'true');
      } else {
        button.removeAttribute('aria-current');
      }
    }
  }
  syncRail();

  function renderPanel() {
    panel.innerHTML = '';
    if (activeSection === 'profile') {
      panel.appendChild(buildProfileCard(user, (newName) => {
        user.fullName = newName;
        shell.setFullName(newName);
      }));
    } else if (activeSection === 'password') {
      panel.appendChild(buildPasswordCard());
    } else if (activeSection === 'appearance') {
      panel.appendChild(buildAppearanceCard(user.role));
    } else if (activeSection === 'general') {
      panel.appendChild(buildLoadingCard('General'));
      loadSystemSettingsInto(panel, buildGeneralCard);
    } else if (activeSection === 'sms-gateway') {
      panel.appendChild(buildLoadingCard('SMS Gateway'));
      loadSystemSettingsInto(panel, buildSmsGatewayCard);
    }
  }
  renderPanel();

  layout.append(rail, panel);
}

function buildLoadingCard(label) {
  const card = document.createElement('div');
  card.className = 'settings-card skeleton skeleton--block';
  card.setAttribute('role', 'status');
  card.setAttribute('aria-label', `Loading ${label}`);
  return card;
}

async function loadSystemSettingsInto(panel, buildCard) {
  try {
    const settings = await getSystemSettings();
    panel.innerHTML = '';
    panel.appendChild(buildCard(settings));
  } catch (err) {
    panel.innerHTML = '';
    const block = document.createElement('div');
    block.className = 'settings-card state-block state-block--error';
    block.setAttribute('role', 'alert');
    const text = document.createElement('p');
    text.textContent = err instanceof ApiClientError ? err.message : 'Could not load system settings.';
    block.appendChild(text);
    panel.appendChild(block);
  }
}

/**
 * 1. Profile Card with Identity Hero
 */
function buildProfileCard(user, onFullNameSaved) {
  const card = document.createElement('div');
  card.className = 'settings-card';

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'settings-card__header';
  headerEl.innerHTML = `
    <div class="settings-card__title-wrap">
      <span class="settings-card__icon">${icons.users(20)}</span>
      <div>
        <h3 class="settings-card__title">Personal Profile</h3>
        <p class="settings-card__subtitle">Your operator identity and contact details</p>
      </div>
    </div>
  `;
  card.appendChild(headerEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'settings-card__body';

  // Identity Hero Block
  const hero = document.createElement('div');
  hero.className = 'settings-profile-hero';

  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'settings-avatar-wrap';
  avatarWrap.innerHTML = avatarInitials(user.fullName, 52);

  const identityBlock = document.createElement('div');
  identityBlock.className = 'settings-identity-block';

  const nameEl = document.createElement('div');
  nameEl.className = 'settings-identity-name';
  nameEl.textContent = user.fullName;

  const badgesRow = document.createElement('div');
  badgesRow.className = 'settings-identity-badges';

  const roleClassMap = {
    admin: 'role-badge--admin',
    punong_barangay: 'role-badge--punong_barangay',
    secretary: 'role-badge--secretary',
    tanod: 'role-badge--tanod',
  };

  const rolePill = document.createElement('span');
  rolePill.className = `role-badge ${roleClassMap[user.role] || 'role-badge--admin'}`;
  rolePill.textContent = ROLE_LABELS[user.role] || user.role;

  const idChip = document.createElement('span');
  idChip.className = 'settings-user-id-chip';
  idChip.textContent = `User #${user.userId}`;

  badgesRow.append(rolePill, idChip);
  identityBlock.append(nameEl, badgesRow);
  hero.append(avatarWrap, identityBlock);

  bodyEl.appendChild(hero);

  // Form
  const form = document.createElement('form');
  form.className = 'settings-form';
  form.noValidate = true;

  // Full Name Field
  const nameField = document.createElement('div');
  nameField.className = 'settings-field';
  const nameLabel = document.createElement('label');
  nameLabel.className = 'settings-label';
  nameLabel.htmlFor = 'settings-fullname';
  nameLabel.textContent = 'Full Name';

  const nameInputWrap = document.createElement('div');
  nameInputWrap.className = 'settings-input-wrap';
  const nameIcon = document.createElement('span');
  nameIcon.className = 'settings-input-icon';
  nameIcon.innerHTML = icons.users(16);

  const nameInput = document.createElement('input');
  nameInput.id = 'settings-fullname';
  nameInput.type = 'text';
  nameInput.className = 'settings-input settings-input--with-icon';
  nameInput.value = user.fullName;
  nameInput.required = true;

  nameInputWrap.append(nameIcon, nameInput);
  nameField.append(nameLabel, nameInputWrap);

  // Contact Number Field
  const contactField = document.createElement('div');
  contactField.className = 'settings-field';
  const contactLabel = document.createElement('label');
  contactLabel.className = 'settings-label';
  contactLabel.htmlFor = 'settings-contact';
  contactLabel.textContent = 'Contact Number';

  const contactInputWrap = document.createElement('div');
  contactInputWrap.className = 'settings-input-wrap';
  const contactIcon = document.createElement('span');
  contactIcon.className = 'settings-input-icon';
  contactIcon.innerHTML = icons.phone(16);

  const contactInput = document.createElement('input');
  contactInput.id = 'settings-contact';
  contactInput.type = 'text';
  contactInput.className = 'settings-input settings-input--with-icon';
  contactInput.placeholder = 'e.g. 0917 123 4567';

  const contactHelp = document.createElement('span');
  contactHelp.className = 'settings-help-text';
  contactHelp.textContent = 'Enter a new mobile number to update it. Leave blank to preserve your current number.';

  contactInputWrap.append(contactIcon, contactInput);
  contactField.append(contactLabel, contactInputWrap, contactHelp);

  // Submit Button
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.style.cssText = 'width: fit-content; min-width: 140px; margin-top: 0.25rem;';
  submitButton.textContent = 'Save Changes';

  form.append(nameField, contactField, submitButton);
  bodyEl.appendChild(form);
  card.appendChild(bodyEl);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fullName = nameInput.value.trim();
    if (!fullName) {
      showToast('Full name cannot be empty.', { variant: 'error' });
      nameInput.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Saving…';

    try {
      await updateProfile(user.userId, {
        fullName,
        contactNumber: contactInput.value.trim() ? contactInput.value.trim() : undefined,
      });

      contactInput.value = '';
      nameEl.textContent = fullName;
      avatarWrap.innerHTML = avatarInitials(fullName, 52);
      onFullNameSaved(fullName);
      showToast('Profile updated successfully.', { variant: 'success' });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not save your profile.';
      showToast(message, { variant: 'error' });
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Save Changes';
    }
  });

  return card;
}

/**
 * 2. Password Card with Visibility Toggles & Real-Time Policy Checklist
 */
function buildPasswordCard() {
  const card = document.createElement('div');
  card.className = 'settings-card';

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'settings-card__header';
  headerEl.innerHTML = `
    <div class="settings-card__title-wrap">
      <span class="settings-card__icon">${icons.lock(20)}</span>
      <div>
        <h3 class="settings-card__title">Security & Password</h3>
        <p class="settings-card__subtitle">Update your account authentication credentials</p>
      </div>
    </div>
  `;
  card.appendChild(headerEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'settings-card__body';

  // Security Notice Banner
  const securityNotice = document.createElement('div');
  securityNotice.className = 'settings-security-notice';
  securityNotice.innerHTML = `
    <span class="settings-security-notice__icon">${icons.alertTriangle(18)}</span>
    <span>
      <strong>Session Revocation Security Policy:</strong> Changing your password will automatically terminate and sign out
      all other active sessions across mobile devices and workstations. Your current browser will remain securely logged in.
    </span>
  `;
  bodyEl.appendChild(securityNotice);

  const form = document.createElement('form');
  form.className = 'settings-form';
  form.noValidate = true;

  function buildPasswordField(id, labelText, placeholder) {
    const field = document.createElement('div');
    field.className = 'settings-field';

    const label = document.createElement('label');
    label.className = 'settings-label';
    label.htmlFor = id;
    label.textContent = labelText;

    const wrap = document.createElement('div');
    wrap.className = 'settings-input-wrap';

    const input = document.createElement('input');
    input.id = id;
    input.type = 'password';
    input.className = 'settings-input settings-input--with-toggle';
    input.placeholder = placeholder;
    input.autocomplete = id === 'settings-current-password' ? 'current-password' : 'new-password';
    input.required = true;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'settings-pwd-toggle';
    toggle.setAttribute('aria-label', `Toggle ${labelText} visibility`);
    toggle.innerHTML = icons.eye(16);

    let isVisible = false;
    toggle.addEventListener('click', () => {
      isVisible = !isVisible;
      input.type = isVisible ? 'text' : 'password';
      toggle.innerHTML = isVisible ? icons.eyeOff(16) : icons.eye(16);
    });

    wrap.append(input, toggle);
    field.append(label, wrap);
    return { field, input };
  }

  const currentField = buildPasswordField('settings-current-password', 'Current Password', 'Enter current password');
  const newField = buildPasswordField('settings-new-password', 'New Password', 'Enter at least 12 characters');
  const confirmField = buildPasswordField('settings-confirm-password', 'Confirm New Password', 'Re-enter new password');

  // Policy Checklist Box
  const rulesBox = document.createElement('div');
  rulesBox.className = 'settings-rules-box';

  const rulesTitle = document.createElement('span');
  rulesTitle.className = 'settings-rules-title';
  rulesTitle.textContent = 'Password Complexity Requirements:';

  const rulesList = document.createElement('ul');
  rulesList.className = 'settings-rules-list';

  const RULES = [
    { text: 'At least 12 characters', test: (v) => v.length >= 12 },
    { text: 'An uppercase letter (A-Z)', test: (v) => /[A-Z]/.test(v) },
    { text: 'A lowercase letter (a-z)', test: (v) => /[a-z]/.test(v) },
    { text: 'A numeric digit (0-9)', test: (v) => /\d/.test(v) },
  ];

  const ruleElements = RULES.map((rule) => {
    const li = document.createElement('li');
    li.className = 'settings-rule-item';

    const mark = document.createElement('span');
    mark.className = 'settings-rule-mark';
    mark.innerHTML = icons.alertCircle(14);

    const lbl = document.createElement('span');
    lbl.textContent = rule.text;

    li.append(mark, lbl);
    rulesList.appendChild(li);
    return { rule, li, mark };
  });

  rulesBox.append(rulesTitle, rulesList);

  newField.input.addEventListener('input', () => {
    const val = newField.input.value;
    ruleElements.forEach(({ rule, li, mark }) => {
      const isMet = rule.test(val);
      li.classList.toggle('is-met', isMet);
      mark.innerHTML = isMet ? icons.checkCircle(14) : icons.alertCircle(14);
    });
  });

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.style.cssText = 'width: fit-content; min-width: 150px; margin-top: 0.5rem;';
  submitButton.textContent = 'Update Password';

  form.append(currentField.field, newField.field, rulesBox, confirmField.field, submitButton);
  bodyEl.appendChild(form);
  card.appendChild(bodyEl);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!currentField.input.value) {
      showToast('Please enter your current password.', { variant: 'error' });
      currentField.input.focus();
      return;
    }

    const allRulesMet = RULES.every((r) => r.test(newField.input.value));
    if (!allRulesMet) {
      showToast('New password does not satisfy all complexity requirements.', { variant: 'error' });
      newField.input.focus();
      return;
    }

    if (newField.input.value !== confirmField.input.value) {
      showToast('New password and confirmation do not match.', { variant: 'error' });
      confirmField.input.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Updating…';

    try {
      await changePassword(currentField.input.value, newField.input.value);
      currentField.input.value = '';
      newField.input.value = '';
      confirmField.input.value = '';

      ruleElements.forEach(({ li, mark }) => {
        li.classList.remove('is-met');
        mark.innerHTML = icons.alertCircle(14);
      });

      showToast('Password updated. Other signed-in sessions have been revoked.', { variant: 'success' });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not update your password.';
      showToast(message, { variant: 'error' });
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Update Password';
    }
  });

  return card;
}

/**
 * 3. Appearance Card with Visual Theme Selector
 */
function buildAppearanceCard(role) {
  const card = document.createElement('div');
  card.className = 'settings-card';

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'settings-card__header';
  headerEl.innerHTML = `
    <div class="settings-card__title-wrap">
      <span class="settings-card__icon">${icons.sun(20)}</span>
      <div>
        <h3 class="settings-card__title">Display & Appearance</h3>
        <p class="settings-card__subtitle">Theme preferences and workstation default landing view</p>
      </div>
    </div>
  `;
  card.appendChild(headerEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'settings-card__body';

  // Section 1: Visual Theme Selector Cards
  const themeSection = document.createElement('div');
  themeSection.className = 'settings-field';

  const themeLabel = document.createElement('span');
  themeLabel.className = 'settings-label';
  themeLabel.textContent = 'Interface Color Theme';

  const themeGrid = document.createElement('div');
  themeGrid.className = 'settings-theme-grid';

  const isDark = () => {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  };

  // Light Card
  const lightCard = document.createElement('div');
  lightCard.className = 'settings-theme-card';
  lightCard.setAttribute('role', 'button');
  lightCard.setAttribute('tabindex', '0');
  lightCard.innerHTML = `
    <div class="settings-theme-card__top">
      <div class="settings-theme-card__icon">${icons.sun(20)}</div>
      <span class="settings-theme-card__indicator" aria-hidden="true">${icons.checkCircle(12)}</span>
    </div>
    <h4 class="settings-theme-card__title">Light Mode</h4>
    <p class="settings-theme-card__desc">Clean, high-contrast operational console tuned for daylight shift environments.</p>
  `;

  // Dark Card
  const darkCard = document.createElement('div');
  darkCard.className = 'settings-theme-card';
  darkCard.setAttribute('role', 'button');
  darkCard.setAttribute('tabindex', '0');
  darkCard.innerHTML = `
    <div class="settings-theme-card__top">
      <div class="settings-theme-card__icon">${icons.moon(20)}</div>
      <span class="settings-theme-card__indicator" aria-hidden="true">${icons.checkCircle(12)}</span>
    </div>
    <h4 class="settings-theme-card__title">Dark Mode</h4>
    <p class="settings-theme-card__desc">Reduces glare and blue-light strain for nighttime dispatch operations.</p>
  `;

  const syncThemeCards = () => {
    const dark = isDark();
    lightCard.classList.toggle('is-active', !dark);
    darkCard.classList.toggle('is-active', dark);
  };

  const applyTheme = (mode) => {
    document.documentElement.setAttribute('data-theme', mode);
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch { /* Private mode */ }
    syncThemeCards();
    showToast(`Theme switched to ${mode} mode.`, { variant: 'info' });
  };

  lightCard.addEventListener('click', () => applyTheme('light'));
  darkCard.addEventListener('click', () => applyTheme('dark'));

  syncThemeCards();
  themeGrid.append(lightCard, darkCard);
  themeSection.append(themeLabel, themeGrid);

  // Section 2: Default Landing Screen
  const landingSection = document.createElement('div');
  landingSection.className = 'settings-field';
  landingSection.style.marginTop = '0.5rem';

  const landingLabel = document.createElement('label');
  landingLabel.className = 'settings-label';
  landingLabel.htmlFor = 'settings-default-page';
  landingLabel.textContent = 'Default Login Landing Screen';

  const landingSelect = document.createElement('select');
  landingSelect.id = 'settings-default-page';
  landingSelect.className = 'settings-input';

  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = 'Automatic (First available operational view)';
  landingSelect.appendChild(autoOpt);

  const eligibleScreens = LANDING_OPTIONS.filter((opt) => opt.roles.includes(role));
  eligibleScreens.forEach((opt) => {
    const el = document.createElement('option');
    el.value = opt.key;
    el.textContent = opt.label;
    landingSelect.appendChild(el);
  });

  try {
    landingSelect.value = localStorage.getItem(DEFAULT_PAGE_KEY) || '';
  } catch { /* private mode */ }

  landingSelect.addEventListener('change', () => {
    try {
      if (landingSelect.value) {
        localStorage.setItem(DEFAULT_PAGE_KEY, landingSelect.value);
      } else {
        localStorage.removeItem(DEFAULT_PAGE_KEY);
      }
      showToast('Default landing page preference saved.', { variant: 'success' });
    } catch { /* private mode */ }
  });

  const landingHelp = document.createElement('span');
  landingHelp.className = 'settings-help-text';
  landingHelp.textContent = 'Determines which operational screen opens immediately after authentication.';

  landingSection.append(landingLabel, landingSelect, landingHelp);

  bodyEl.append(themeSection, landingSection);
  card.appendChild(bodyEl);
  return card;
}

/**
 * 4. General Deployment Card (Admin Only)
 */
function buildGeneralCard(settings) {
  const card = document.createElement('div');
  card.className = 'settings-card';

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'settings-card__header';
  headerEl.innerHTML = `
    <div class="settings-card__title-wrap">
      <span class="settings-card__icon">${icons.shield(20)}</span>
      <div>
        <h3 class="settings-card__title">General System Configuration</h3>
        <p class="settings-card__subtitle">Municipal jurisdiction and deployment branding metadata</p>
      </div>
    </div>
  `;
  card.appendChild(headerEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'settings-card__body';

  // Brand Hero Box
  const brandHero = document.createElement('div');
  brandHero.className = 'settings-brand-hero';
  brandHero.innerHTML = `
    <div>
      <div class="settings-brand-hero__title">${settings['general.system_name'] || 'BARANGUARD'}</div>
      <div class="settings-brand-hero__sub">${settings['general.municipality'] || 'Pilar, Sorsogon'} • ${settings['general.region'] || 'Region V (Bicol)'}</div>
    </div>
    <span class="role-badge role-badge--admin">DEPLOYMENT TENANT</span>
  `;
  bodyEl.appendChild(brandHero);

  const form = document.createElement('form');
  form.className = 'settings-form';
  form.noValidate = true;

  function buildInputGroup(id, labelText, value, iconFn) {
    const field = document.createElement('div');
    field.className = 'settings-field';

    const label = document.createElement('label');
    label.className = 'settings-label';
    label.htmlFor = id;
    label.textContent = labelText;

    const wrap = document.createElement('div');
    wrap.className = 'settings-input-wrap';

    const icon = document.createElement('span');
    icon.className = 'settings-input-icon';
    icon.innerHTML = iconFn(16);

    const input = document.createElement('input');
    input.id = id;
    input.type = 'text';
    input.className = 'settings-input settings-input--with-icon';
    input.value = value || '';

    wrap.append(icon, input);
    field.append(label, wrap);
    return { field, input };
  }

  const nameField = buildInputGroup('settings-system-name', 'System Title', settings['general.system_name'], icons.layoutDashboard);
  const munField = buildInputGroup('settings-municipality', 'Municipality / City', settings['general.municipality'], icons.mapPin);
  const regField = buildInputGroup('settings-region', 'Region / Province', settings['general.region'], icons.compass);

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.style.cssText = 'width: fit-content; min-width: 140px; margin-top: 0.25rem;';
  submitButton.textContent = 'Save General Settings';

  form.append(nameField.field, munField.field, regField.field, submitButton);
  bodyEl.appendChild(form);
  card.appendChild(bodyEl);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitButton.disabled = true;
    submitButton.textContent = 'Saving…';

    try {
      await updateSystemSettings({
        'general.system_name': nameField.input.value.trim(),
        'general.municipality': munField.input.value.trim(),
        'general.region': regField.input.value.trim(),
      });

      brandHero.querySelector('.settings-brand-hero__title').textContent = nameField.input.value.trim() || 'BARANGUARD';
      brandHero.querySelector('.settings-brand-hero__sub').textContent = `${munField.input.value.trim()} • ${regField.input.value.trim()}`;
      showToast('General system configuration saved.', { variant: 'success' });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not save general settings.';
      showToast(message, { variant: 'error' });
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Save General Settings';
    }
  });

  return card;
}

/**
 * 5. SMS Gateway Card (Admin Only)
 */
function buildSmsGatewayCard(settings) {
  const card = document.createElement('div');
  card.className = 'settings-card';

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'settings-card__header';
  headerEl.innerHTML = `
    <div class="settings-card__title-wrap">
      <span class="settings-card__icon">${icons.messageSquare(20)}</span>
      <div>
        <h3 class="settings-card__title">SMS Gateway Integration</h3>
        <p class="settings-card__subtitle">Semaphore SMS broadcast provider credentials and Sender ID</p>
      </div>
    </div>
  `;
  card.appendChild(headerEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'settings-card__body';

  // Provider Status Box
  const providerBox = document.createElement('div');
  providerBox.className = 'settings-gateway-status-box';
  providerBox.innerHTML = `
    <div style="display:flex; align-items:center; gap:0.625rem;">
      <span style="color:var(--color-primary);">${icons.radio(18)}</span>
      <div>
        <div style="font-size:var(--font-size-sm); font-weight:700; color:var(--color-text-primary);">Semaphore SMS Gateway</div>
        <div style="font-size:var(--font-size-xs); color:var(--color-text-tertiary);">Direct cellular carrier route for Philippine mobile networks</div>
      </div>
    </div>
    <span class="status-pill ${settings['sms_gateway.api_key'] ? 'status-pill--success' : 'status-pill--neutral'}">
      ${settings['sms_gateway.api_key'] ? 'API KEY CONFIGURED' : 'USING .ENV FALLBACK'}
    </span>
  `;
  bodyEl.appendChild(providerBox);

  const form = document.createElement('form');
  form.className = 'settings-form';
  form.noValidate = true;

  // Sender Name
  const senderField = document.createElement('div');
  senderField.className = 'settings-field';
  const senderLabel = document.createElement('label');
  senderLabel.className = 'settings-label';
  senderLabel.htmlFor = 'settings-sms-sender';
  senderLabel.textContent = 'Registered Sender ID';

  const senderInput = document.createElement('input');
  senderInput.id = 'settings-sms-sender';
  senderInput.type = 'text';
  senderInput.className = 'settings-input';
  senderInput.placeholder = 'e.g. BARANGUARD (must match registered Semaphore sender)';
  senderInput.value = settings['sms_gateway.sender_name'] || '';

  const previewChip = document.createElement('div');
  previewChip.className = 'settings-sender-preview-chip';
  const updatePreview = () => {
    previewChip.innerHTML = `${icons.phone(12)}<span>Citizen phone preview: <strong>${senderInput.value.trim() || 'SEMAPHORE'}</strong></span>`;
  };
  updatePreview();
  senderInput.addEventListener('input', updatePreview);

  senderField.append(senderLabel, senderInput, previewChip);

  // API Key
  const apiKeyField = document.createElement('div');
  apiKeyField.className = 'settings-field';
  const apiKeyLabel = document.createElement('label');
  apiKeyLabel.className = 'settings-label';
  apiKeyLabel.htmlFor = 'settings-sms-api-key';
  apiKeyLabel.textContent = 'Semaphore API Key (Secret)';

  const apiKeyWrap = document.createElement('div');
  apiKeyWrap.className = 'settings-input-wrap';

  const apiKeyInput = document.createElement('input');
  apiKeyInput.id = 'settings-sms-api-key';
  apiKeyInput.type = 'password';
  apiKeyInput.className = 'settings-input settings-input--with-toggle';
  apiKeyInput.placeholder = '••••••••';
  apiKeyInput.value = settings['sms_gateway.api_key'] || '';

  const apiKeyToggle = document.createElement('button');
  apiKeyToggle.type = 'button';
  apiKeyToggle.className = 'settings-pwd-toggle';
  apiKeyToggle.setAttribute('aria-label', 'Toggle API key visibility');
  apiKeyToggle.innerHTML = icons.eye(16);

  let isKeyVisible = false;
  apiKeyToggle.addEventListener('click', () => {
    isKeyVisible = !isKeyVisible;
    apiKeyInput.type = isKeyVisible ? 'text' : 'password';
    apiKeyToggle.innerHTML = isKeyVisible ? icons.eyeOff(16) : icons.eye(16);
  });

  apiKeyWrap.append(apiKeyInput, apiKeyToggle);

  const apiKeyNote = document.createElement('span');
  apiKeyNote.className = 'settings-help-text';
  apiKeyNote.textContent = settings['sms_gateway.api_key']
    ? 'A key is currently active (masked above). Leave unchanged to preserve it, or enter a new API key to replace it.'
    : 'No key is saved in system settings. Outbound SMS relies on SEMAPHORE_API_KEY in backend/.env, if configured.';

  apiKeyField.append(apiKeyLabel, apiKeyWrap, apiKeyNote);

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.style.cssText = 'width: fit-content; min-width: 140px; margin-top: 0.25rem;';
  submitButton.textContent = 'Save Gateway Settings';

  form.append(senderField, apiKeyField, submitButton);
  bodyEl.appendChild(form);
  card.appendChild(bodyEl);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitButton.disabled = true;
    submitButton.textContent = 'Saving…';

    try {
      await updateSystemSettings({
        'sms_gateway.sender_name': senderInput.value.trim(),
        'sms_gateway.api_key': apiKeyInput.value,
      });

      showToast('SMS Gateway settings saved successfully.', { variant: 'success' });
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not save SMS Gateway settings.';
      showToast(message, { variant: 'error' });
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Save Gateway Settings';
    }
  });

  return card;
}

const LANDING_OPTIONS = [
  { key: 'dashboard', label: 'Dashboard', roles: ['admin', 'punong_barangay'] },
  { key: 'dispatch', label: 'Dispatch Center', roles: ['admin'] },
  { key: 'incident-management', label: 'Incident Management', roles: ['admin', 'secretary'] },
  { key: 'gis', label: 'Live Map', roles: ['admin', 'punong_barangay'] },
  { key: 'analytics', label: 'Analytics', roles: ['admin', 'punong_barangay'] },
  { key: 'citizen-inbox', label: 'Citizen Reports', roles: ['admin', 'secretary'] },
  { key: 'personnel', label: 'Personnel', roles: ['admin', 'punong_barangay'] },
  { key: 'sms-log', label: 'SMS Monitor', roles: ['admin'] },
  { key: 'audit-log', label: 'Audit Log', roles: ['admin'] },
  { key: 'service-health', label: 'Service Health', roles: ['admin'] },
  { key: 'map-packages', label: 'Map Packages', roles: ['admin'] },
];
