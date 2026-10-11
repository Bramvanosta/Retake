// Radix Dialog / AlertDialog wrappers.
// LayerContainer exposes the dialog content element so Base UI popovers rendered inside a Radix
// dialog can portal INTO it (a popover portaled to <body> would be outside the dialog's focus
// trap and pointer-events layer — the classic Radix × Base UI mixing problem).

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import { createContext, useContext, useState } from 'react';
import { Icon } from './icons.jsx';

const LayerContainer = createContext(null);

/** Element floating layers should portal into (null = document.body). */
export function useLayerContainer() {
  return useContext(LayerContainer);
}

/**
 * @param {{ open: boolean, onOpenChange: (open: boolean) => void, title: any, description?: any,
 *   children: any, footer?: any, size?: 'sm'|'lg', onOpenAutoFocus?: (e: Event) => void, className?: string }} props
 */
export function Modal({ open, onOpenChange, title, description, children, footer, size, onOpenAutoFocus, className = '' }) {
  const [content, setContent] = useState(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay">
          <Dialog.Content
            ref={setContent}
            className={`dialog ${size ? `dialog-${size}` : ''} ${className}`}
            onOpenAutoFocus={onOpenAutoFocus}
            {...(description ? {} : { 'aria-describedby': undefined })}
          >
            <LayerContainer.Provider value={content}>
              <div className="dialog-header">
                <div className="grow">
                  <Dialog.Title className="dialog-title">{title}</Dialog.Title>
                  {description ? <Dialog.Description className="dialog-description">{description}</Dialog.Description> : null}
                </div>
              </div>
              <div className="dialog-body">{children}</div>
              {footer ? <div className="dialog-footer">{footer}</div> : null}
              <Dialog.Close asChild>
                <button type="button" className="icon-btn dialog-x" aria-label="Close">
                  <Icon name="x" size={18} />
                </button>
              </Dialog.Close>
            </LayerContainer.Provider>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Confirmation dialog (role=alertdialog) with "Cancel" and a confirm button. */
export function Confirm({ open, onOpenChange, title, description, confirmLabel, onConfirm, icon = 'alert', busy = false }) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay">
          <AlertDialog.Content className="dialog alert-dialog">
            <div className="dialog-header">
              <div className="alert-icon">
                <Icon name={icon} size={20} />
              </div>
              <div className="grow">
                <AlertDialog.Title className="dialog-title">{title}</AlertDialog.Title>
                <AlertDialog.Description className="dialog-description">{description}</AlertDialog.Description>
              </div>
            </div>
            <div className="dialog-footer" style={{ marginTop: 22 }}>
              <AlertDialog.Cancel asChild>
                <button type="button" className="btn btn-secondary">
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={(e) => {
                    e.preventDefault();
                    onConfirm();
                  }}
                >
                  {confirmLabel}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Overlay>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
