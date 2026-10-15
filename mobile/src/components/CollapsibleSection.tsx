/**
 * CollapsibleSection.tsx - a 48dp disclosure header over a body. The body stays
 * MOUNTED while collapsed (hidden), so a half-filled form or a running
 * recording inside it is never lost by closing the section.
 */
import { useId, useState, type ReactNode } from 'react';
import { IonIcon } from '@ionic/react';
import { chevronDownOutline } from 'ionicons/icons';
import tacticalFeedback from '../utils/tacticalFeedback';

interface Props {
  title: string;
  /** Short right-aligned summary, e.g. "2 saved". */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

const CollapsibleSection: React.FC<Props> = ({ title, summary, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className="p4d-section">
      <button
        type="button"
        className="p4d-section__head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          tacticalFeedback.onTap();
          setOpen((v) => !v);
        }}
      >
        <span className="p4d-section__title">{title}</span>
        {summary && <span className="p4d-section__summary">{summary}</span>}
        <IonIcon
          icon={chevronDownOutline}
          aria-hidden="true"
          className={`p4d-section__chev${open ? ' p4d-section__chev--open' : ''}`}
        />
      </button>
      <div id={bodyId} className="p4d-section__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
};

export default CollapsibleSection;
