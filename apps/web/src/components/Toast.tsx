import { createContext, useCallback, useContext, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { localizeError } from "../i18n";

type ToastKind = "error" | "success" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface NotificationItem {
  id: number;
  kind: ToastKind;
  message: string;
  at: string;
}

interface ToastApi {
  push: (kind: ToastKind, message: string) => void;
  error: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
}

const noop = () => {};
const ToastContext = createContext<ToastApi>({ push: noop, error: noop, success: noop, info: noop });
const NotificationsContext = createContext<NotificationItem[]>([]);
const NOTIFICATION_HISTORY = 50;

const VIEWPORT_STYLE: CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 16,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  zIndex: 1000,
  maxWidth: 420
};

const KIND_COLOR: Record<ToastKind, string> = {
  error: "var(--status-failed)",
  success: "var(--status-passed)",
  info: "var(--status-running)"
};

// App-wide toast notifications. Replaces blocking window.alert() so errors/success are non-modal,
// stacked, copyable (selectable text), and auto-dismiss. Click a toast to dismiss it early.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [history, setHistory] = useState<NotificationItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = (idRef.current += 1);
      setToasts((current) => [...current, { id, kind, message }]);
      setHistory((current) =>
        [{ id, kind, message, at: new Date().toISOString() }, ...current].slice(0, NOTIFICATION_HISTORY)
      );
      setTimeout(() => dismiss(id), kind === "error" ? 8000 : 5000);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      error: (message) => push("error", message),
      success: (message) => push("success", message),
      info: (message) => push("info", message)
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      <NotificationsContext.Provider value={history}>{children}</NotificationsContext.Provider>
      <div style={VIEWPORT_STYLE}>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="tsp-card"
            role="status"
            onClick={() => dismiss(toast.id)}
            style={{
              borderLeft: `3px solid ${KIND_COLOR[toast.kind]}`,
              cursor: "pointer",
              fontSize: 13,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word"
            }}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function useNotifications(): NotificationItem[] {
  return useContext(NotificationsContext);
}

export function toastMessage(error: unknown): string {
  // Localize by error code when the server provided one; falls back to the raw message.
  return localizeError(error);
}
