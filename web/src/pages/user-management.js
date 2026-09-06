/**
 * user-management.js — Personnel > Users Tab.
 * Overhauled UI/UX:
 * - Floating Add User modal dialog with 2-column layout and password visibility toggle
 * - Identity cell with initials avatar and styled username
 * - Interactive filter bar with role chips, status chips, and live search
 * - Clickable StatStrip to quickly filter by user segment
 * - High-density action buttons with confirmation dialogs
 */

import { getUsers, setUserActive, setUserSuspended, createUser, ApiClientError } from '../api/apiClient.js';
import { StatStrip } from '../components/StatStrip.js';
import { DataTable } from '../components/DataTable.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { showToast } from '../components/Toast.js';
import { icons } from '../components/icons.js';
import { avatarInitials } from '../components/Avatar.js';

const PAGE_SIZE = 25;

const ROLE_LABELS = {
  admin: 'Admin',
  secretary: 'Secretary',
  tanod: 'Tanod',
  punong_barangay: 'Punong Barangay',
  lupon: 'Lupon',
};

const CREATABLE_ROLES = ['admin', 'secretary', 'tanod', 'punong_barangay'];

const COLUMNS = [
  { key: 'user', label: 'User' },
  { key: 'role', label: 'Role' },
  { key: 'contactNumber', label: 'Contact' },
  { key: 'status', label: 'Status' },
  { key: 'lastLoginAt', label: 'Last Login' },
  { key: 'createdAt', label: 'Created' },
  { key: 'actions', label: 'Actions', align: 'right' },
];

/**
 * Personnel > Users tab.
 *
 * @param {HTMLElement} container tab body to render into
 * @param {ReturnType<import('../components/PageHeader.js').PageHeader>} pageHeader shared page header
 * @param {{userId:number, fullName:string, role:string}} viewer signed-in user
 */
export function renderUsersTab(container, pageHeader, viewer) {
  // Page Header action: Add User opens modal
  const newButton = document.createElement('button');
  newButton.type = 'button';
  newButton.className = 'primary';
  newButton.innerHTML = `<span aria-hidden="true">${icons.plus(16)}</span><span>Add User</span>`;
  newButton.addEventListener('click', () => openCreateModal());
  pageHeader.actions.appendChild(newButton);

  // Active filters state
  let selectedRole = 'all';
  let selectedStatus = 'all';
  let searchQuery = '';

  // Filter bar
  const filterBar = document.createElement('div');
  filterBar.className = 'personnel-filter-bar';

  // Left: Search
  const filterLeft = document.createElement('div');
  filterLeft.className = 'personnel-filter-bar__left';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'personnel-search-wrap';

  const searchIcon = document.createElement('span');
  searchIcon.className = 'personnel-search-icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  searchIcon.innerHTML = icons.search(16);

  const searchInput = document.createElement('input');
  searchInput.id = 'user-mgmt-search';
  searchInput.type = 'search';
  searchInput.className = 'personnel-search-input';
  searchInput.placeholder = 'Search by name or username…';
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderFilteredList();
  });

  searchWrap.append(searchIcon, searchInput);
  filterLeft.appendChild(searchWrap);

  // Right: Role & Status filter chips
  const filterRight = document.createElement('div');
  filterRight.className = 'personnel-filter-bar__right';

  const roleFilters = [
    { id: 'all', label: 'All Roles' },
    { id: 'admin', label: 'Admins' },
    { id: 'secretary', label: 'Secretaries' },
    { id: 'tanod', label: 'Tanods' },
    { id: 'punong_barangay', label: 'Punong Brgy' },
  ];

  const roleChipBtns = [];
  roleFilters.forEach((rf) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `personnel-filter-chip ${selectedRole === rf.id ? 'is-active' : ''}`;
    chip.textContent = rf.label;
    chip.addEventListener('click', () => {
      selectedRole = rf.id;
      roleChipBtns.forEach((b) => b.classList.remove('is-active'));
      chip.classList.add('is-active');
      renderFilteredList();
    });
    roleChipBtns.push(chip);
    filterRight.appendChild(chip);
  });

  // Status divider / separator
  const statusDivider = document.createElement('span');
  statusDivider.style.cssText = 'width: 1px; height: 16px; background: var(--color-border); margin: 0 4px;';
  filterRight.appendChild(statusDivider);

  const statusFilters = [
    { id: 'all', label: 'All Status' },
    { id: 'active', label: 'Active' },
    { id: 'suspended', label: 'Suspended' },
    { id: 'inactive', label: 'Inactive' },
  ];

  const statusChipBtns = [];
  statusFilters.forEach((sf) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `personnel-filter-chip ${selectedStatus === sf.id ? 'is-active' : ''}`;
    chip.textContent = sf.label;
    chip.addEventListener('click', () => {
      selectedStatus = sf.id;
      statusChipBtns.forEach((b) => b.classList.remove('is-active'));
      chip.classList.add('is-active');
      renderFilteredList();
    });
    statusChipBtns.push(chip);
    filterRight.appendChild(chip);
  });

  filterBar.append(filterLeft, filterRight);
  container.appendChild(filterBar);

  // Stat Strip Host
  const statStripHost = document.createElement('div');
  container.appendChild(statStripHost);

  // Main Content Body
  const body = document.createElement('div');
  container.appendChild(body);

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
      renderFilteredList();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Something went wrong loading users.';
      renderError(body, message, load);
    }
  }

  function renderStatStrip(items) {
    const activeCount = items.filter((u) => u.isActive && !u.isSuspended).length;
    const adminCount = items.filter((u) => u.role === 'admin').length;
    const tanodCount = items.filter((u) => u.role === 'tanod').length;
    statStripHost.innerHTML = '';

    const strip = StatStrip({
      items: [
        { label: 'Total Users', value: items.length },
        { label: 'Active', value: activeCount, tone: 'success' },
        { label: 'Admins', value: adminCount, tone: 'info' },
        { label: 'Tanods', value: tanodCount },
      ],
    });

    // Make stats interactive shortcuts
    const statCards = strip.querySelectorAll('.stat-card');
    if (statCards[0]) {
      statCards[0].style.cursor = 'pointer';
      statCards[0].title = 'Show All Users';
      statCards[0].addEventListener('click', () => {
        selectedRole = 'all';
        selectedStatus = 'all';
        roleChipBtns.forEach((b, i) => b.classList.toggle('is-active', i === 0));
        statusChipBtns.forEach((b, i) => b.classList.toggle('is-active', i === 0));
        renderFilteredList();
      });
    }
    if (statCards[1]) {
      statCards[1].style.cursor = 'pointer';
      statCards[1].title = 'Filter: Active Only';
      statCards[1].addEventListener('click', () => {
        selectedStatus = 'active';
        statusChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent === 'Active'));
        renderFilteredList();
      });
    }
    if (statCards[2]) {
      statCards[2].style.cursor = 'pointer';
      statCards[2].title = 'Filter: Admins Only';
      statCards[2].addEventListener('click', () => {
        selectedRole = 'admin';
        roleChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent === 'Admins'));
        renderFilteredList();
      });
    }
    if (statCards[3]) {
      statCards[3].style.cursor = 'pointer';
      statCards[3].title = 'Filter: Tanods Only';
      statCards[3].addEventListener('click', () => {
        selectedRole = 'tanod';
        roleChipBtns.forEach((b) => b.classList.toggle('is-active', b.textContent === 'Tanods'));
        renderFilteredList();
      });
    }

    statStripHost.appendChild(strip);
  }

  function getFilteredItems() {
    return allItems.filter((u) => {
      // Role filter
      if (selectedRole !== 'all' && u.role !== selectedRole) {
        return false;
      }
      // Status filter
      if (selectedStatus === 'active' && (!u.isActive || u.isSuspended)) {
        return false;
      }
      if (selectedStatus === 'suspended' && (!u.isActive || !u.isSuspended)) {
        return false;
      }
      if (selectedStatus === 'inactive' && u.isActive) {
        return false;
      }
      // Search query
      if (searchQuery) {
        const nameMatch = (u.fullName || '').toLowerCase().includes(searchQuery);
        const userMatch = (u.username || '').toLowerCase().includes(searchQuery);
        const contactMatch = (u.contactNumber || '').toLowerCase().includes(searchQuery);
        if (!nameMatch && !userMatch && !contactMatch) return false;
      }
      return true;
    });
  }

  function renderFilteredList() {
    body.innerHTML = '';
    const filtered = getFilteredItems();

    body.appendChild(DataTable({
      columns: COLUMNS,
      rows: filtered,
      rowKey: (row) => row.userId,
      caption: 'Users Roster',
      emptyIcon: icons.users,
      emptyMessage: (searchQuery || selectedRole !== 'all' || selectedStatus !== 'all')
        ? 'No users match the selected filters.'
        : 'No users found.',
      page: currentPage,
      totalItems: (searchQuery || selectedRole !== 'all' || selectedStatus !== 'all') ? filtered.length : currentTotal,
      pageSize: PAGE_SIZE,
      onPageChange: (nextPage) => { currentPage = nextPage; load(); },
      renderCell: (row, key) => renderUserCell(row, key, viewer, load),
    }));
  }

  function openCreateModal() {
    const modalEl = buildCreateModal(() => {
      document.body.removeChild(modalEl);
      load();
    }, () => {
      document.body.removeChild(modalEl);
    });
    document.body.appendChild(modalEl);
  }
}

/**
 * Builds the floating modal for creating a new user account.
 */
function buildCreateModal(onSuccess, onCancel) {
  const overlay = document.createElement('div');
  overlay.className = 'personnel-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'personnel-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'create-user-modal-title');

  // Header
  const header = document.createElement('div');
  header.className = 'personnel-modal__header';

  const title = document.createElement('h3');
  title.id = 'create-user-modal-title';
  title.className = 'personnel-modal__title';
  title.innerHTML = `<span aria-hidden="true">${icons.users(20)}</span><span>Add New User Account</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'personnel-modal__close';
  closeBtn.innerHTML = icons.x(18);
  closeBtn.setAttribute('aria-label', 'Close modal');
  closeBtn.addEventListener('click', onCancel);

  header.append(title, closeBtn);

  // Form Body
  const form = document.createElement('form');

  const body = document.createElement('div');
  body.className = 'personnel-modal__body';

  const grid = document.createElement('div');
  grid.className = 'personnel-form-grid';

  // Full Name
  const fullNameField = document.createElement('div');
  fullNameField.className = 'personnel-form-field';
  const fullNameLabel = document.createElement('label');
  fullNameLabel.className = 'personnel-form-label';
  fullNameLabel.htmlFor = 'modal-full-name';
  fullNameLabel.textContent = 'Full Name *';
  const fullNameInput = document.createElement('input');
  fullNameInput.id = 'modal-full-name';
  fullNameInput.type = 'text';
  fullNameInput.className = 'personnel-form-input';
  fullNameInput.placeholder = 'e.g. Juan dela Cruz';
  fullNameInput.required = true;
  fullNameField.append(fullNameLabel, fullNameInput);

  // Username
  const usernameField = document.createElement('div');
  usernameField.className = 'personnel-form-field';
  const usernameLabel = document.createElement('label');
  usernameLabel.className = 'personnel-form-label';
  usernameLabel.htmlFor = 'modal-username';
  usernameLabel.textContent = 'Username *';
  const usernameInput = document.createElement('input');
  usernameInput.id = 'modal-username';
  usernameInput.type = 'text';
  usernameInput.className = 'personnel-form-input';
  usernameInput.placeholder = 'letters, numbers, . _ -';
  usernameInput.required = true;
  usernameField.append(usernameLabel, usernameInput);

  // Password with Show/Hide toggle
  const passwordField = document.createElement('div');
  passwordField.className = 'personnel-form-field personnel-form-field--full';
  const passwordLabel = document.createElement('label');
  passwordLabel.className = 'personnel-form-label';
  passwordLabel.htmlFor = 'modal-password';
  passwordLabel.textContent = 'Initial Password *';

  const passWrap = document.createElement('div');
  passWrap.style.cssText = 'position: relative; display: flex; align-items: center;';

  const passwordInput = document.createElement('input');
  passwordInput.id = 'modal-password';
  passwordInput.type = 'password';
  passwordInput.className = 'personnel-form-input';
  passwordInput.placeholder = 'At least 12 characters, mixed case + a digit';
  passwordInput.required = true;
  passwordInput.style.cssText = 'width: 100%; padding-right: 2.5rem;';

  const passToggle = document.createElement('button');
  passToggle.type = 'button';
  passToggle.setAttribute('aria-label', 'Toggle password visibility');
  passToggle.style.cssText = 'position: absolute; right: 0.5rem; background: none; border: none; cursor: pointer; color: var(--color-text-secondary); display: flex; align-items: center; padding: 4px;';
  passToggle.innerHTML = icons.eye(16);
  let isPassVisible = false;
  passToggle.addEventListener('click', () => {
    isPassVisible = !isPassVisible;
    passwordInput.type = isPassVisible ? 'text' : 'password';
    passToggle.innerHTML = isPassVisible ? icons.eyeOff(16) : icons.eye(16);
  });

  passWrap.append(passwordInput, passToggle);
  const passHint = document.createElement('span');
  passHint.className = 'personnel-form-hint';
  passHint.textContent = 'Account holder will use this password to sign in initially.';
  passwordField.append(passwordLabel, passWrap, passHint);

  // Role
  const roleField = document.createElement('div');
  roleField.className = 'personnel-form-field';
  const roleLabel = document.createElement('label');
  roleLabel.className = 'personnel-form-label';
  roleLabel.htmlFor = 'modal-role';
  roleLabel.textContent = 'Role *';
  const roleSelect = document.createElement('select');
  roleSelect.id = 'modal-role';
  roleSelect.className = 'personnel-form-select';
  for (const r of CREATABLE_ROLES) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = ROLE_LABELS[r] || r;
    roleSelect.appendChild(opt);
  }
  roleField.append(roleLabel, roleSelect);

  // Contact
  const contactField = document.createElement('div');
  contactField.className = 'personnel-form-field';
  const contactLabel = document.createElement('label');
  contactLabel.className = 'personnel-form-label';
  contactLabel.htmlFor = 'modal-contact';
  contactLabel.textContent = 'Contact Number';
  const contactInput = document.createElement('input');
  contactInput.id = 'modal-contact';
  contactInput.type = 'tel';
  contactInput.className = 'personnel-form-input';
  contactInput.placeholder = 'e.g. 0917-123-4567';
  contactField.append(contactLabel, contactInput);

  grid.append(fullNameField, usernameField, passwordField, roleField, contactField);
  body.appendChild(grid);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'personnel-modal__footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'primary';
  submitBtn.innerHTML = `<span aria-hidden="true">${icons.plus(16)}</span><span>Create Account</span>`;

  footer.append(cancelBtn, submitBtn);
  form.append(body, footer);
  modal.append(header, form);
  overlay.appendChild(modal);

  // Backdrop click and Esc to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) onCancel();
  });
  const handleKeydown = (e) => {
    if (e.key === 'Escape') {
      window.removeEventListener('keydown', handleKeydown);
      onCancel();
    }
  };
  window.addEventListener('keydown', handleKeydown);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = 'Creating…';

    try {
      await createUser({
        fullName: fullNameInput.value.trim(),
        username: usernameInput.value.trim(),
        password: passwordInput.value,
        role: roleSelect.value,
        contactNumber: contactInput.value.trim(),
      });
      showToast(`${fullNameInput.value.trim()} added.`, { variant: 'success' });
      window.removeEventListener('keydown', handleKeydown);
      onSuccess();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Could not create this user.';
      showToast(message, { variant: 'error' });
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.innerHTML = `<span aria-hidden="true">${icons.plus(16)}</span><span>Create Account</span>`;
    }
  });

  // Focus first input
  setTimeout(() => fullNameInput.focus(), 50);

  return overlay;
}

/**
 * Cell renderers
 */
function renderUserCell(row, key, viewer, reload) {
  switch (key) {
    case 'user': {
      const cell = document.createElement('div');
      cell.className = 'user-identity-cell';

      // Avatar circle
      const avatarWrap = document.createElement('div');
      avatarWrap.innerHTML = avatarInitials(row.fullName, 32);

      // Name & Monospace Username
      const infoWrap = document.createElement('div');
      infoWrap.className = 'user-identity-info';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'user-identity-name';
      nameSpan.textContent = row.fullName;

      const userSpan = document.createElement('span');
      userSpan.className = 'user-identity-username';
      userSpan.textContent = `@${row.username}`;

      infoWrap.append(nameSpan, userSpan);
      cell.append(avatarWrap.firstElementChild || avatarWrap, infoWrap);
      return cell;
    }

    case 'role': {
      const badge = document.createElement('span');
      badge.className = `user-role-badge user-role-badge--${row.role}`;
      badge.textContent = ROLE_LABELS[row.role] || row.role;
      return badge;
    }

    case 'contactNumber': {
      if (!row.contactNumber) {
        return '<span class="text-tertiary">—</span>';
      }
      return row.contactNumber;
    }

    case 'status': {
      const pill = document.createElement('span');
      let label;
      let toneClass;
      if (!row.isActive) {
        label = 'Inactive';
        toneClass = 'status-pill--neutral';
      } else if (row.isSuspended) {
        label = 'Suspended';
        toneClass = 'status-pill--critical';
      } else {
        label = 'Active';
        toneClass = 'status-pill--success';
      }
      pill.className = `status-pill ${toneClass}`;
      pill.textContent = label;
      return pill;
    }

    case 'lastLoginAt': {
      return row.lastLoginAt
        ? new Date(row.lastLoginAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        : '<span class="text-tertiary">Never</span>';
    }

    case 'createdAt': {
      return new Date(row.createdAt).toLocaleDateString();
    }

    case 'actions': {
      return renderActionsCell(row, viewer, reload);
    }

    default:
      return '';
  }
}

function renderActionsCell(row, viewer, reload) {
  const wrap = document.createElement('div');
  wrap.className = 'user-actions-group';

  if (viewer.userId === row.userId) {
    const note = document.createElement('span');
    note.className = 'data-table__sub';
    note.textContent = '(you)';
    wrap.appendChild(note);
    return wrap;
  }

  if (!row.isActive) {
    wrap.appendChild(buildStatusButton(row, reload, {
      label: 'Reactivate',
      busyLabel: 'Reactivating…',
      className: 'user-action-btn user-action-btn--primary',
      title: `Reactivate ${row.fullName}?`,
      description: 'They will be able to sign in again.',
      confirmLabel: 'Reactivate',
      danger: false,
      action: () => setUserActive(row.userId, true),
      successMessage: `${row.fullName} reactivated.`,
    }));
    return wrap;
  }

  if (row.isSuspended) {
    wrap.appendChild(buildStatusButton(row, reload, {
      label: 'Unsuspend',
      busyLabel: 'Unsuspending…',
      className: 'user-action-btn user-action-btn--primary',
      title: `Unsuspend ${row.fullName}?`,
      description: 'They will be able to sign in again.',
      confirmLabel: 'Unsuspend',
      danger: false,
      action: () => setUserSuspended(row.userId, false),
      successMessage: `${row.fullName} unsuspended.`,
    }));
  } else {
    wrap.appendChild(buildStatusButton(row, reload, {
      label: 'Suspend',
      busyLabel: 'Suspending…',
      className: 'user-action-btn',
      title: `Suspend ${row.fullName}?`,
      description: 'They will be signed out immediately and unable to sign back in until unsuspended.',
      confirmLabel: 'Suspend',
      danger: true,
      action: () => setUserSuspended(row.userId, true),
      successMessage: `${row.fullName} suspended.`,
    }));
  }

  wrap.appendChild(buildStatusButton(row, reload, {
    label: 'Deactivate',
    busyLabel: 'Deactivating…',
    className: 'user-action-btn user-action-btn--danger',
    title: `Deactivate ${row.fullName}?`,
    description: 'They will be signed out immediately and unable to sign back in until reactivated.',
    confirmLabel: 'Deactivate',
    danger: true,
    action: () => setUserActive(row.userId, false),
    successMessage: `${row.fullName} deactivated.`,
  }));

  return wrap;
}

function buildStatusButton(row, reload, { label, busyLabel, className, title, description, confirmLabel, danger, action, successMessage }) {
  const button = document.createElement('button');
  button.type = 'button';
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
  retryButton.type = 'button';
  retryButton.className = 'primary';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', onRetry);
  block.append(text, retryButton);
  container.appendChild(block);
}
