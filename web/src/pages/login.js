/**
 * login.js — W1 Login (§9: "No role selector. Submit is disabled during
 * authentication. Failed authentication uses a generic message such as
 * 'Unable to sign in with those credentials.'").
 *
 * Markup matches the Figma export's LoginPage.tsx split-screen layout (a
 * left branding hero panel next to the sign-in card) — the prior CSS-only
 * pass couldn't reproduce this because the hero panel doesn't exist in
 * any class this app already renders; this pass adds that DOM. Two
 * deliberate departures from the Figma source, per this project's own
 * conventions:
 *   - No role selector — §9 forbids it outright regardless of the mockup.
 *   - The feature blurbs/footer line are reworded to describe only what
 *     this system actually does (session auth + role gating + live GPS/
 *     SOS tracking, all real and verify-script-tested), not the Figma
 *     copy's unverifiable claims ("bank-level encryption", "99.9%
 *     uptime", "Trusted by 50+ barangays") — §8's "no demo/prototype
 *     tells" spirit extends to not shipping marketing copy nobody can
 *     back up in a capstone defense.
 *
 * W1 isn't its own checked box in Sprint 1's "Today's cut" menu — only
 * the auth backend was. This remains minimal on the functional side (no
 * "forgot password" — a dead-end affordance that does nothing would
 * itself be a demo/prototype tell) even though the visual side now
 * matches the mockup. Logged as a scope note in DEVLOG.md.
 *
 * "Remember me" (added in the UI/UX polish pass) persists ONLY the
 * username in localStorage, never the password — the same boundary
 * every browser's own native "remember password" feature respects, and
 * consistent with this codebase's session token itself living in
 * sessionStorage, not localStorage (apiClient.js's own resolved
 * decision), i.e. nothing auth-sensitive gets the longer-lived storage.
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
 */
export function renderLoginPage(root, onSuccess) {
  root.innerHTML = '';

  const screen = document.createElement('div');
  screen.className = 'login-screen';

  const hero = document.createElement('div');
  hero.className = 'login-hero';
  hero.innerHTML = `
    <div class="login-hero__inner">
      <div class="login-hero__brand">
        <span class="icon-badge icon-badge--hero">${icons.shield(30)}</span>
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
      <div class="login-hero__footer">Barangay Intelligence &amp; Emergency Dispatch System</div>
    </div>
  `;

  const formPanel = document.createElement('div');
  formPanel.className = 'login-form-panel';

  const card = document.createElement('div');
  card.className = 'card login-card';

  const mobileBrand = document.createElement('div');
  mobileBrand.className = 'login-card__mobile-brand';
  mobileBrand.innerHTML = `<span class="icon-badge icon-badge--brand">${icons.shield(18)}</span><span>BARANGUARD</span>`;

  const brand = document.createElement('div');
  brand.className = 'login-card__brand';
  brand.innerHTML = '<h2>Welcome Back</h2><p>Sign in to access your dashboard</p>';

  const form = document.createElement('form');
  form.className = 'login-form';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  // Labels are visually hidden, not omitted — the visible placeholder
  // text stays exactly as designed, but "placeholder-only" leaves screen
  // reader / autofill users with no accessible name (§ux Forms
  // anti-pattern). sr-only labels give both without changing the look.
  const usernameLabel = document.createElement('label');
  usernameLabel.className = 'sr-only';
  usernameLabel.htmlFor = 'login-username';
  usernameLabel.textContent = 'Username';
  const usernameInput = document.createElement('input');
  usernameInput.id = 'login-username';
  usernameInput.type = 'text';
  usernameInput.name = 'username';
  usernameInput.placeholder = 'Username';
  usernameInput.autocomplete = 'username';
  usernameInput.required = true;
  let rememberedUsername = '';
  try { rememberedUsername = localStorage.getItem(REMEMBERED_USERNAME_KEY) || ''; } catch { /* private mode — just start blank */ }
  if (rememberedUsername) usernameInput.value = rememberedUsername;

  const passwordLabel = document.createElement('label');
  passwordLabel.className = 'sr-only';
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
  submitButton.className = 'primary';
  submitButton.textContent = 'Sign in';

  form.append(errorBox, usernameLabel, usernameInput, passwordLabel, passwordField, rememberRow, submitButton);
  card.append(mobileBrand, brand, form);
  formPanel.appendChild(card);
  screen.append(hero, formPanel);
  root.appendChild(screen);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      errorBox.textContent = 'Enter a username and password.';
      errorBox.hidden = false;
      return;
    }

    submitButton.disabled = true;
    submitButton.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span>Signing in…</span>`;

    try {
      const user = await login(username, password);
      try {
        if (rememberCheckbox.checked) localStorage.setItem(REMEMBERED_USERNAME_KEY, username);
        else localStorage.removeItem(REMEMBERED_USERNAME_KEY);
      } catch { /* private mode — the preference just won't persist */ }
      onSuccess(user);
    } catch (err) {
      // §9 W1: generic message regardless of the actual failure reason —
      // the backend already collapses unknown/wrong-password/locked into
      // one response (§2 Rule 9); the client must not re-introduce a
      // distinction the server deliberately hid, and a network error gets
      // its own honest message rather than being called a bad password.
      if (err instanceof ApiClientError && err.code === 'NETWORK_ERROR') {
        errorBox.textContent = err.message;
      } else {
        errorBox.textContent = 'Unable to sign in with those credentials.';
      }
      errorBox.hidden = false;
      passwordInput.value = '';
      // Shake the whole card, not just the error box — a stronger, more
      // immediate "that didn't work" cue than the text appearing alone.
      card.classList.remove('is-shaking'); // restart if a fast double-submit re-triggers it
      void card.offsetWidth; // force reflow so removing+re-adding the class actually replays the animation
      card.classList.add('is-shaking');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Sign in';
    }
  });

  usernameInput.focus();
}
