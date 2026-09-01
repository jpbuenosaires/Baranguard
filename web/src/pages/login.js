/**
 * login.js — W1 Login (§9: "No role selector. Submit is disabled during
 * authentication. Failed authentication uses a generic message such as
 * 'Unable to sign in with those credentials.'").
 *
 * W1 isn't its own checked box in Sprint 1's "Today's cut" menu — only
 * the auth backend was. This minimal page is built as necessary plumbing
 * so W2 (this session's actual chosen item) is reachable/testable at all;
 * it is not a full W1 polish pass (no "forgot password", no branding
 * beyond the wordmark). Logged as a scope note in DEVLOG.md.
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { login, ApiClientError } from '../api/apiClient.js';

/**
 * @param {HTMLElement} root
 * @param {(user: object) => void} onSuccess
 */
export function renderLoginPage(root, onSuccess) {
  root.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'login-page';

  const card = document.createElement('div');
  card.className = 'card login-card';

  const brand = document.createElement('div');
  brand.className = 'login-card__brand';
  brand.innerHTML = '<h1>Baranguard</h1><p class="label">Barangay Command Center</p>';

  const form = document.createElement('form');
  form.className = 'login-form';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.hidden = true;

  const usernameInput = document.createElement('input');
  usernameInput.type = 'text';
  usernameInput.name = 'username';
  usernameInput.placeholder = 'Username';
  usernameInput.autocomplete = 'username';
  usernameInput.required = true;

  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.name = 'password';
  passwordInput.placeholder = 'Password';
  passwordInput.autocomplete = 'current-password';
  passwordInput.required = true;

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.textContent = 'Sign in';

  form.append(errorBox, usernameInput, passwordInput, submitButton);
  card.append(brand, form);
  page.appendChild(card);
  root.appendChild(page);

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
    submitButton.textContent = 'Signing in…';

    try {
      const user = await login(username, password);
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
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Sign in';
    }
  });

  usernameInput.focus();
}
