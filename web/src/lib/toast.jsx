import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
} from 'react';

/**
 * App-wide toast notifications for success/error/info feedback on explicit
 * actions (save, send, delete, import...). Deliberately not wired into
 * background polling - a transient failure on an 8-15s auto-refresh would
 * otherwise nag the user every cycle instead of once.
 */

const ToastContext = createContext(null);

let nextId = 0;

const DEFAULT_DURATION = { success: 4000, info: 5000, error: 7000 };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback((message, { type = 'info', duration } = {}) => {
    if (!message) return undefined;
    const id = (nextId += 1);
    setToasts((current) => [...current, { id, message, type }]);

    const ms = duration ?? DEFAULT_DURATION[type] ?? DEFAULT_DURATION.info;
    if (ms > 0) {
      timers.current.set(id, setTimeout(() => dismiss(id), ms));
    }
    return id;
  }, [dismiss]);

  const toast = useMemo(() => ({
    success: (message, opts) => show(message, { ...opts, type: 'success' }),
    error: (message, opts) => show(message, { ...opts, type: 'error' }),
    info: (message, opts) => show(message, { ...opts, type: 'info' }),
    dismiss,
  }), [show, dismiss]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
            <span className="toast-icon" aria-hidden="true">{ICON[t.type]}</span>
            <span className="toast-message">{t.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const ICON = { success: '✓', error: '!', info: 'i' };

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() must be called within a ToastProvider');
  return ctx;
}
