import { useState } from "react";
import { useNotifications } from "./Toast";

const KIND_COLOR: Record<string, string> = {
  error: "var(--status-failed)",
  success: "var(--status-passed)",
  info: "var(--status-running)"
};

// Bell + dropdown listing the recent notification history (the same events shown as toasts).
// Lets the user review messages that already auto-dismissed.
export function NotificationCenter() {
  const items = useNotifications();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="Notifications"
        aria-label="Notifications"
        style={{
          background: "none",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--text-muted)",
          cursor: "pointer",
          padding: "2px 8px"
        }}
      >
        🔔{items.length > 0 ? ` ${items.length}` : ""}
      </button>
      {open && (
        <div
          className="tsp-card"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            width: 320,
            maxHeight: 400,
            overflow: "auto",
            display: "grid",
            gap: 6,
            zIndex: 200
          }}
        >
          {items.length === 0 && <span style={{ color: "var(--text-muted)", fontSize: 13 }}>No notifications.</span>}
          {items.map((item) => (
            <div
              key={item.id}
              style={{ borderLeft: `3px solid ${KIND_COLOR[item.kind] ?? "var(--border)"}`, paddingLeft: 8, fontSize: 12 }}
            >
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{item.message}</div>
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)" }}>
                {item.at.slice(11, 19)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
