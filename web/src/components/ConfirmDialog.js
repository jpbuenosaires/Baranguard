/**
 * ConfirmDialog.js — reusable confirmation modal (§3.2 of the UI/UX
 * review). Replaces `window.confirm()` call sites one at a time as pages
 * adopt it — this pass wires it into Dispatch Center's Cancel action as
 * the concrete first case; it preserves the EXACT same guarantee
 * `window.confirm()` gave (the caller still awaits an explicit yes/no
 * before proceeding), just with the app's own visual language instead of
 * a native browser dialog.
 *
 * `confirmDialog()` returns a Promise<boolean> specifically so a call
 * site's existing `if (!confirm(...)) return;` becomes
 * `if (!(await confirmDialog({...}))) return;` — a one-line swap, not a
 * restructure of the surrounding function.
 *
 * Accessibility: `role="alertdialog"`, a real focus trap (Tab/Shift+Tab
 * cycle within the two buttons only), Escape dismisses (resolves false),
 * and focus returns to whatever triggered the dialog on close.
 */

/**
 * @param {{title: string, description?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean}} options
 * @returns {Promise<boolean>} resolves true only if the user clicked the confirm button
 */
export function confirmDialog({ title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
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
        close(false);
        return;
      }
      if (event.key !== 'Tab') return;
      // Focus trap: only these two buttons are focusable inside the
      // dialog, so Tab/Shift+Tab just needs to cycle between them.
      const isCancel = document.activeElement === cancelButton;
      if (event.shiftKey ? isCancel : document.activeElement === confirmButton) {
        event.preventDefault();
        (event.shiftKey ? confirmButton : cancelButton).focus();
      }
    }

    cancelButton.addEventListener('click', () => close(false));
    confirmButton.addEventListener('click', () => close(true));
    // Clicking the backdrop itself (not the dialog card) counts as cancel.
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(false);
    });

    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(backdrop);
    // Focus the non-destructive action by default — a Tanod/Admin under
    // pressure hitting Enter reflexively shouldn't land on the
    // destructive one.
    cancelButton.focus();
  });
}
