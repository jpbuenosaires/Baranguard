/**
 * IncidentCaseCards — the two per-incident panels added by the 2026-10
 * tanod-workflow contract (docs/FEATURE_CONTRACT_2026-10.md §5, §7), shared
 * by the Incident Record page and Incident Management's detail pane so the
 * two screens cannot drift apart:
 *
 *   - SchoolC1Card   the school link + Annex C-1 fields (`c1_summary`,
 *                    `c1_action_taken`, `c1_status_notes`). Edited by Admin
 *                    and Secretary through PATCH /incidents/:id.
 *   - ReferralsCard  who the incident was referred to (GET/POST
 *                    /incidents/:id/referrals), plus openReferralDialog(),
 *                    which the Dispatch Center's "Delegated to" action
 *                    reuses.
 *
 * Wording rule (contract §5): a referral records that an incident was
 * REFERRED. Nothing here says or implies the other party accepted,
 * responded or arrived — the system has no such signal.
 *
 * Every card owns its four states (loading / empty / error with retry /
 * populated) and builds its DOM with textContent only (never interpolates
 * server text into innerHTML).
 */

import {
  getIncidentSchoolFields, updateIncidentSchoolFields, getSchools,
  getIncidentReferrals, createIncidentReferral, REFERRED_TO_OPTIONS, referredToLabel,
} from '../services/shellWorkflowApi.js';
import { ApiClientError, setRelatedIncident } from '../api/apiClient.js';
import { confirmDialog } from './ConfirmDialog.js';
import { showToast } from './Toast.js';
import { icons } from './icons.js';

const C1_FIELDS = [
  { key: 'c1Summary', label: 'Summary (Annex C-1)', hint: 'Short and factual.' },
  { key: 'c1ActionTaken', label: 'Action taken', hint: '' },
  { key: 'c1StatusNotes', label: 'Status notes', hint: '' },
];
const C1_MAX = 500;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function loadingBlock(label) {
  const wrap = el('div', 'stack');
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', label);
  for (let i = 0; i < 2; i++) wrap.appendChild(el('div', 'skeleton skeleton--row'));
  return wrap;
}

function errorBlock(message, onRetry) {
  const block = el('div', 'state-block state-block--error');
  block.setAttribute('role', 'alert');
  const text = el('p', '', message);
  const retry = el('button', 'primary', 'Retry');
  retry.type = 'button';
  retry.addEventListener('click', onRetry);
  block.append(text, retry);
  return block;
}

function cardHeading(iconFn, title) {
  const heading = el('h3');
  heading.style.cssText = 'margin-top:0; margin-bottom: var(--spacing-sm); display:flex; align-items:center;';
  heading.classList.add('case-card__heading');
  const icon = el('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = iconFn(18); // static SVG from icons.js, never server data
  heading.append(icon, el('span', '', title));
  return heading;
}

function fieldRow(label, value) {
  const row = el('div', 'case-card__field');
  row.append(el('span', 'meta-tile__label', label), el('span', 'meta-tile__value', value));
  return row;
}

// --- School link + Annex C-1 ---------------------------------------------------

/**
 * @param {{incidentId:number, canEdit:boolean}} opts
 * @returns {HTMLElement}
 */
export function SchoolC1Card({ incidentId, canEdit }) {
  const card = el('section', 'card case-card case-card--school');
  card.setAttribute('aria-label', 'School link and Annex C-1');
  let editing = false;
  let data = null;
  let schools = [];

  load();

  async function load() {
    card.innerHTML = '';
    card.setAttribute('aria-busy', 'true');
    card.append(cardHeading(icons.mapPin, 'School link and C-1'), loadingBlock('Loading school details'));
    try {
      [data, schools] = await Promise.all([getIncidentSchoolFields(incidentId), getSchools()]);
      card.setAttribute('aria-busy', 'false');
      render();
    } catch (err) {
      card.setAttribute('aria-busy', 'false');
      card.innerHTML = '';
      card.append(
        cardHeading(icons.mapPin, 'School link and C-1'),
        errorBlock(err instanceof ApiClientError ? err.message : 'Could not load the school details.', load),
      );
    }
  }

  function schoolName(id) {
    if (id == null) return null;
    return schools.find((s) => s.schoolId === id)?.name ?? `School #${id}`;
  }

  function render() {
    card.innerHTML = '';
    card.appendChild(cardHeading(icons.mapPin, 'School link and C-1'));
    if (editing) {
      card.appendChild(buildForm());
      return;
    }

    const linked = data.schoolId != null;
    const hasC1 = C1_FIELDS.some((f) => data[f.key]);
    if (!linked && !hasC1) {
      card.appendChild(el('p', 'note', 'This incident is not linked to a school and has no C-1 details.'));
    } else {
      card.appendChild(fieldRow('School', linked ? schoolName(data.schoolId) : 'Not linked'));
      for (const f of C1_FIELDS) card.appendChild(fieldRow(f.label, data[f.key] || '—'));
    }
    if (canEdit) {
      const edit = el('button', 'ghost', 'Edit school and C-1');
      edit.type = 'button';
      edit.addEventListener('click', () => { editing = true; render(); });
      card.appendChild(edit);
    }
  }

  function buildForm() {
    const form = el('form', 'form-stack');
    form.noValidate = true;
    const errorBox = el('div', 'login-form__error');
    errorBox.setAttribute('role', 'alert');
    errorBox.hidden = true;

    const idBase = `school-c1-${incidentId}`;
    const schoolLabel = el('label', 'label', 'School');
    schoolLabel.htmlFor = `${idBase}-school`;
    const select = el('select', 'personnel-form-select');
    select.id = `${idBase}-school`;
    const none = el('option', '', 'Not linked to a school');
    none.value = '';
    select.appendChild(none);
    for (const s of schools) {
      // An inactive school stays selectable only if it is the current link.
      if (!s.isActive && s.schoolId !== data.schoolId) continue;
      const opt = el('option', '', s.isActive ? s.name : `${s.name} (inactive)`);
      opt.value = String(s.schoolId);
      if (s.schoolId === data.schoolId) opt.selected = true;
      select.appendChild(opt);
    }
    if (data.schoolId != null && !schools.some((s) => s.schoolId === data.schoolId)) {
      const opt = el('option', '', `School #${data.schoolId}`);
      opt.value = String(data.schoolId);
      opt.selected = true;
      select.appendChild(opt);
    }
    form.append(errorBox, schoolLabel, select);

    const inputs = {};
    for (const f of C1_FIELDS) {
      const label = el('label', 'label', f.label);
      label.htmlFor = `${idBase}-${f.key}`;
      const area = el('textarea', 'personnel-form-input');
      area.id = `${idBase}-${f.key}`;
      area.rows = 2;
      area.maxLength = C1_MAX;
      area.value = data[f.key] ?? '';
      inputs[f.key] = area;
      form.append(label, area);
    }
    form.appendChild(el('p', 'note', 'Keep these short and factual. Never enter the name of a victim or a student.'));

    const actions = el('div', 'availability-item__actions');
    const save = el('button', 'primary', 'Save');
    save.type = 'submit';
    const cancel = el('button', 'ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { editing = false; render(); });
    actions.append(save, cancel);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.hidden = true;
      save.disabled = true;
      save.textContent = 'Saving…';
      const next = {
        schoolId: select.value === '' ? null : Number(select.value),
        c1Summary: inputs.c1Summary.value.trim() || null,
        c1ActionTaken: inputs.c1ActionTaken.value.trim() || null,
        c1StatusNotes: inputs.c1StatusNotes.value.trim() || null,
      };
      try {
        await updateIncidentSchoolFields(incidentId, next, crypto.randomUUID());
        data = next;
        editing = false;
        showToast('School and C-1 details saved.', { variant: 'success' });
        render();
      } catch (err) {
        errorBox.textContent = err instanceof ApiClientError ? err.message : 'Could not save these details.';
        errorBox.hidden = false;
        save.disabled = false;
        save.textContent = 'Save';
      }
    });
    return form;
  }

  return card;
}

// --- Referrals --------------------------------------------------------------------

/**
 * Modal form that records a referral for one incident. Used by the
 * Referrals card below and by the Dispatch Center's "Delegated to" action.
 *
 * @param {{incidentId:number, incidentLabel?:string, onCreated?:(referral:object)=>void}} opts
 */
export function openReferralDialog({ incidentId, incidentLabel, onCreated }) {
  const previouslyFocused = document.activeElement;
  const overlay = el('div', 'personnel-modal-overlay');
  const modal = el('div', 'personnel-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'referral-dialog-title');

  const header = el('div', 'personnel-modal__header');
  const title = el('h3', 'personnel-modal__title', incidentLabel ? `Delegated to — ${incidentLabel}` : 'Delegated to');
  title.id = 'referral-dialog-title';
  const closeBtn = el('button', 'personnel-modal__close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = icons.x(18);
  header.append(title, closeBtn);

  const form = el('form');
  form.noValidate = true;
  const body = el('div', 'personnel-modal__body');

  const errorBox = el('div', 'login-form__error');
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  const intro = el(
    'p',
    'note',
    'Records that this incident was referred to another party. It does not mean they accepted it, responded, or arrived.',
  );

  const field = (id, labelText, control) => {
    const wrap = el('div', 'personnel-form-field personnel-form-field--full');
    const label = el('label', 'personnel-form-label', labelText);
    label.htmlFor = id;
    control.id = id;
    wrap.append(label, control);
    return wrap;
  };

  const referredTo = el('select', 'personnel-form-select');
  for (const o of REFERRED_TO_OPTIONS) {
    const opt = el('option', '', o.label);
    opt.value = o.value;
    referredTo.appendChild(opt);
  }
  const otherText = el('input', 'personnel-form-input');
  otherText.type = 'text';
  otherText.maxLength = 100;
  const contactName = el('input', 'personnel-form-input');
  contactName.type = 'text';
  contactName.maxLength = 100;
  contactName.placeholder = 'Responding unit or official, not a citizen';
  const referredAt = el('input', 'personnel-form-input');
  referredAt.type = 'datetime-local';
  const referenceNo = el('input', 'personnel-form-input');
  referenceNo.type = 'text';
  referenceNo.maxLength = 64;

  const otherField = field('referral-other-text', 'Specify (required for Other)', otherText);
  const syncOther = () => {
    const isOther = referredTo.value === 'other';
    otherField.querySelector('label').textContent = isOther ? 'Specify (required for Other)' : 'Label (optional)';
  };
  referredTo.addEventListener('change', syncOther);
  syncOther();

  body.append(
    errorBox,
    intro,
    field('referral-referred-to', 'Delegated / referred to', referredTo),
    otherField,
    field('referral-contact-name', 'Unit or official (optional)', contactName),
    field('referral-referred-at', 'When (optional — leave blank for now)', referredAt),
    field('referral-reference-no', 'Reference number (optional)', referenceNo),
  );

  const footer = el('div', 'personnel-modal__footer');
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.type = 'button';
  const save = el('button', 'primary', 'Record referral');
  save.type = 'submit';
  footer.append(cancel, save);

  form.append(body, footer);
  modal.append(header, form);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  referredTo.focus();

  const close = () => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
  };
  closeBtn.addEventListener('click', close);
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    if (referredTo.value === 'other' && !otherText.value.trim()) {
      errorBox.textContent = 'Please say who the incident was referred to.';
      errorBox.hidden = false;
      return;
    }
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const referral = await createIncidentReferral(incidentId, {
        referredTo: referredTo.value,
        otherText: otherText.value.trim(),
        contactName: contactName.value.trim(),
        referredAt: referredAt.value,
        referenceNo: referenceNo.value.trim(),
      }, crypto.randomUUID());
      showToast('Referral recorded.', { variant: 'success' });
      close();
      if (onCreated) onCreated(referral);
    } catch (err) {
      errorBox.textContent = err instanceof ApiClientError ? err.message : 'Could not record this referral.';
      errorBox.hidden = false;
      save.disabled = false;
      save.textContent = 'Record referral';
    }
  });
}

function formatReferredAt(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' });
}

/**
 * @param {{incidentId:number, canAdd:boolean, incidentLabel?:string}} opts
 * @returns {HTMLElement}
 */
export function ReferralsCard({ incidentId, canAdd, incidentLabel }) {
  const card = el('section', 'card case-card case-card--referrals');
  card.setAttribute('aria-label', 'Referrals');

  load();

  async function load() {
    card.innerHTML = '';
    card.setAttribute('aria-busy', 'true');
    card.append(cardHeading(icons.send, 'Referrals'), loadingBlock('Loading referrals'));
    try {
      const items = await getIncidentReferrals(incidentId);
      card.setAttribute('aria-busy', 'false');
      render(items);
    } catch (err) {
      card.setAttribute('aria-busy', 'false');
      card.innerHTML = '';
      card.append(
        cardHeading(icons.send, 'Referrals'),
        errorBlock(err instanceof ApiClientError ? err.message : 'Could not load the referrals.', load),
      );
    }
  }

  function render(items) {
    card.innerHTML = '';
    card.appendChild(cardHeading(icons.send, 'Referrals'));
    if (items.length === 0) {
      card.appendChild(el('p', 'note', 'This incident has not been referred to any other party.'));
    } else {
      const list = el('ul', 'case-card__list');
      for (const r of items) {
        const li = el('li', 'case-card__list-item');
        const label = r.otherText && r.referredTo === 'other' ? r.otherText : referredToLabel(r.referredTo);
        li.appendChild(el('strong', '', `Referred to ${label}`));
        if (r.otherText && r.referredTo !== 'other') li.appendChild(el('span', 'text-tertiary', r.otherText));
        if (r.contactName) li.appendChild(el('span', 'text-tertiary', r.contactName));
        const meta = [formatReferredAt(r.referredAt), r.referenceNo ? `Ref. ${r.referenceNo}` : ''].filter(Boolean).join(' · ');
        if (meta) li.appendChild(el('span', 'text-tertiary', meta));
        list.appendChild(li);
      }
      card.appendChild(list);
    }
    if (canAdd) {
      const add = el('button', 'ghost', 'Record a referral');
      add.type = 'button';
      add.addEventListener('click', () => openReferralDialog({ incidentId, incidentLabel, onCreated: load }));
      card.appendChild(add);
    }
  }

  return card;
}

// --- Related incident ----------------------------------------------------------

/**
 * "Related incident": a reference link between two incidents of the same
 * barangay (PATCH /incidents/:id/related). It changes NOTHING about either
 * incident's status, dispatch or retention, and it is not the Secretary's
 * "mark as duplicate" lifecycle action (which stays separate and keeps its own
 * rules). Renders from the incident the page has already loaded
 * (`related_incident`, `related_by`: id + display id only, no narrative), so it
 * has no loading state of its own; a failed save shows inline and keeps the
 * form open.
 *
 * @param {{
 *   incidentId:number,
 *   relatedIncident:{incidentId:number, displayId:string|null}|null,
 *   relatedBy:Array<{incidentId:number, displayId:string|null}>,
 *   canEdit:boolean,
 *   navigate:(page:string, param?:any)=>void,
 *   onChanged:()=>void,
 * }} opts
 * @returns {HTMLElement}
 */
export function RelatedIncidentCard({ incidentId, relatedIncident, relatedBy, canEdit, navigate, onChanged }) {
  const card = el('section', 'card case-card case-card--related');
  card.setAttribute('aria-label', 'Related incident');
  card.appendChild(cardHeading(icons.layers, 'Related incident'));

  const linkButton = (link) => {
    const label = link.displayId || `#${link.incidentId}`;
    const btn = el('button', 'link-button', label);
    btn.type = 'button';
    btn.title = `Open incident ${label}`;
    btn.addEventListener('click', () => navigate('incident-detail', link.incidentId));
    return btn;
  };

  const toRow = el('div', 'case-card__field');
  toRow.appendChild(el('span', 'meta-tile__label', 'Related to'));
  if (relatedIncident) toRow.appendChild(linkButton(relatedIncident));
  else toRow.appendChild(el('span', 'meta-tile__value', 'No related incident'));
  card.appendChild(toRow);

  if (relatedBy.length > 0) {
    const byRow = el('div', 'case-card__field');
    byRow.appendChild(el('span', 'meta-tile__label', 'Referenced by'));
    for (const link of relatedBy) byRow.appendChild(linkButton(link));
    card.appendChild(byRow);
  }

  card.appendChild(el('p', 'note', 'A reference link between two incidents. It does not change either incident’s status or dispatch.'));

  if (!canEdit) return card;

  const form = el('form', 'form-stack');
  form.noValidate = true;
  const errorBox = el('div', 'login-form__error');
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;
  const inputId = `related-incident-${incidentId}`;
  const label = el('label', 'label', 'Related incident number');
  label.htmlFor = inputId;
  const input = el('input', 'personnel-form-input');
  input.id = inputId;
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.placeholder = 'e.g. 902';
  if (relatedIncident) input.value = String(relatedIncident.incidentId);

  const actions = el('div', 'availability-item__actions');
  const save = el('button', 'primary', relatedIncident ? 'Change link' : 'Link incident');
  save.type = 'submit';
  actions.appendChild(save);
  let remove = null;
  if (relatedIncident) {
    remove = el('button', 'ghost', 'Remove link');
    remove.type = 'button';
    actions.appendChild(remove);
  }
  form.append(errorBox, label, input, actions);
  card.appendChild(form);

  async function submit(nextId) {
    errorBox.hidden = true;
    save.disabled = true;
    if (remove) remove.disabled = true;
    try {
      await setRelatedIncident(incidentId, nextId, crypto.randomUUID());
      showToast(nextId === null ? 'Related-incident link removed.' : 'Related incident linked.', { variant: 'success' });
      onChanged();
    } catch (err) {
      save.disabled = false;
      if (remove) remove.disabled = false;
      errorBox.textContent = err instanceof ApiClientError ? err.message : 'Could not save the link.';
      errorBox.hidden = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      errorBox.textContent = 'Enter the incident number (a whole number, 1 or higher).';
      errorBox.hidden = false;
      return;
    }
    const id = Number(raw);
    if (id === incidentId) {
      errorBox.textContent = 'An incident cannot be related to itself.';
      errorBox.hidden = false;
      return;
    }
    submit(id);
  });
  if (remove) {
    remove.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Remove the related-incident link?',
        description: 'Neither incident is changed or deleted; only the reference between them is removed.',
        confirmLabel: 'Remove link',
        cancelLabel: 'Keep it',
      });
      if (ok) submit(null);
    });
  }
  return card;
}
