/**
 * style-guide.js — Living Style-Guide & Component Showcase Route (`#/style-guide`)
 * Displays canonical implementations of all 11 BaranGuard Core Design System (BCDS)
 * component primitives in all states (default, hover, focus, disabled, light, dark).
 */

import { AppShell } from '../components/AppShell.js';
import { PageHeader } from '../components/PageHeader.js';
import { DataTable } from '../components/DataTable.js';
import { confirmDialog } from '../components/ConfirmDialog.js';
import { showToast } from '../components/Toast.js';
import { icons } from '../components/icons.js';
import { logout } from '../api/apiClient.js';

export function renderStyleGuidePage(root, user, onLoggedOut, navigate) {
  root.innerHTML = '';

  const shell = AppShell(user, 'style-guide', navigate, async () => {
    shell.logoutButton.disabled = true;
    await logout();
    onLoggedOut();
  });
  const { header, content } = shell;
  root.appendChild(shell.el);

  const pageHeader = PageHeader({
    title: 'Design System & Style Guide',
    subtitle: 'Living showcase of canonical BaranGuard Core Design System (BCDS) components',
    icon: icons.award || icons.layers,
  });
  header.appendChild(pageHeader.el);

  const container = document.createElement('div');
  container.className = 'page-container';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = 'var(--spacing-xl)';
  container.style.padding = 'var(--spacing-lg)';

  // --- SECTION 1: Status Badges & Pills (WCAG AA Compliant) ---
  const badgeSection = createSection('1. Semantic Status Pills & Badges (WCAG 2.2 AA Contrast >= 4.5:1)');
  const badgeRow = document.createElement('div');
  badgeRow.style.display = 'flex';
  badgeRow.style.flexWrap = 'wrap';
  badgeRow.style.gap = 'var(--spacing-md)';
  badgeRow.style.alignItems = 'center';

  const badgeVariants = [
    { label: 'Critical / Dispatched', pillClass: 'incident-priority-pill--critical' },
    { label: 'High Priority / Pending', pillClass: 'incident-priority-pill--high' },
    { label: 'Medium / Investigating', pillClass: 'incident-priority-pill--medium' },
    { label: 'Low Priority / Resolved', pillClass: 'incident-priority-pill--low' },
    { label: 'Active Tanod', pillClass: 'role-badge--tanod' },
  ];

  for (const b of badgeVariants) {
    const pill = document.createElement('span');
    pill.className = `status-pill ${b.pillClass}`;
    pill.style.padding = '0.25rem 0.75rem';
    pill.style.borderRadius = 'var(--radius-pill)';
    pill.style.fontWeight = '600';
    pill.style.fontSize = 'var(--font-size-xs)';
    pill.textContent = b.label;
    badgeRow.appendChild(pill);
  }
  badgeSection.appendChild(badgeRow);
  container.appendChild(badgeSection);

  // --- SECTION 2: Standard Buttons & Action Triggers ---
  const btnSection = createSection('2. Buttons & Accessible Modals');
  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.flexWrap = 'wrap';
  btnRow.style.gap = 'var(--spacing-md)';
  btnRow.style.alignItems = 'center';

  const primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.className = 'primary';
  primaryBtn.innerHTML = `${icons.check(16)} <span>Primary Button</span>`;
  primaryBtn.addEventListener('click', () => showToast('Primary action triggered!', { variant: 'success' }));

  const secondaryBtn = document.createElement('button');
  secondaryBtn.type = 'button';
  secondaryBtn.className = 'ghost';
  secondaryBtn.textContent = 'Secondary / Ghost Button';
  secondaryBtn.addEventListener('click', () => showToast('Secondary action triggered.', { variant: 'info' }));

  const modalTriggerBtn = document.createElement('button');
  modalTriggerBtn.type = 'button';
  modalTriggerBtn.className = 'ghost';
  modalTriggerBtn.style.color = 'var(--color-critical-text)';
  modalTriggerBtn.textContent = 'Open Destructive ConfirmDialog';
  modalTriggerBtn.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Confirm Destructive Action',
      description: 'Are you sure you want to proceed? This dialog demonstrates accessible focus trapping and Escape key management.',
      confirmLabel: 'Confirm & Delete',
      danger: true,
    });
    if (confirmed) {
      showToast('Action confirmed.', { variant: 'error' });
    }
  });

  btnRow.append(primaryBtn, secondaryBtn, modalTriggerBtn);
  btnSection.appendChild(btnRow);
  container.appendChild(btnSection);

  // --- SECTION 3: Canonical Data Table (Single Table with Chevron Dropdowns & Search) ---
  const tableSection = createSection('3. Canonical Unified Data Table (Single Continuous <table>, Dropdowns with Arrow Down, Standard Search)');
  
  const sampleColumns = [
    { key: 'id', label: 'Reference ID', width: '8rem', sortable: true, sortValue: (r) => r.id },
    { key: 'subject', label: 'Subject / Title', sortable: true, sortValue: (r) => r.subject },
    { key: 'status', label: 'Status', width: '9rem' },
    { key: 'assigned', label: 'Assigned Responder', width: '12rem' },
    { key: 'date', label: 'Timestamp', width: '10rem', align: 'right' },
  ];

  const sampleRows = [
    { id: 'INC-2026-001', subject: 'Noise Complaint along Purok 3', status: 'critical', assigned: 'Tanod Juan dela Cruz', date: '10 mins ago' },
    { id: 'INC-2026-002', subject: 'Minor Vehicular Collision', status: 'high', assigned: 'Tanod Pedro Santos', date: '25 mins ago' },
    { id: 'INC-2026-003', subject: 'Streetlight Outage Inspection', status: 'medium', assigned: 'Tanod Maria Clara', date: '1 hour ago' },
    { id: 'INC-2026-004', subject: 'School Zone Pedestrian Assist', status: 'low', assigned: 'Tanod Andres Bonifacio', date: '3 hours ago' },
  ];

  const tableCard = document.createElement('div');
  tableCard.className = 'unified-table-card';

  // Toolbar with standard search & arrow-down select
  const toolbar = document.createElement('div');
  toolbar.className = 'unified-table-card__header';
  toolbar.style.display = 'flex';
  toolbar.style.flexWrap = 'wrap';
  toolbar.style.alignItems = 'center';
  toolbar.style.justifyContent = 'space-between';
  toolbar.style.gap = 'var(--spacing-md)';
  toolbar.style.padding = 'var(--spacing-md)';
  toolbar.style.borderBottom = '1px solid var(--color-border)';

  const searchBox = document.createElement('div');
  searchBox.className = 'acc-search-box';
  searchBox.style.position = 'relative';
  searchBox.style.display = 'flex';
  searchBox.style.alignItems = 'center';
  searchBox.style.minWidth = '220px';
  searchBox.style.maxWidth = '320px';
  searchBox.style.flex = '1';

  searchBox.innerHTML = `
    <span class="acc-search-icon" style="position:absolute;left:10px;color:var(--color-text-tertiary);pointer-events:none;">
      ${icons.search ? icons.search(16) : '🔍'}
    </span>
    <input type="text" class="acc-search-input" placeholder="Search standard table..." aria-label="Search standard table" style="width:100%;height:var(--control-height,2.25rem);padding-left:34px;padding-right:12px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface);color:var(--color-text-primary);font-size:var(--font-size-sm);" />
  `;

  const filterWrap = document.createElement('div');
  filterWrap.style.display = 'flex';
  filterWrap.style.alignItems = 'center';
  filterWrap.style.gap = 'var(--spacing-sm)';

  const select = document.createElement('select');
  select.className = 'acc-status-select';
  select.setAttribute('aria-label', 'Filter sample status');
  select.innerHTML = `
    <option value="all">All Statuses (Dropdown with Arrow ▼)</option>
    <option value="critical">Critical Priority</option>
    <option value="high">High Priority</option>
    <option value="medium">Medium Priority</option>
    <option value="low">Resolved</option>
  `;

  filterWrap.appendChild(select);
  toolbar.append(searchBox, filterWrap);
  tableCard.appendChild(toolbar);

  const dataTableEl = DataTable({
    columns: sampleColumns,
    rows: sampleRows,
    rowKey: (r) => r.id,
    renderCell: (row, colKey) => {
      switch (colKey) {
        case 'id':
          return `<strong style="font-family:var(--font-mono);">${row.id}</strong>`;
        case 'subject':
          return row.subject;
        case 'status': {
          const pillClass = row.status === 'critical' ? 'incident-priority-pill--critical'
            : row.status === 'high' ? 'incident-priority-pill--high'
            : row.status === 'medium' ? 'incident-priority-pill--medium'
            : 'incident-priority-pill--low';
          return `<span class="status-pill ${pillClass}" style="padding:0.2rem 0.6rem;border-radius:var(--radius-pill);font-size:var(--font-size-xs);font-weight:600;">${row.status.toUpperCase()}</span>`;
        }
        case 'assigned':
          return row.assigned;
        case 'date':
          return `<span style="color:var(--color-text-tertiary);font-size:var(--font-size-xs);">${row.date}</span>`;
        default:
          return '';
      }
    },
    page: 1,
    totalItems: sampleRows.length,
    pageSize: 10,
    onPageChange: () => {},
  });

  tableCard.appendChild(dataTableEl);
  tableSection.appendChild(tableCard);
  container.appendChild(tableSection);

  content.appendChild(container);

  function createSection(title) {
    const sec = document.createElement('section');
    sec.style.background = 'var(--color-surface)';
    sec.style.border = '1px solid var(--color-border)';
    sec.style.borderRadius = 'var(--radius-md)';
    sec.style.padding = 'var(--spacing-lg)';
    sec.style.display = 'flex';
    sec.style.flexDirection = 'column';
    sec.style.gap = 'var(--spacing-md)';

    const heading = document.createElement('h3');
    heading.style.margin = '0';
    heading.style.fontSize = 'var(--font-size-md)';
    heading.style.fontWeight = '700';
    heading.style.color = 'var(--color-text-primary)';
    heading.textContent = title;
    sec.appendChild(heading);
    return sec;
  }
}
