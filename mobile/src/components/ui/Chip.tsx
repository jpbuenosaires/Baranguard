import type { ReactNode } from 'react';
import { cx } from './cx';

export interface ChipProps {
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'critical';
  selected?: boolean;
  /** When given the chip renders as a <button> (48px hit area); otherwise a <span>. */
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export const Chip: React.FC<ChipProps> = ({ tone = 'neutral', selected = false, onClick, disabled, className, children }) => {
  const cls = cx('ui-chip', `ui-chip--${tone}`, selected && 'ui-chip--selected', onClick && 'ui-chip--action', className);
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} disabled={disabled} aria-pressed={selected}>
        <span className="ui-chip__body">{children}</span>
      </button>
    );
  }
  return (
    <span className={cls}>
      <span className="ui-chip__body">{children}</span>
    </span>
  );
};
