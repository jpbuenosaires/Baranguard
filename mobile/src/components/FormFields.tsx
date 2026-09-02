/**
 * FormFields.tsx — thin wrappers around IonInput/IonTextarea/IonSelect
 * that bind to the underlying custom element's NATIVE events via a ref,
 * instead of React's `onIonInput` / `onIonChange` props.
 *
 * WHY THIS EXISTS (found by browser-testing M1 on 2026-09-02, not by
 * inspection): with the installed combination — @ionic/react 9.0.1 (its
 * new Stencil React output target) on React 19.0.0 — the `onIonInput`
 * prop type-checks and the component renders, but the handler is NEVER
 * invoked. Diagnosed by attaching a raw listener in the page: the
 * `ionInput` DOM event fires correctly and the web component holds the
 * right value, while React state stayed empty, so the login form's own
 * validation rejected a filled-in form as blank. The browser console was
 * clean, so nothing was throwing — React simply never wired the listener.
 *
 * Binding to the real DOM event is version-proof: it depends only on the
 * Stencil component's documented event, not on how the React wrapper of
 * the day maps props. If a future @ionic/react fixes the prop binding,
 * these wrappers keep working unchanged.
 *
 * PascalCase filename per §4 (components).
 */

import { useEffect, useRef, useState } from 'react';
import { IonInput, IonSelect, IonSelectOption, IonTextarea } from '@ionic/react';

/**
 * Subscribes to a custom-element event, keeping the latest callback
 * without re-subscribing on every render.
 *
 * Returns a CALLBACK REF, deliberately, rather than taking a
 * `useRef` object. With a plain ref, `ref.current` was still null the
 * first time the effect ran (the Stencil wrapper assigns the underlying
 * element afterwards), and because the dependencies were stable the
 * effect never re-ran — so the listener was never attached at all. That
 * bug was invisible during hot-reload (the element already existed on a
 * remount) and only appeared on a cold page load, where the login form
 * then rejected a filled-in form as blank. Storing the element in state
 * makes its arrival a dependency change, so the effect runs exactly when
 * there is something to listen to.
 */
function useElementEvent(
  eventName: string,
  onValue: (value: string) => void
): (el: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const callbackRef = useRef(onValue);
  callbackRef.current = onValue;

  useEffect(() => {
    if (!element) return;
    const handler = (event: Event) => {
      const target = event.target as { value?: unknown } | null;
      const raw = target?.value;
      callbackRef.current(raw === null || raw === undefined ? '' : String(raw));
    };
    element.addEventListener(eventName, handler);
    return () => element.removeEventListener(eventName, handler);
  }, [element, eventName]);

  return setElement;
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  disabled?: boolean;
  autocapitalize?: 'off' | 'on';
}

export const TextField: React.FC<TextFieldProps> = ({
  label,
  value,
  onChange,
  type = 'text',
  disabled,
  autocapitalize,
}) => {
  const attachRef = useElementEvent('ionInput', onChange);
  return (
    <IonInput
      ref={attachRef}
      label={label}
      labelPlacement="floating"
      type={type}
      value={value}
      disabled={disabled}
      autocapitalize={autocapitalize}
    />
  );
};

interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  disabled?: boolean;
}

export const TextAreaField: React.FC<TextAreaFieldProps> = ({ label, value, onChange, rows = 6, disabled }) => {
  const attachRef = useElementEvent('ionInput', onChange);
  return (
    <IonTextarea
      ref={attachRef}
      label={label}
      labelPlacement="floating"
      autoGrow
      rows={rows}
      value={value}
      disabled={disabled}
    />
  );
};

interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
}

export function SelectField<T extends string>({ label, value, onChange, options, disabled }: SelectFieldProps<T>) {
  // IonSelect commits on selection, so ionChange (not ionInput) is its event.
  const attachRef = useElementEvent('ionChange', (raw) => onChange(raw as T));
  return (
    <IonSelect ref={attachRef} label={label} labelPlacement="floating" value={value} disabled={disabled}>
      {options.map((option) => (
        <IonSelectOption key={option.value} value={option.value}>
          {option.label}
        </IonSelectOption>
      ))}
    </IonSelect>
  );
}
