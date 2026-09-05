/**
 * user-management.js — W10 User Management. Deactivate/reactivate +
 * session revocation (original cut), account creation (follow-up), and
 * — 2026-09-05 UX pass — search, role-summary stat chips, a Suspended
 * state independent of Active/Inactive, and a Last Login column. Role
 * changes to an EXISTING account remain out of scope; see
 * UsersController.php's own docblocks.
 *
 * Data source is the existing admin-only, tenant-scoped `GET /users`.
 * Search is CLIENT-SIDE over the loaded page, unlike Incident
 * Management's/Blotter's own `q=` additions this session — those lists
 * are realistically paginated (hundreds of incidents/records); a
 * barangay's own user roster is a handful of accounts that always fits
 * on one page, so a server round-trip buys nothing here (see
 * `getUsers()`'s own doc in apiClient.js — `GET /users` never gained a
 * `q=` param for exactly this reason).
 *
 * No "Barangay" column: `GET /users` is already hard-scoped to the
 * viewing Admin's own barangay (UsersController::index()), so every row
 * would show the identical value — a column that's always the same
 * constant conveys nothing and would be exactly the kind of "control
 * that looks functional and does nothing" §2 Rule 6 forbids.
 *
 * The signed-in admin's own row never gets a deactivate/reactivate/
 * suspend button — the server enforces this too (self edits can't touch
 * is_active/is_suspended at all), but surfacing it here avoids a
 * pointless round trip to a 400.
 *
 * kebab-case filename per §4.
 */

import { getUsers, setUserActive, setUserSuspended, createUser, logout, ApiClientError } from '../api/apiClient.js';
import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatStrip } from '../components/StatStrip.js';
import { DataTable } from '../components/DataTable.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { showToast } from '../components/Toast.js';
import { icons } from '../components/icons.js';

const PAGE_SIZE = 25;

const ROLE_LABELS = {
  admin: 'Admin',
  secretary: 'Secretary',
  tanod: 'Tanod',
  punong_barangay: 'Punong Barangay',
  lupon: 'Lupon',
};

// §3: Lupon has no system account at all — never offered as a creatable
// role, even though ROLE_LABELS above still needs the key to label any
// existing row (there shouldn't be one, but the table must not break if
// there somehow is).
const CREATABLE_ROLES = ['admin', 'secretary', 'tanod', 'punong_barangay'];

const COLUMNS = [
  { key: 'fullName', label: 'Name' },
  { key: 'username', label: 'Username' },
  { key: 'role', label: 'Role' },
  { key: 'contactNumber', label: 'Contact' },
  { key: 'status', label: 'Status' },
  { key: 'lastLoginAt', label: 'Last Login' },
  { key: 'createdAt', label: 'Created' },
  { key: 'actions', label: 'Actions', align: 'right' },
];

/**
 * @param {HTMLElement} root
 * @param {{userId:number, fullName:string, role:string}} user
 * @param {() => void} onLoggedOut
 * @param {(page: string, param?: any) => void} navigate
 */
export function renderUserManagementPage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'user-management', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'User Management',
    subtitle: 'Create, deactivate, suspend, or reactivate accounts in your own barangay',
    icon: icons.users,
  });
  header.appendChild(pageHeader.el);

  let showForm = false;
  const formHost = document.createElement('div');
  const newButton = document.createElement('button');
  newButton.type = 'button';
  newButton.className = 'primary';
  newButton.innerHTML = `<span aria-hidden="true">${icons.plus(16)}</span><span>Add User</span>`;
  newButton.addEventListener('click', () => { showForm = !showForm; renderFormPane(); });
  pageHeader.actions.appendChild(newButton);

  // Search (client-side — see this file's own header for why, unlike
  // Incident Management's/Blotter's server-side `q=`).
  const filterPanel = document.createElement('div');
  filterPanel.className = 'filter-panel';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'filter-panel__search';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'filter-panel__search-icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  searchIcon.innerHTML = icons.search(16);
  const searchLabel = document.createElement('label');
  searchLabel.className = 'sr-only';
  searchLabel.htmlFor = 'user-mgmt-search';
  searchLabel.textContent = 'Search users';
  const searchInput = document.createElement('input');
  searchInput.id = 'user-mgmt-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Search by name or username…';
  searchInput.addEventListener('input', () => renderList(currentTotal));
  searchWrap.append(searchIcon, searchLabel, searchInput);
  filterPanel.appendChild(searchWrap);
  header.appendChild(filterPanel);

  const statStripHost = document.createElement('div');
  content.appendChild(statStripHost);

  const body = document.createElement('div');
  content.append(formHost, body);

  function renderFormPane() {
    formHost.innerHTML = '';
    if (!showForm) return;
    formHost.appendChild(buildCreateForm(() => { showForm = false; renderFormPane(); load(); }));
  }

  let currentPage = 1;
  let allItems = [];
  let currentTotal = 0;
  load();

  async function load() {
    renderLoading(body);
    try {
      const result = await getUsers({ page: currentPage, limit: PAGE_SIZE });
      allItems = result.items;
      currentTotal = result.total;
      renderStatStrip(allItems);
      renderList(result.total);
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading users.';
      renderError(body, message, load);
    }
  }

  /**
   * Role-summary chips (2026-09-05 UX pass) — `StatStrip` already
   * existed as a shared component with this exact use case named in its
   * own header comment ("User Management ('8 Total Users · 6 Active ·
   * …')") but was never actually wired up here. Counts are derived from
   * the loaded page, not a separate aggregate query — accurate as long
   * as a barangay's roster fits on one page, which it always does in
   * practice (see this file's header).
   */
  function renderStatStrip(items) {
    const activeCount = items.filter((u) => u.isActive && !u.isSuspended).length;
    const adminCount = items.filter((u) => u.role === 'admin').length;
    const tanodCount = items.filter((u) => u.role === 'tanod').length;
    statStripHost.innerHTML = '';
    statStripHost.appendChild(StatStrip({
      items: [
        { label: 'Total Users', value: items.length },
        { label: 'Active', value: activeCount, tone: 'success' },
        { label: 'Admins', value: adminCount, tone: 'info' },
        { label: 'Tanods', value: tanodCount },
      ],
    }));
  }

  function renderList(totalItems) {
    body.innerHTML = '';
    const q = searchInput.value.trim().toLowerCase();
    const filtered = q
      ? allItems.filter((u) => u.fullName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
      : allItems;
    body.appendChild(DataTable({
      columns: COLUMNS,
      rows: filtered,
      rowKey: (row) => row.userId,
      caption: 'Users',
      emptyIcon: icons.users,
      emptyMessage: q ? 'No users match your search.' : 'No users found.',
      page: currentPage,
      totalItems: q ? filtered.length : totalItems,
      pageSize: PAGE_SIZE,
      onPageChange: (nextPage) => { currentPage = nextPage; load(); },
      renderCell: (row, key) => renderUserCell(row, key, user, load),
    }));
  }
}

/** @param {() => void} onDone called after a successful create (closes + reloads). */
function buildCreateForm(onDone) {
  const el = document.createElement('form');
  el.className = 'card';

  const fullNameInput = labeledInput('add-user-full-name', 'Full name', 'text');
  const usernameInput = labeledInput('add-user-username', 'Username', 'text');
  usernameInput.input.placeholder = 'lowercase letters, digits, . _ -';
  const passwordInput = labeledInput('add-user-password', 'Initial password', 'password');
  passwordInput.input.placeholder = 'At least 12 characters, mixed case + a digit';
  const contactInput = labeledInput('add-user-contact', 'Contact number (optional)', 'tel', false);

  const roleLabel = document.createElement('label');
  roleLabel.textContent = 'Role';
  roleLabel.htmlFor = 'add-user-role';
  const roleSelect = document.createElement('select');
  roleSelect.id = 'add-user-role';
  for (const role of CREATABLE_ROLES) {
    const option = document.createElement('option');
    option.value = role;
    option.textContent = ROLE_LABELS[role] || role;
    roleSelect.appendChild(option);
  }

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'primary';
  submitButton.textContent = 'Create account';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'ghost';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', onDone);

  el.append(
    fullNameInput.label, fullNameInput.input,
    usernameInput.label, usernameInput.input,
    passwordInput.label, passwordInput.input,
    roleLabel, roleSelect,
    contactInput.label, contactInput.input,
    submitButton, cancelButton
  );

  el.addEventListener('submit', async (event) => {
    event.preventDefault();

    submitButton.disabled = true;
    cancelButton.disabled = true;
    try {
      await createUser({
        fullName: fullNameInput.input.value.trim(),
        username: usernameInput.input.value.trim(),
        password: passwordInput.input.value,
        role: roleSelect.value,
        contactNumber: contactInput.input.value.trim(),
      });
      showToast(`${fullNameInput.input.value.trim()} added.`, { variant: 'success' });
      onDone();
    } catch (err) {
      // Surface the server's real validation/409 message verbatim (bad
      // username shape, weak password, duplicate username) — never a
      // paraphrase that could hide which check actually failed.
      const message = err instanceof ApiClientError ? err.message : 'Could not create this user.';
      showToast(message, { variant: 'error' });
      submitButton.disabled = false;
      cancelButton.disabled = false;
    }
  });

  return el;
}

function labeledInput(id, labelText, type, required = true) {
  const label = document.createElement('label');
  label.textContent = labelText;
  label.htmlFor = id;
  const input = document.createElement('input');
  input.id = id;
  input.type = type;
  input.required = required;
  return { label, input };
}

function renderUserCell(row, key, viewer, reload) {
  switch (key) {
    // Pre-existing gap found while verifying this session's changes (not
    // introduced by them — the switch never had a 'fullName' case, so
    // the Name column always rendered blank; DataTable.js's renderCell
    // contract has no fallback to a raw `row[key]`, per-column render
    // logic owns every column with no exceptions).
    case 'fullName':
      return row.fullName;
    case 'username':
      return row.username;
    case 'role':
      return ROLE_LABELS[row.role] || row.role;
    case 'contactNumber':
      return row.contactNumber || '—';
    case 'status': {
      // Deactivating always wins over suspension for display — a
      // deactivated-and-suspended account is just "Inactive" (migration
      // 0011's own comment). Three real, mutually-exclusive labels, not
      // a single combined enum column on the server.
      const pill = document.createElement('span');
      let label; let toneClass;
      if (!row.isActive) { label = 'Inactive'; toneClass = 'status-pill--neutral'; }
      else if (row.isSuspended) { label = 'Suspended'; toneClass = 'status-pill--critical'; }
      else { label = 'Active'; toneClass = 'status-pill--success'; }
      pill.className = `status-pill ${toneClass}`;
      pill.textContent = label;
      return pill;
    }
    case 'lastLoginAt':
      return row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : '<span class="text-tertiary">Never</span>';
    case 'createdAt':
      return new Date(row.createdAt).toLocaleDateString();
    case 'actions':
      return renderActionsCell(row, viewer, reload);
    default:
      return '';
  }
}

function renderActionsCell(row, viewer, reload) {
  const wrap = document.createElement('span');
  wrap.className = 'data-table__actions';

  // Mirrors the server's own restriction: an admin can never change
  // their own is_active/is_suspended through this endpoint, so there is
  // nothing these buttons could ever do for the signed-in admin's own
  // row.
  if (viewer.userId === row.userId) {
    const note = document.createElement('span');
    note.className = 'data-table__sub';
    note.textContent = '(you)';
    wrap.appendChild(note);
    return wrap;
  }

  if (!row.isActive) {
    wrap.appendChild(buildStatusButton(row, reload, {
      label: 'Reactivate', busyLabel: 'Reactivating…', className: 'primary',
      title: `Reactivate ${row.fullName}?`,
      description: 'They will be able to sign in again.',
      confirmLabel: 'Reactivate', danger: false,
      action: () => setUserActive(row.userId, true),
      successMessage: `${row.fullName} reactivated.`,
    }));
    return wrap;
  }

  if (row.isSuspended) {
    wrap.appendChild(buildStatusButton(row, reload, {
      label: 'Unsuspend', busyLabel: 'Unsuspending…', className: 'primary',
      title: `Unsuspend ${row.fullName}?`,
      description: 'They will be able to sign in again.',
      confirmLabel: 'Unsuspend', danger: false,
      action: () => setUserSuspended(row.userId, false),
      successMessage: `${row.fullName} unsuspended.`,
    }));
  } else {
    wrap.appendChild(buildStatusButton(row, reload, {
      label: 'Suspend', busyLabel: 'Suspending…', className: 'ghost',
      title: `Suspend ${row.fullName}?`,
      description: 'They will be signed out immediately and unable to sign back in until unsuspended.',
      confirmLabel: 'Suspend', danger: true,
      action: () => setUserSuspended(row.userId, true),
      successMessage: `${row.fullName} suspended.`,
    }));
  }

  wrap.appendChild(buildStatusButton(row, reload, {
    label: 'Deactivate', busyLabel: 'Deactivating…', className: 'danger',
    title: `Deactivate ${row.fullName}?`,
    description: 'They will be signed out immediately and unable to sign back in until reactivated.',
    confirmLabel: 'Deactivate', danger: true,
    action: () => setUserActive(row.userId, false),
    successMessage: `${row.fullName} deactivated.`,
  }));

  return wrap;
}

/**
 * Shared button-with-confirm-and-busy-state builder for the three
 * status actions (Suspend/Unsuspend/Deactivate/Reactivate) — one flow,
 * parameterized, rather than four near-identical copies.
 */
function buildStatusButton(row, reload, { label, busyLabel, className, title, description, confirmLabel, danger, action, successMessage }) {
  const button = document.createElement('button');
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const confirmed = await confirmDialog({ title, description, confirmLabel, cancelLabel: 'Cancel', danger });
    if (!confirmed) return;

    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await action();
      showToast(successMessage, { variant: 'info' });
      reload();
    } catch (err) {
      button.disabled = false;
      button.textContent = label;
      // Surface the server's real message (e.g. the last-usable-Admin
      // 409) rather than a paraphrase — the exact reason matters here.
      const message = err instanceof ApiClientError ? err.message : 'Could not update this user.';
      showToast(message, { variant: 'error' });
    }
  });
  return button;
}

function renderLoading(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Loading users');
  for (let i = 0; i < 6; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton--row';
    wrap.appendChild(skeleton);
  }
  container.appendChild(wrap);
}

function renderError(container, message, onRetry) {
  container.innerHTML = '';
  const block = document.createElement('div');
  block.className = 'card state-block state-block--error';
  block.setAttribute('role', 'alert');
  const text = document.createElement('p');
  text.textContent = message;
  const retryButton = document.createElement('button');
  retryButton.className = 'primary';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}
