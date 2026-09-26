/**
 * ConfirmDialog.js — reusable modal dialogs (§3.2 of the UI/UX review).
 *
 * Three exports, one implementation:
 *
 *   confirmDialog()  -> Promise<boolean>   yes/no confirmation
 *   promptSelect()   -> Promise<string|null>  pick one option, or null
 *   promptText()     -> Promise<string|null>  free-text/number input, or null
 *
 * `confirmDialog()` returns a Promise<boolean> specifically so a call
 * site's existing `if (!confirm(...)) return;` becomes
 * `if (!(await confirmDialog({...}))) return;` — a one-line swap, not a
 * restructure of the surrounding function. That contract is unchanged.
 *
 * `promptSelect()` was added for the Dispatch Center audit fix: the Tanod
 * picker used to be a full-width <select> rendered into EVERY pending row,
 * which is what pushed the queue table into permanent horizontal scroll
 * inside its 420px column. Moving the picker into a dialog lets the row
 * carry a single compact button instead.
 *
 * Accessibility: `role="alertdialog"`, a real focus trap cycling the
 * dialog's own focusable elements, Escape dismisses (resolves false/null),
 * and focus returns to whatever triggered the dialog on close.
 */

/**
 * Shared dialog shell. `buildBody` may append extra elements (and return
 * the element that should receive initial focus); `resolveValue` maps a
 * confirm click onto the promise's resolved value.
 */
function openDialog({ title, description, confirmLabel, cancelLabel, danger, buildBody, cancelValue, resolveValue, onConfirmAsync }) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog' + (danger ? ' confirm-dialog--danger' : '');
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'confirm-dialog-title');

    const titleEl = document.createElement('h3');
    titleEl.id = 'confirm-dialog-title';
    titleEl.textContent = title;
    dialog.appendChild(titleEl);

    if (description) {
      const descEl = document.createElement('p');
      descEl.className = 'confirm-dialog__description';
      descEl.textContent = description;
      dialog.appendChild(descEl);
    }

    const preferredFocus = buildBody ? buildBody(dialog) : null;

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog__actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'ghost';
    cancelButton.textContent = cancelLabel;
    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = danger ? 'danger' : 'primary';
    confirmButton.textContent = confirmLabel;
    actions.append(cancelButton, confirmButton);
    dialog.appendChild(actions);

    backdrop.appendChild(dialog);

    function close(result) {
      document.removeEventListener('keydown', onKeydown);
      backdrop.remove();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
      resolve(result);
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(cancelValue);
        return;
      }
      if (event.key !== 'Tab') return;
      // Focus trap. Queried live rather than hardcoded to the two buttons,
      // because promptSelect() adds a third focusable element.
      const focusables = [...dialog.querySelectorAll('button, select, input, textarea, a[href]')]
        .filter((el) => !el.disabled);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    const errorEl = document.createElement('div');
    errorEl.className = 'confirm-dialog__error';
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;
    dialog.appendChild(errorEl);

    cancelButton.addEventListener('click', () => close(cancelValue));
    confirmButton.addEventListener('click', async () => {
      if (typeof onConfirmAsync === 'function') {
        confirmButton.disabled = true;
        cancelButton.disabled = true;
        const originalContent = confirmButton.innerHTML;
        confirmButton.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span> <span>${confirmLabel}</span>`;
        errorEl.hidden = true;
        try {
          const val = resolveValue();
          await onConfirmAsync(val);
          close(val);
        } catch (err) {
          confirmButton.disabled = false;
          cancelButton.disabled = false;
          confirmButton.innerHTML = originalContent;
          errorEl.textContent = err?.message || 'Operation failed. Please try again.';
          errorEl.hidden = false;
        }
      } else {
        close(resolveValue());
      }
    });
    // Clicking the backdrop itself (not the dialog card) counts as cancel.
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(cancelValue);
    });

    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(backdrop);
    // A dialog that asks for a choice focuses the choice; a plain
    // confirmation focuses the non-destructive action, so an Admin under
    // pressure hitting Enter reflexively doesn't land on the destructive one.
    (preferredFocus ?? cancelButton).focus();
  });
}

/**
 * @param {{title: string, description?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean, onConfirmAsync?: () => Promise<any>}} options
 * @returns {Promise<boolean>} resolves true only if the user clicked the confirm button
 */
export function confirmDialog({ title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirmAsync }) {
  return openDialog({
    title, description, confirmLabel, cancelLabel, danger, onConfirmAsync,
    cancelValue: false,
    resolveValue: () => true,
  });
}

/**
 * A dialog that asks the user to pick one option.
 *
 * @param {{
 *   title: string, description?: string, label: string,
 *   options: Array<{value: string|number, label: string}>,
 *   confirmLabel?: string, cancelLabel?: string
 * }} options
 * @returns {Promise<string|null>} the chosen option's value, or null if cancelled
 */
export function promptSelect({ title, description, label, options, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirmAsync }) {
  let select = null;
  return openDialog({
    title, description, confirmLabel, cancelLabel, danger: false,
    cancelValue: null,
    resolveValue: () => (select ? select.value : null),
    onConfirmAsync,
    buildBody: (dialog) => {
      const field = document.createElement('div');
      field.className = 'form-stack confirm-dialog__field';
      const labelEl = document.createElement('label');
      labelEl.className = 'label';
      labelEl.htmlFor = 'confirm-dialog-select';
      labelEl.textContent = label;
      select = document.createElement('select');
      select.id = 'confirm-dialog-select';
      for (const option of options) {
        const el = document.createElement('option');
        el.value = String(option.value);
        el.textContent = option.label;
        select.appendChild(el);
      }
      field.append(labelEl, select);
      dialog.appendChild(field);
      return select;
    },
  });
}

/**
 * A dialog that asks the user to type a value. Added for W21's incident
 * lifecycle "mark as duplicate" action, which needs a target incident id
 * alongside the confirmation — `onConfirmAsync` is the validation/submit
 * hook: throwing inside it (client-side or a server 400/409/404) shows
 * the message inline and keeps the dialog open, same as confirmDialog's.
 *
 * @param {{
 *   title: string, description?: string, label: string, placeholder?: string,
 *   inputType?: string, confirmLabel?: string, cancelLabel?: string,
 *   onConfirmAsync?: (value: string) => Promise<any>
 * }} options
 * @returns {Promise<string|null>} the typed value, or null if cancelled
 */
export function promptText({ title, description, label, placeholder, inputType = 'text', confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirmAsync }) {
  let input = null;
  return openDialog({
    title, description, confirmLabel, cancelLabel, danger: false,
    cancelValue: null,
    resolveValue: () => (input ? input.value.trim() : null),
    onConfirmAsync,
    buildBody: (dialog) => {
      const field = document.createElement('div');
      field.className = 'form-stack confirm-dialog__field';
      const labelEl = document.createElement('label');
      labelEl.className = 'label';
      labelEl.htmlFor = 'confirm-dialog-input';
      labelEl.textContent = label;
      input = document.createElement('input');
      input.type = inputType;
      input.id = 'confirm-dialog-input';
      if (placeholder) input.placeholder = placeholder;
      field.append(labelEl, input);
      dialog.appendChild(field);
      return input;
    },
  });
}
