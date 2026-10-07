/**
 * PaperApprovalPanel — the "paper signature and scanned copy" card shared by
 * the Accomplishment Report detail and the Annex D (term report) detail.
 *
 * Why it exists: an approved report is locked inside the system, but the
 * barangay's real record is the SIGNED PAPER copy. So this panel
 *   - shows a "Paper signature pending" badge until someone records the date
 *     the paper was signed ("Signed on paper <date>" afterwards) — visible to
 *     every role that can open the detail, Punong Barangay included;
 *   - lets Admin and Secretary record that date ("Record paper signature
 *     date", only on an approved report), record an approval that happened
 *     only on paper ("Record approval from paper", on a noted report — Annex D:
 *     prepared — naming the signer and the date they signed), and attach,
 *     list and download a scan of the signed copy.
 *
 * Gating here is UX only; the server re-checks role, tenant, status and the
 * signer's authority on every call (REFERENCE.md §2 Rule 2). Every server
 * value is rendered with textContent. A scan's file path never reaches the
 * client; downloads go through an authenticated blob fetch.
 *
 * Four states for the scan list: loading / empty / error with retry / list.
 */

import { promptText, promptFields } from './ConfirmDialog.js';
import { showToast } from './Toast.js';
import {
  recordPaperSignature, recordPaperApproval, getDocumentScans, uploadDocumentScan, downloadDocumentScan,
} from '../services/tanodWorkflowApi.js';
import {
  h, card, formatDateOnly, formatManilaDateTime, manilaToday, actionErrorMessage,
} from '../services/tanodWorkflowUi.js';
import { loadSignerCandidates } from '../services/signerCandidates.js';

export const SCAN_MAX_BYTES = 10 * 1024 * 1024;
const SCAN_EXTENSIONS = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const SCAN_COPY = 'PDF, JPG or PNG, max 10 MB. Do not include student names.';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateSignedOn(value, what) {
  if (!ISO_DATE.test(value || '') || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`Enter the ${what} as a date.`);
  }
  if (value > manilaToday()) throw new Error(`The ${what} cannot be in the future.`);
  return value;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function scanTypeLabel(mime) {
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'image/jpeg') return 'JPG';
  if (mime === 'image/png') return 'PNG';
  return 'File';
}

function scanFileName(scan) {
  const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[scan.mimeType] || 'bin';
  return `scan-${scan.scanId}.${ext}`;
}

/**
 * @param {{
 *   entityType: 'accomplishment_report'|'ssz_term_report',
 *   report: object,            camelCased report from the server
 *   user: {userId:number, fullName:string, role:string},
 *   recordStatus: string,      status in which "Record approval from paper" applies ('noted' | 'prepared')
 *   signerAuthority: string,   'approve_report' | 'approve_annex_d'
 *   preparerUserId: number|null,
 *   approvedStatuses: string[], statuses from which a scan may be attached (approved or later)
 *   onChanged: () => void,     parent reloads the detail after a state change
 * }} opts
 * @returns {HTMLElement}
 */
export function PaperApprovalPanel({
  entityType, report, user, recordStatus, signerAuthority, preparerUserId, approvedStatuses, onChanged,
}) {
  const reportId = report.reportId;
  const canManage = user.role === 'admin' || user.role === 'secretary';
  const isApproved = report.status === 'approved';
  const scansAllowed = approvedStatuses.includes(report.status);
  const el = card('Paper signature and scan');
  el.classList.add('tw-paper-panel');

  // ----- badges (everyone who can read the detail) -------------------------

  const badges = h('div', 'tw-paper-panel__badges');
  if (report.paperPending) {
    badges.appendChild(h('span', 'status-pill status-pill--pending tw-paper-badge', 'Paper signature pending'));
  } else if (report.paperSignedOn) {
    badges.appendChild(h('span', 'status-pill status-pill--success tw-paper-badge', `Signed on paper ${formatDateOnly(report.paperSignedOn)}`));
  }
  if (report.approvalMode === 'recorded_from_paper') {
    badges.appendChild(h('span', 'status-pill status-pill--info tw-paper-badge', 'Approval recorded from paper'));
  }
  if (badges.children.length) el.appendChild(badges);

  if (report.paperRecordedByName || report.paperRecordedAt) {
    el.appendChild(h('p', 'tw-card__subtitle',
      `Recorded${report.paperRecordedByName ? ` by ${report.paperRecordedByName}` : ''}${report.paperRecordedAt ? ` on ${formatManilaDateTime(report.paperRecordedAt)}` : ''}.`));
  }
  if (!badges.children.length) {
    el.appendChild(h('p', 'tw-empty-note', isApproved || scansAllowed
      ? 'No paper signature has been recorded.'
      : 'The signed paper copy is recorded here once this report is approved.'));
  }

  // ----- controls (Admin / Secretary) --------------------------------------

  if (canManage) {
    const bar = h('div', 'tw-action-bar');

    if (isApproved) {
      const dateBtn = h('button', 'primary', 'Record paper signature date');
      dateBtn.type = 'button';
      dateBtn.addEventListener('click', async () => {
        const signed = await promptText({
          title: 'Record paper signature date',
          description: 'Enter the date the signed paper copy was signed. You can correct it later by recording it again.',
          label: 'Date signed on paper',
          inputType: 'date',
          confirmLabel: 'Record date',
          onConfirmAsync: async (value) => {
            const date = validateSignedOn(value, 'date signed on paper');
            try {
              await recordPaperSignature(entityType, reportId, date);
            } catch (err) {
              throw new Error(actionErrorMessage(err, 'Could not record the paper signature date.'));
            }
          },
        });
        if (signed !== null) {
          showToast('Paper signature date recorded.', { variant: 'success' });
          onChanged();
        }
      });
      bar.appendChild(dateBtn);
    }

    if (report.status === recordStatus) {
      const approveBtn = h('button', 'ghost', 'Record approval from paper');
      approveBtn.type = 'button';
      approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        let loaded;
        try {
          loaded = await loadSignerCandidates(user, signerAuthority, preparerUserId ?? null);
        } catch (err) {
          approveBtn.disabled = false;
          showToast(actionErrorMessage(err, 'Could not load the list of officials.'), { variant: 'error' });
          return;
        }
        approveBtn.disabled = false;
        if (loaded.candidates.length === 0) {
          showToast('No active official holds this approval authority (other than the person who prepared the report).', { variant: 'warning' });
          return;
        }
        const result = await promptFields({
          title: 'Record approval from paper',
          description: 'Use this when the approver signed the paper form instead of approving in the system. Pick who signed and the date they signed. The report becomes approved.',
          fields: [
            { name: 'signer', label: 'Signer', type: 'select', options: loaded.candidates.map((c) => ({ value: c.userId, label: c.label })) },
            { name: 'signedOn', label: 'Date signed', type: 'date', max: manilaToday() },
          ],
          confirmLabel: 'Record approval',
          onConfirmAsync: async (values) => {
            const signedOn = validateSignedOn(values.signedOn, 'date signed');
            try {
              await recordPaperApproval(entityType, reportId, { signerUserId: Number(values.signer), signedOn });
            } catch (err) {
              throw new Error(actionErrorMessage(err, 'Could not record the approval.'));
            }
          },
        });
        if (result !== null) {
          showToast('Approval recorded from paper.', { variant: 'success' });
          onChanged();
        }
      });
      bar.appendChild(approveBtn);
    }

    if (bar.children.length) el.appendChild(bar);
  }

  // ----- scanned copy -------------------------------------------------------

  const scansHead = h('h4', 'tw-subhead', 'Scanned copy of the signed form');
  const scansHost = h('div', 'tw-paper-panel__scans');
  el.append(scansHead, scansHost);

  if (!scansAllowed) {
    scansHost.appendChild(h('p', 'tw-empty-note', 'A scan can be attached once this report is approved.'));
    return el;
  }

  function renderScansLoading() {
    scansHost.innerHTML = '';
    scansHost.setAttribute('aria-busy', 'true');
    const wrap = h('div', 'stack');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', 'Loading scans');
    wrap.appendChild(h('div', 'skeleton skeleton--row'));
    scansHost.appendChild(wrap);
  }

  function renderScansError(err) {
    scansHost.innerHTML = '';
    scansHost.setAttribute('aria-busy', 'false');
    const block = h('div', 'state-block state-block--error');
    block.setAttribute('role', 'alert');
    const retry = h('button', 'primary', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', loadScans);
    block.append(h('p', '', actionErrorMessage(err, 'Could not load the scans.')), retry);
    scansHost.appendChild(block);
  }

  function renderScans(items) {
    scansHost.innerHTML = '';
    scansHost.setAttribute('aria-busy', 'false');
    if (items.length === 0) {
      scansHost.appendChild(h('p', 'tw-empty-note', 'No scan has been attached yet.'));
    } else {
      const list = h('ul', 'tw-scan-list');
      for (const scan of items) {
        const li = h('li', 'tw-scan-list__item');
        const meta = h('span', 'tw-scan-list__meta',
          `${scanTypeLabel(scan.mimeType)} · ${formatBytes(scan.sizeBytes)} · uploaded ${formatManilaDateTime(scan.uploadedAt)}`);
        const dl = h('button', 'ghost', 'Download');
        dl.type = 'button';
        dl.setAttribute('aria-label', `Download scan ${scan.scanId}`);
        dl.addEventListener('click', async () => {
          dl.disabled = true;
          try {
            const blob = await downloadDocumentScan(scan.scanId);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = scanFileName(scan);
            document.body.appendChild(link);
            link.click();
            link.remove();
            if (typeof URL.revokeObjectURL === 'function') setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (err) {
            showToast(actionErrorMessage(err, 'Could not download this scan.'), { variant: 'error' });
          } finally {
            dl.disabled = false;
          }
        });
        li.append(meta, dl);
        list.appendChild(li);
      }
      scansHost.appendChild(list);
    }
    if (canManage) scansHost.appendChild(buildUploadForm());
  }

  function buildUploadForm() {
    const form = h('form', 'form-stack tw-scan-upload');
    form.noValidate = true;
    const label = h('label', 'label', 'Attach a scan');
    const input = document.createElement('input');
    input.type = 'file';
    input.id = `tw-scan-file-${entityType}-${reportId}`;
    input.accept = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
    label.htmlFor = input.id;
    const hint = h('p', 'tw-field__hint', SCAN_COPY);
    const error = h('p', 'tw-form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const upload = h('button', 'primary', 'Upload scan');
    upload.type = 'submit';
    form.append(label, input, hint, error, upload);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      const file = input.files && input.files[0];
      const problem = !file
        ? 'Choose a file first.'
        : (!SCAN_EXTENSIONS[(file.name.split('.').pop() || '').toLowerCase()]
          ? 'Only PDF, JPG or PNG files can be attached.'
          : (file.size > SCAN_MAX_BYTES ? 'That file is larger than 10 MB.' : (file.size === 0 ? 'That file is empty.' : null)));
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        return;
      }
      upload.disabled = true;
      try {
        await uploadDocumentScan(entityType, reportId, file);
        showToast('Scan attached.', { variant: 'success' });
        loadScans();
      } catch (err) {
        error.textContent = actionErrorMessage(err, 'Could not upload this scan.');
        error.hidden = false;
        upload.disabled = false;
      }
    });
    return form;
  }

  async function loadScans() {
    renderScansLoading();
    try {
      const res = await getDocumentScans(entityType, reportId);
      renderScans(res.items);
    } catch (err) {
      renderScansError(err);
    }
  }

  loadScans();
  return el;
}
