/**
 * login.js — W1 Login (§9: "No role selector. Submit is disabled during
 * authentication. Failed authentication uses a generic message such as
 * 'Unable to sign in with those credentials.'").
 *
 * Markup matches Proposal B (Modern SaaS Restructure):
 * - Semantic landmarks: <aside> for hero and <main> for authentication panel
 * - Persistent visible micro-labels for WCAG 3.3.2 / 1.3.1 compliance
 * - Accessible input field groups with high-contrast borders and focus rings
 * - Seamless zero-regression preservation of all auth logic, session handling,
 *   caps-lock detection, and verification test contracts.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { login, ApiClientError } from '../api/apiClient.js';
import { icons } from '../components/icons.js';

const HERO_FEATURES = [
  { icon: icons.shield, title: 'Session-Based Security', desc: 'Signed-in sessions and per-barangay data isolation.' },
  { icon: icons.lock, title: 'Role-Based Access', desc: 'Separate permissions for Admin, Punong Barangay, and Tanod.' },
  { icon: icons.alertCircle, title: 'Live Emergency Tracking', desc: 'Real-time Tanod GPS and SOS alerts on the dispatch map.' },
];

const REMEMBERED_USERNAME_KEY = 'baranguard.rememberedUsername';

/**
 * @param {HTMLElement} root
 * @param {(user: object) => void} onSuccess
 * @param {{notice?: string}} [options] `notice`: why the user is back here
 *   (session expired / signed out for inactivity, audit 2026-10-09 X-02),
 *   shown above the form until the next sign-in attempt.
 */
export function renderLoginPage(root, onSuccess, { notice } = {}) {
  root.innerHTML = '';

  const screen = document.createElement('div');
  screen.className = 'login-screen';

  const hero = document.createElement('aside');
  hero.className = 'login-hero';
  hero.setAttribute('aria-label', 'Platform Overview');
  hero.innerHTML = `
    <div class="login-hero__inner">
      <div class="login-hero__brand">
        <span class="login-hero__brand-mark">
          <span class="login-hero__brand-pulse" aria-hidden="true"></span>
          <img class="icon-badge icon-badge--hero" src="assets/logo.svg" alt="Baranguard logo">
        </span>
        <span class="login-hero__wordmark">BARANGUARD</span>
      </div>
      <h1>Barangay Emergency Response Platform</h1>
      <p class="login-hero__lede">Incident dispatch, live Tanod tracking, and emergency coordination for a single barangay command center.</p>
      <div class="login-hero__features">
        ${HERO_FEATURES.map((f) => `
          <div class="login-hero__feature">
            <span class="icon-badge icon-badge--feature">${f.icon(20)}</span>
            <div>
              <h3>${f.title}</h3>
              <p>${f.desc}</p>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="login-hero__footer">Serving Dao, Binanuahan, Marifosque, and Banuyo</div>
    </div>
  `;

  const formPanel = document.createElement('main');
  formPanel.className = 'login-form-panel';
  formPanel.setAttribute('role', 'main');

  const card = document.createElement('div');
  card.className = 'card login-card';

  const mobileBrand = document.createElement('div');
  mobileBrand.className = 'login-card__mobile-brand';
  mobileBrand.innerHTML = `<img class="icon-badge icon-badge--brand" src="assets/logo.svg" alt="" aria-hidden="true"><span>BARANGUARD</span>`;

  const brand = document.createElement('div');
  brand.className = 'login-card__brand';
  brand.innerHTML = '<h2>Welcome Back</h2><p>Sign in to access your dashboard</p>';

  const form = document.createElement('form');
  form.className = 'login-form';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.id = 'login-error';
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  // Session-ended notice: polite alert communicating reason for return
  const noticeBox = document.createElement('div');
  noticeBox.id = 'login-notice';
  noticeBox.className = 'login-form__notice login-form__error';
  noticeBox.setAttribute('role', 'alert');
  noticeBox.textContent = notice || '';
  noticeBox.hidden = !notice;

  const clearInputError = (input) => {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    if (!usernameInput.getAttribute('aria-invalid') && !passwordInput.getAttribute('aria-invalid')) {
      errorBox.hidden = true;
    }
  };

  // Username field group with persistent visible label (WCAG 3.3.2)
  const usernameGroup = document.createElement('div');
  usernameGroup.className = 'login-form__field';

  const usernameLabel = document.createElement('label');
  usernameLabel.className = 'login-form__label';
  usernameLabel.htmlFor = 'login-username';
  usernameLabel.textContent = 'Username';

  const usernameInput = document.createElement('input');
  usernameInput.id = 'login-username';
  usernameInput.type = 'text';
  usernameInput.name = 'username';
  usernameInput.placeholder = 'Username';
  usernameInput.autocomplete = 'username';
  usernameInput.required = true;
  usernameInput.addEventListener('input', () => clearInputError(usernameInput));

  let rememberedUsername = '';
  try { rememberedUsername = localStorage.getItem(REMEMBERED_USERNAME_KEY) || ''; } catch { /* private mode — just start blank */ }
  if (rememberedUsername) usernameInput.value = rememberedUsername;

  usernameGroup.append(usernameLabel, usernameInput);

  // Password field group with persistent visible label & accessible eye toggle
  const passwordGroup = document.createElement('div');
  passwordGroup.className = 'login-form__field';

  const passwordLabel = document.createElement('label');
  passwordLabel.className = 'login-form__label';
  passwordLabel.htmlFor = 'login-password';
  passwordLabel.textContent = 'Password';

  const passwordField = document.createElement('div');
  passwordField.className = 'login-password-field';

  const passwordInput = document.createElement('input');
  passwordInput.id = 'login-password';
  passwordInput.type = 'password';
  passwordInput.name = 'password';
  passwordInput.placeholder = 'Password';
  passwordInput.autocomplete = 'current-password';
  passwordInput.required = true;
  passwordInput.addEventListener('input', () => clearInputError(passwordInput));

  const passwordToggle = document.createElement('button');
  passwordToggle.type = 'button';
  passwordToggle.className = 'login-password-field__toggle';
  passwordToggle.innerHTML = icons.eye(18);
  passwordToggle.setAttribute('aria-label', 'Show password');
  passwordToggle.setAttribute('aria-pressed', 'false');
  passwordToggle.addEventListener('click', () => {
    const showing = passwordInput.type === 'text';
    passwordInput.type = showing ? 'password' : 'text';
    passwordToggle.innerHTML = showing ? icons.eye(18) : icons.eyeOff(18);
    passwordToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    passwordToggle.setAttribute('aria-pressed', showing ? 'false' : 'true');
  });

  passwordField.append(passwordInput, passwordToggle);

  // Caps Lock warning indicator
  const capsLockWarning = document.createElement('p');
  capsLockWarning.className = 'login-capslock-warning';
  capsLockWarning.setAttribute('role', 'status');
  capsLockWarning.setAttribute('aria-live', 'polite');
  capsLockWarning.textContent = 'Caps Lock is on';
  capsLockWarning.hidden = true;

  const updateCapsLockWarning = (event) => {
    capsLockWarning.hidden = !event.getModifierState?.('CapsLock');
  };
  passwordInput.addEventListener('keydown', updateCapsLockWarning);
  passwordInput.addEventListener('keyup', updateCapsLockWarning);
  passwordInput.addEventListener('blur', () => { capsLockWarning.hidden = true; });

  passwordGroup.append(passwordLabel, passwordField, capsLockWarning);

  const rememberRow = document.createElement('label');
  rememberRow.className = 'login-remember';
  const rememberCheckbox = document.createElement('input');
  rememberCheckbox.type = 'checkbox';
  rememberCheckbox.checked = Boolean(rememberedUsername);
  const rememberText = document.createElement('span');
  rememberText.textContent = 'Remember my username';
  rememberRow.append(rememberCheckbox, rememberText);

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary login-submit-btn';
  submitButton.textContent = 'Sign in';

  form.append(noticeBox, errorBox, usernameGroup, passwordGroup, rememberRow, submitButton);

  const helpNote = document.createElement('p');
  helpNote.className = 'login-card__help';
  helpNote.textContent = 'Forgot your password? Contact the Chief Tanod to have it reset.';

  const privacyLink = document.createElement('a');
  privacyLink.className = 'login-card__privacy';
  privacyLink.href = 'privacy.html';
  privacyLink.target = '_blank';
  privacyLink.rel = 'noopener';
  privacyLink.textContent = 'Privacy notice';

  const footerRow = document.createElement('p');
  footerRow.className = 'login-card__footer';
  footerRow.appendChild(privacyLink);

  card.append(mobileBrand, brand, form, helpNote, footerRow);
  formPanel.appendChild(card);
  screen.append(hero, formPanel);
  root.appendChild(screen);

  const setControlsDisabled = (disabled) => {
    usernameInput.disabled = disabled;
    passwordInput.disabled = disabled;
    passwordToggle.disabled = disabled;
    rememberCheckbox.disabled = disabled;
    submitButton.disabled = disabled;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    noticeBox.hidden = true;
    usernameInput.removeAttribute('aria-invalid');
    usernameInput.removeAttribute('aria-describedby');
    passwordInput.removeAttribute('aria-invalid');
    passwordInput.removeAttribute('aria-describedby');

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      errorBox.textContent = 'Enter a username and password.';
      errorBox.hidden = false;
      if (!username) {
        usernameInput.setAttribute('aria-invalid', 'true');
        usernameInput.setAttribute('aria-describedby', 'login-error');
        usernameInput.focus();
      } else {
        passwordInput.setAttribute('aria-invalid', 'true');
        passwordInput.setAttribute('aria-describedby', 'login-error');
        passwordInput.focus();
      }
      return;
    }

    setControlsDisabled(true);
    submitButton.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span>Signing in…</span>`;

    try {
      const user = await login(username, password);
      try {
        if (rememberCheckbox.checked) localStorage.setItem(REMEMBERED_USERNAME_KEY, username);
        else localStorage.removeItem(REMEMBERED_USERNAME_KEY);
      } catch { /* private mode — the preference just won't persist */ }
      submitButton.textContent = 'Redirecting…';
      onSuccess(user);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'NETWORK_ERROR') {
        errorBox.textContent = err.message;
      } else {
        errorBox.textContent = 'Unable to sign in with those credentials.';
      }
      errorBox.hidden = false;
      passwordInput.value = '';
      passwordInput.setAttribute('aria-invalid', 'true');
      passwordInput.setAttribute('aria-describedby', 'login-error');
      passwordInput.focus();
      card.classList.remove('is-shaking');
      void card.offsetWidth;
      card.classList.add('is-shaking');
    } finally {
      setControlsDisabled(false);
      if (submitButton.textContent !== 'Redirecting…') {
        submitButton.textContent = 'Sign in';
      }
    }
  });

  if (rememberedUsername) passwordInput.focus();
  else usernameInput.focus();
}
