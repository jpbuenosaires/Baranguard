import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Trailing header content, e.g. a Button or Chip. */
  action?: ReactNode;
}

export const Card: React.FC<CardProps> = ({ title, subtitle, action, className, children, ...rest }) => (
  <section {...rest} className={cx('ui-card', className)}>
    {(title || subtitle || action) && (
      <header className="ui-card__header">
        <div className="ui-card__heading">
          {title && <h3 className="ui-card__title">{title}</h3>}
          {subtitle && <p className="ui-card__subtitle">{subtitle}</p>}
        </div>
        {action && <div className="ui-card__action">{action}</div>}
      </header>
    )}
    {children}
  </section>
);
