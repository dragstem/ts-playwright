import type { CSSProperties, ReactNode } from "react";
import { useConfirm } from "./ConfirmDialog";
import { useT } from "../i18n";

// Shared modal shell: a backdrop + centered card. Clicking OUTSIDE the card (the backdrop) asks for
// confirmation before closing ("are you sure you want to leave?") to avoid losing unsaved input;
// explicit Cancel/Close buttons inside call onClose directly. The confirm dialog (z-index 1100)
// renders above this (z-index 50). Set confirmOnClose={false} to skip the prompt.
export function Modal({
  onClose,
  children,
  width = 560,
  confirmOnClose = true,
  cardStyle
}: {
  onClose: () => void;
  children: ReactNode;
  width?: number;
  confirmOnClose?: boolean;
  cardStyle?: CSSProperties;
}) {
  const confirm = useConfirm();
  const { t } = useT();

  const onBackdrop = async () => {
    if (!confirmOnClose) {
      onClose();
      return;
    }
    const ok = await confirm({ message: t("modal.close_confirm"), confirmLabel: t("modal.close_confirm_label"), danger: true });
    if (ok) {
      onClose();
    }
  };

  return (
    <div
      onClick={() => void onBackdrop()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 40,
        zIndex: 50,
        overflow: "auto"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="tsp-card"
        style={{ width: `min(${width}px, 100%)`, display: "grid", gap: 10, background: "var(--surface)", ...cardStyle }}
      >
        {children}
      </div>
    </div>
  );
}
