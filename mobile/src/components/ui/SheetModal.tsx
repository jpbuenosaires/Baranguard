import type { ReactNode } from 'react';
import { IonIcon, IonModal } from '@ionic/react';
import { closeOutline } from 'ionicons/icons';

export interface SheetModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** True while a request runs: blocks swipe and backdrop dismiss and the close button. */
  busy?: boolean;
  closeLabel?: string;
  footer?: ReactNode;
  children: ReactNode;
}

export const SheetModal: React.FC<SheetModalProps> = ({
  isOpen,
  onClose,
  title,
  busy = false,
  closeLabel = 'Close',
  footer,
  children,
}) => {
  const requestClose = () => {
    if (!busy) onClose();
  };
  return (
    <IonModal
      isOpen={isOpen}
      onDidDismiss={onClose}
      canDismiss={!busy}
      backdropDismiss={!busy}
      className="ui-sheet"
      aria-label={title}
    >
      <div className="ui-sheet__panel">
        <header className="ui-sheet__header">
          <h2 className="ui-sheet__title">{title}</h2>
          <button type="button" className="ui-sheet__close" onClick={requestClose} disabled={busy} aria-label={closeLabel}>
            <IonIcon icon={closeOutline} aria-hidden="true" />
          </button>
        </header>
        <div className="ui-sheet__content">{children}</div>
        {footer && <footer className="ui-sheet__footer">{footer}</footer>}
      </div>
    </IonModal>
  );
};
