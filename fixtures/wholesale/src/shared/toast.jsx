// Toasts with Base UI Toast; `notify()` can be called from anywhere (module-level manager).

import { Toast } from '@base-ui/react/toast';
import { Icon } from './icons.jsx';

const manager = Toast.createToastManager();

/** @param {{ title: string, description?: string, action?: { label: string, onClick: () => void }, timeout?: number }} t */
export function notify({ title, description, action, timeout = 4500 }) {
  return manager.add({ title, description, timeout, data: { action } });
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((t) => (
    <Toast.Root key={t.id} toast={t} className="toast">
      <span className="toast-icon">
        <Icon name="check" size={16} strokeWidth={2.4} />
      </span>
      <div className="grow">
        <Toast.Title className="toast-title" />
        <Toast.Description className="toast-description" />
        {t.data?.action ? (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              t.data.action.onClick();
              manager.close(t.id);
            }}
          >
            {t.data.action.label} →
          </button>
        ) : null}
      </div>
      <Toast.Close className="toast-close" aria-label="Dismiss notification">
        <Icon name="x" size={16} />
      </Toast.Close>
    </Toast.Root>
  ));
}

export function Toaster({ children }) {
  return (
    <Toast.Provider toastManager={manager}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="toast-viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
