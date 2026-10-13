import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { IonIcon, IonSpinner } from '@ionic/react';
import { cx } from './cx';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'md' | 'lg';
  /** Shows a spinner, sets aria-busy and disables the button. The label stays. */
  loading?: boolean;
  /** Leading ionicon. */
  icon?: string;
  fullWidth?: boolean;
  children: ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  fullWidth = false,
  type = 'button',
  disabled,
  className,
  children,
  ...rest
}) => (
  <button
    {...rest}
    type={type}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    className={cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, fullWidth && 'ui-btn--full', loading && 'ui-btn--loading', className)}
  >
    {loading ? (
      <IonSpinner name="crescent" className="ui-btn__spinner" aria-hidden="true" />
    ) : icon ? (
      <IonIcon icon={icon} aria-hidden="true" />
    ) : null}
    <span className="ui-btn__label">{children}</span>
  </button>
);
