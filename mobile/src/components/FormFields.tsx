/**
 * FormFields.tsx — thin wrapper around IonInput
 * that binds to the underlying custom element's NATIVE events via a ref,
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

import { useEffect, useId, useRef, useState } from 'react';
import { IonInput } from '@ionic/react';

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
  inputMode?: 'none' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | 'search';
  autoComplete?: string;
  enterKeyHint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
  autoCorrect?: 'on' | 'off';
  required?: boolean;
  /** Validation message; rendered under the field and tied to it via aria-describedby. */
  error?: string;
}

export const TextField: React.FC<TextFieldProps> = ({
  label,
  value,
  onChange,
  type = 'text',
  disabled,
  autocapitalize,
  inputMode,
  autoComplete,
  enterKeyHint,
  autoCorrect,
  required,
  error,
}) => {
  const attachRef = useElementEvent('ionInput', onChange);
  const errorId = useId();
  const input = (
    <IonInput
      ref={attachRef}
      label={label}
      labelPlacement="floating"
      type={type}
      value={value}
      disabled={disabled}
      autocapitalize={autocapitalize}
      inputmode={inputMode}
      autocomplete={autoComplete as never}
      enterkeyhint={enterKeyHint}
      autocorrect={autoCorrect === undefined ? undefined : autoCorrect === 'on'}
      required={required}
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={error ? errorId : undefined}
    />
  );
  if (!error) return input;
  return (
    <>
      {input}
      <div id={errorId} role="alert" className="text-field-error">
        {error}
      </div>
    </>
  );
};
