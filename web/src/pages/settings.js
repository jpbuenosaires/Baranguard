/**
 * settings.js — W15 Settings/Account (§9): "Roles: All. API: self
 * profile, change password, logout. Logout is one atomic server action
 * from the user's perspective." Every authenticated web role reaches this
 * screen (this is the first screen a Secretary account can use at all in
 * this dashboard — the other new screens this sprint gate Secretary in
 * for Blotter/Citizen-Reports-Inbox too, but Settings is universal).
 *
 * Resolved decision, logged in DEVLOG.md: §6 has no "GET /users/me" or
 * profile-read endpoint at all — self profile data is whatever the login
 * response already put in the session (`full_name`, `role`; no
 * `username`/`contact_number`). So this page can prefill and display
 * `full_name`, but the contact-number field is a blind "type a new value
 * to change it, leave blank to keep the current one" input rather than a
 * prefilled one — there's no endpoint this sprint that returns the
 * current value to prefill it with, and inventing one wasn't in scope.
 * Username/role/barangay are shown read-only from the session for the
 * same reason (no self-profile GET to source anything richer from).
 *
 * kebab-case filename per §4 (pages/routes convention).
 */

import { updateProfile, changePassword, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { icons } from '../components/icons.js';

const ROLE_LABELS = { admin: 'Admin', secretary: 'Secretary', punong_barangay: 'Punong Barangay', tanod: 'Tanod' };

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
  const { content } = shell;
  root.appendChild(shell.el);

  content.innerHTML = `<h2 style="margin-bottom:16px; display:flex; align-items:center; gap:10px;">${icons.settings(22)}Settings</h2>`;

  const layout = document.createElement('div');
  layout.style.cssText = 'display:flex; flex-direction:column; gap:16px; max-width:480px;';
  content.appendChild(layout);

  layout.append(buildProfileCard(user, shell.setFullName), buildPasswordCard());
}

function buildProfileCard(user, onFullNameSaved) {
  const card = document.createElement('div');
  card.className = 'card';

  const heading = document.createElement('h3');
  heading.textContent = 'Profile';
  heading.style.marginBottom = '16px';

  const roleLine = document.createElement('p');
  roleLine.className = 'label';
  roleLine.style.cssText = 'text-transform:none; font-weight:400; margin-bottom:16px;';
  roleLine.textContent = `Role: ${ROLE_LABELS[user.role] || user.role}`;

  const form = document.createElement('form');
  form.style.cssText = 'display:flex; flex-direction:column; gap:12px;';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.hidden = true;
  const successBox = document.createElement('div');
  successBox.className = 'login-form__error';
  successBox.style.background = 'var(--tint-success-bg)';
  successBox.style.color = 'var(--color-success)';
  successBox.hidden = true;

  const nameLabel = document.createElement('label');
  nameLabel.className = 'label';
  nameLabel.textContent = 'Full name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = user.fullName;
  nameInput.required = true;

  const contactLabel = document.createElement('label');
  contactLabel.className = 'label';
  contactLabel.textContent = 'Contact number';
  const contactInput = document.createElement('input');
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
  heading.style.marginBottom = '16px';

  const form = document.createElement('form');
  form.style.cssText = 'display:flex; flex-direction:column; gap:12px;';
  form.noValidate = true;

  const errorBox = document.createElement('div');
  errorBox.className = 'login-form__error';
  errorBox.hidden = true;
  const successBox = document.createElement('div');
  successBox.className = 'login-form__error';
  successBox.style.background = 'var(--tint-success-bg)';
  successBox.style.color = 'var(--color-success)';
  successBox.hidden = true;

  const currentInput = document.createElement('input');
  currentInput.type = 'password';
  currentInput.placeholder = 'Current password';
  currentInput.autocomplete = 'current-password';
  currentInput.required = true;

  const newInput = document.createElement('input');
  newInput.type = 'password';
  newInput.placeholder = 'New password (min. 12 characters, upper/lower/digit)';
  newInput.autocomplete = 'new-password';
  newInput.required = true;

  const confirmInput = document.createElement('input');
  confirmInput.type = 'password';
  confirmInput.placeholder = 'Confirm new password';
  confirmInput.autocomplete = 'new-password';
  confirmInput.required = true;

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.textContent = 'Update password';

  form.append(errorBox, successBox, currentInput, newInput, confirmInput, submitButton);
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
