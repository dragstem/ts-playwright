import { useQuery } from "@tanstack/react-query";
import { Button } from "@ts-playwright/ui";
import { api } from "../api";
import { Modal } from "./Modal";
import { highlightTs } from "../lib/highlightTs";

interface ScenarioCode {
  scenario_id: string;
  filename: string;
  code: string;
}

// Read-only viewer for a scenario's recorded source (scenario.spec.ts), fetched from the package
// zip via /api/scenarios/:id/code. Plain <pre> for now (no syntax highlighting dependency yet).
export function ScenarioCodeModal({
  scenarioId,
  scenarioName,
  onClose
}: {
  scenarioId: string;
  scenarioName: string;
  onClose: () => void;
}) {
  const code = useQuery({
    queryKey: ["scenario-code", scenarioId],
    queryFn: () => api.get<ScenarioCode>(`/api/scenarios/${scenarioId}/code`)
  });

  return (
    <Modal onClose={onClose} width={900}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0, flex: 1 }}>{scenarioName}</h2>
          <code style={{ fontSize: 12, color: "var(--text-muted)" }}>{code.data?.filename ?? "scenario.spec.ts"}</code>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        {code.isLoading && <p style={{ color: "var(--text-muted)" }}>Loading…</p>}
        {code.error && <p style={{ color: "var(--status-failed)" }}>{String(code.error)}</p>}
        {code.data && (
          <pre
            style={{
              margin: 0,
              maxHeight: "70vh",
              overflow: "auto",
              background: "#0d1117",
              color: "#c9d1d9",
              padding: 12,
              borderRadius: 6,
              fontFamily: "var(--mono)",
              fontSize: 12,
              whiteSpace: "pre",
              border: "1px solid var(--border)"
            }}
            dangerouslySetInnerHTML={{ __html: highlightTs(code.data.code) }}
          />
        )}
    </Modal>
  );
}
