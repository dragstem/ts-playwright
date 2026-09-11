import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "@ts-playwright/ui";

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => true);

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

// Promise-based confirmation modal. useConfirm() returns an async confirm() so call sites can
// `if (await confirm({ message })) …` instead of the native window.confirm(). One dialog at a time.
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  const settle = (ok: boolean) => {
    pendingRef.current?.resolve(ok);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => settle(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1100
          }}
        >
          <div
            className="tsp-card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 420, display: "grid", gap: 12 }}
          >
            {pending.title && <strong>{pending.title}</strong>}
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{pending.message}</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="secondary" onClick={() => settle(false)}>
                Cancel
              </Button>
              <Button variant={pending.danger ? "danger" : "primary"} onClick={() => settle(true)}>
                {pending.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
