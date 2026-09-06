/**
 * DateRangePicker — the "Last 7 / 30 / 90 days · Custom range…" control.
 *
 * Extracted 2026-09-06 by the full UI/UX consistency audit. Five screens
 * (Admin Dashboard, Analytics>Heatmap, Analytics>Reports, SMS Monitor,
 * Audit Log) had each copy-pasted ~120 lines of identical DOM
 * construction, and the copies had drifted apart in every dimension a
 * user can see:
 *
 *   - option sets      7/30/90/custom vs. the same + "All time"
 *   - default          "30" on three screens, "7" on Audit Log
 *   - ellipsis         "Custom range..." vs. "Custom range…"
 *   - field labels     "From"/"To" vs. "From Date"/"To Date"
 *   - popover title    "Custom Date Range" vs "Select Custom Date Range"
 *   - one screen labelled its default option "Last 7 days (Default)"
 *   - Audit Log swapped the shared select styling for a bespoke wrapper
 *     plus a JS-injected chevron, and used a <div> error element with
 *     inline style.cssText where everyone else used .app-inline-error
 *
 * Worse, the CSS was triplicated too — admin-dashboard.css, audit-log.css
 * and sms-monitor.css each defined the SAME global `.date-range-popover*`
 * classes, so link order (audit-log.css is last) silently decided how the
 * control looked on all five screens. That CSS now lives once, in
 * css/components/DateRangePicker.css.
 *
 * Two real bugs were fixed while consolidating, both present in all five
 * copies:
 *
 *   1. Each copy registered `document`-level click and keydown listeners
 *      inside the page render function and never removed them. main.js
 *      rebuilds #app wholesale on every navigate(), so those piled up one
 *      pair per navigation for the life of the tab. This module registers
 *      ONE pair at module scope and points them at whichever instance is
 *      currently mounted — the same idiom AppShell.js uses for its search
 *      widget, and for the same reason.
 *
 *   2. "Today" was computed with `new Date().toISOString().slice(0,10)`,
 *      which is a UTC date. Between 00:00 and 08:00 Asia/Manila that is
 *      YESTERDAY, so for eight hours of every day the presets silently
 *      requested a window ending one day early. Day boundaries here are
 *      now taken against a fixed +08:00, matching the rule the backend
 *      already follows (working reference §2 rule 11: timestamps stored
 *      UTC, day-bucketing done against a fixed +08:00, never CONVERT_TZ).
 */

/** Fixed +08:00, per working reference §2 rule 11. */
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Today's date in Asia/Manila as YYYY-MM-DD. */
export function manilaTodayIso() {
  return new Date(Date.now() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/** `n` days before today in Asia/Manila as YYYY-MM-DD. */
export function manilaDaysAgoIso(n) {
  return new Date(Date.now() + MANILA_OFFSET_MS - n * 86400000).toISOString().slice(0, 10);
}

/**
 * Preset -> how many days back the window STARTS, inclusive of today.
 * "Last 7 days" is today plus the six before it, which is what every copy
 * of this control already computed (and what audit-log.js's
 * getPastDateISO(days) expressed as `days - 1`).
 */
const PRESET_DAYS_AGO = { 7: 6, 30: 29, 90: 89 };

/** "2026-09-04" -> "Sep 4", for the selected-custom-range option label. */
function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

// ── Shared document-level listeners ───────────────────────────────────
// Registered once for the module, not once per instance per navigation.
// `activeInstance` is whichever picker currently has its popover open; a
// picker whose page has been navigated away from fails the isConnected
// check and releases the slot.
let activeInstance = null;

function releaseIfDetached() {
  if (activeInstance && !activeInstance.el.isConnected) activeInstance = null;
}

document.addEventListener('click', (e) => {
  releaseIfDetached();
  if (activeInstance && !activeInstance.el.contains(e.target)) activeInstance.close(true);
});

document.addEventListener('keydown', (e) => {
  releaseIfDetached();
  if (e.key === 'Escape' && activeInstance) activeInstance.close(true);
});

/**
 * @param {{
 *   value?: '7'|'30'|'90'|'all'|'custom',
 *   allowAllTime?: boolean,
 *   ariaLabel?: string,
 *   selectClassName?: string,
 *   onChange: (state: {mode: string, from: string|null, to: string|null}) => void
 * }} props
 * @returns {{
 *   el: HTMLElement,
 *   getState: () => {mode: string, from: string|null, to: string|null},
 *   setDates: (from: string, to: string) => void
 * }}
 */
export function DateRangePicker({
  value = '30',
  allowAllTime = false,
  ariaLabel = 'Date range',
  selectClassName = '',
  onChange,
}) {
  const el = document.createElement('div');
  el.className = 'date-range-picker-wrapper';

  const select = document.createElement('select');
  select.className = ['input--auto', 'range-select', selectClassName].filter(Boolean).join(' ');
  select.setAttribute('aria-label', ariaLabel);

  const options = [
    ['7', 'Last 7 days'],
    ['30', 'Last 30 days'],
    ['90', 'Last 90 days'],
    ...(allowAllTime ? [['all', 'All time']] : []),
    ['custom', 'Custom range…'],
  ];
  for (const [val, label] of options) {
    const option = document.createElement('option');
    option.value = val;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = value;
  let previousValue = value;

  // Current committed range. null/null for "All time", which is the only
  // mode that deliberately sends no date bounds to the server.
  let from = value === 'all' ? null : manilaDaysAgoIso(PRESET_DAYS_AGO[value] ?? 29);
  let to = value === 'all' ? null : manilaTodayIso();

  const popover = document.createElement('div');
  popover.className = 'date-range-popover';
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Custom date range');

  const title = document.createElement('div');
  title.className = 'date-range-popover__title';
  title.textContent = 'Custom Date Range';

  const grid = document.createElement('div');
  grid.className = 'date-range-popover__grid';

  const makeField = (labelText, initial) => {
    const field = document.createElement('div');
    field.className = 'date-range-popover__field';
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'date-range-popover__input';
    input.value = initial;
    input.id = `drp-${labelText.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
    const label = document.createElement('label');
    label.className = 'date-range-popover__label';
    label.textContent = labelText;
    label.htmlFor = input.id;
    field.append(label, input);
    return { field, input };
  };

  const fromField = makeField('From', from ?? manilaDaysAgoIso(29));
  const toField = makeField('To', to ?? manilaTodayIso());
  grid.append(fromField.field, toField.field);

  const error = document.createElement('span');
  error.className = 'app-inline-error';
  error.hidden = true;
  error.setAttribute('role', 'alert');

  const actions = document.createElement('div');
  actions.className = 'date-range-popover__actions';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'ghost';
  cancelButton.textContent = 'Cancel';

  const applyButton = document.createElement('button');
  applyButton.type = 'button';
  applyButton.className = 'primary';
  applyButton.textContent = 'Apply Range';

  actions.append(cancelButton, applyButton);
  popover.append(title, grid, error, actions);
  el.append(select, popover);

  const isInvalid = () =>
    Boolean(fromField.input.value && toField.input.value && fromField.input.value > toField.input.value);

  const validate = () => {
    const invalid = isInvalid();
    applyButton.disabled = invalid;
    error.hidden = !invalid;
    error.textContent = invalid ? 'From date must be on or before To date.' : '';
  };
  fromField.input.addEventListener('change', validate);
  toField.input.addEventListener('change', validate);

  const open = () => {
    popover.hidden = false;
    activeInstance = instance;
    validate();
    fromField.input.focus();
  };

  const close = (restorePrevious = false) => {
    popover.hidden = true;
    error.hidden = true;
    if (activeInstance === instance) activeInstance = null;
    if (restorePrevious) select.value = previousValue;
  };

  cancelButton.addEventListener('click', () => close(true));

  applyButton.addEventListener('click', () => {
    if (isInvalid()) return;
    from = fromField.input.value;
    to = toField.input.value;
    previousValue = 'custom';
    const customOption = select.querySelector('option[value="custom"]');
    if (customOption) customOption.textContent = `Custom (${shortDate(from)} – ${shortDate(to)})`;
    select.value = 'custom';
    close(false);
    onChange({ mode: 'custom', from, to });
  });

  select.addEventListener('change', () => {
    if (select.value === 'custom') {
      open();
      return;
    }
    close(false);
    previousValue = select.value;
    if (select.value === 'all') {
      from = null;
      to = null;
    } else {
      from = manilaDaysAgoIso(PRESET_DAYS_AGO[select.value]);
      to = manilaTodayIso();
      fromField.input.value = from;
      toField.input.value = to;
    }
    onChange({ mode: select.value, from, to });
  });

  const instance = {
    el,
    close,
    getState: () => ({ mode: select.value, from, to }),
    /**
     * Point the control at a range the caller resolved elsewhere — the
     * Admin Dashboard uses this to reconcile against the window the
     * server actually answered with. Does NOT fire onChange: the caller
     * already has the data this describes.
     */
    setDates: (nextFrom, nextTo) => {
      if (!nextFrom || !nextTo) return;
      from = nextFrom;
      to = nextTo;
      fromField.input.value = nextFrom;
      toField.input.value = nextTo;
    },
    /**
     * setDates, plus re-pointing the SELECT at whichever preset that range
     * actually corresponds to (falling back to a labelled "Custom (…)"
     * option). The Admin Dashboard needs this on its very first load: it
     * calls the API with no bounds at all and lets the server choose the
     * window, then has to make the control describe what came back. Also
     * does not fire onChange — the caller already has this data.
     */
    reconcile: (nextFrom, nextTo) => {
      if (!nextFrom || !nextTo) return;
      instance.setDates(nextFrom, nextTo);
      const spanDays =
        Math.round(
          (new Date(`${nextTo}T00:00:00Z`) - new Date(`${nextFrom}T00:00:00Z`)) / 86400000
        ) + 1;
      const matched = Object.keys(PRESET_DAYS_AGO).find((d) => PRESET_DAYS_AGO[d] + 1 === spanDays);
      select.value = matched || 'custom';
      previousValue = select.value;
      if (select.value === 'custom') {
        const customOption = select.querySelector('option[value="custom"]');
        if (customOption) {
          customOption.textContent = `Custom (${shortDate(nextFrom)} – ${shortDate(nextTo)})`;
        }
      }
    },
  };

  return instance;
}
