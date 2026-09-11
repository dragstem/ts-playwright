import { useState, type InputHTMLAttributes } from "react";

// Write-only secret input with a show/hide toggle. Defaults to masked; the eye button reveals the
// typed value so the user can verify it without it being visible by default.
export function SecretField(props: InputHTMLAttributes<HTMLInputElement>) {
  const [revealed, setRevealed] = useState(false);
  const { style, ...rest } = props;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, ...style }}>
      <input {...rest} type={revealed ? "text" : "password"} style={{ flex: 1 }} />
      <button
        type="button"
        onClick={() => setRevealed((value) => !value)}
        title={revealed ? "Hide" : "Show"}
        aria-label={revealed ? "Hide secret" : "Show secret"}
        style={{
          background: "none",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--text-muted)",
          cursor: "pointer",
          padding: "2px 8px"
        }}
      >
        {revealed ? "🙈" : "👁"}
      </button>
    </span>
  );
}
