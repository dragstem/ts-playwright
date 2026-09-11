import { useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, EmptyState, ErrorState, Spinner, Tabs } from "@ts-playwright/ui";
import type { ScenarioRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { ProjectServerVarsPanel } from "../components/ProjectServerVarsPanel";
import { ProjectEnvironmentsPanel } from "../components/ProjectEnvironmentsPanel";
import { RunWizard } from "../components/RunWizard";
import { BatchRunWizard } from "../components/BatchRunWizard";
import { ProjectOverview } from "../components/ProjectOverview";
import { ScopeLegend } from "../components/ScopeLegend";
import { ScenarioCodeModal } from "../components/ScenarioCodeModal";
import { toastMessage, useToast } from "../components/Toast";
import { useT } from "../i18n";

const normPath = (p: string) => (p || "").replace(/^\/+|\/+$/g, "");

const crumbStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--status-running)",
  cursor: "pointer",
  fontSize: 14,
  padding: "2px 4px"
};

export function ProjectDetail() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useT();
  const [running, setRunning] = useState<string | null>(null);
  const [wizard, setWizard] = useState<ScenarioRecord | null>(null);
  const [codeScenario, setCodeScenario] = useState<ScenarioRecord | null>(null);
  const [tab, setTab] = useState("overview");
  // Explorer state: which folder we're inside ("" = project root) and an optional name filter.
  const [currentPath, setCurrentPath] = useState("");
  const [query, setQuery] = useState("");
  // Multi-select for a batch run (persists as you move between folders).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const scenarios = useQuery({
    queryKey: ["scenarios", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api.get<ScenarioRecord[]>(`/api/projects/${projectId}/scenarios`)
  });

  const runScenario = async (scenario: ScenarioRecord) => {
    setRunning(scenario.id);
    try {
      // Pre-run config check: if the scenario needs {server_*} the project hasn't configured, open
      // the wizard (which shows the warning + selection) instead of firing a run that would fail.
      const preview = await api
        .post<{ missing_server_inputs?: string[] }>(`/api/scenarios/${scenario.id}/run/preview`, {})
        .catch(() => ({ missing_server_inputs: [] as string[] }));
      if ((preview.missing_server_inputs?.length ?? 0) > 0) {
        setWizard(scenario);
        return;
      }
      const run = await api.post<{ id: string }>(`/api/scenarios/${scenario.id}/run`, {});
      navigate(`/runs/${run.id}`);
    } catch (error) {
      toast.error(toastMessage(error));
    } finally {
      setRunning(null);
    }
  };

  const allScenarios = scenarios.data ?? [];
  const selectedScenarios = allScenarios.filter((s) => selected.has(s.id));

  // Explorer view for the current folder: immediate subfolders (with recursive counts) + the
  // scenarios that live directly in this folder. One level at a time, like a file browser.
  const view = useMemo(() => {
    const cur = currentPath;
    const prefix = cur ? cur + "/" : "";
    const here: ScenarioRecord[] = [];
    const childCounts = new Map<string, number>();
    for (const s of allScenarios) {
      const fp = normPath(s.folder_path);
      if (fp === cur) {
        here.push(s);
        continue;
      }
      if (fp.startsWith(prefix)) {
        const childName = fp.slice(prefix.length).split("/")[0];
        if (childName) childCounts.set(childName, (childCounts.get(childName) ?? 0) + 1);
      }
    }
    const subfolders = Array.from(childCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, path: prefix + name, count }));
    here.sort((a, b) => a.name.localeCompare(b.name));
    return { subfolders, here };
  }, [allScenarios, currentPath]);

  // When the search box is used, show a flat list of matches across the whole project instead.
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return allScenarios
      .filter((s) => s.name.toLowerCase().includes(q) || (s.folder_path || "").toLowerCase().includes(q))
      .sort((a, b) => (a.folder_path || "").localeCompare(b.folder_path || "") || a.name.localeCompare(b.name))
      .slice(0, 300);
  }, [allScenarios, query]);

  const subtreeIds = (folderPath: string) =>
    allScenarios
      .filter((s) => {
        const fp = normPath(s.folder_path);
        return fp === folderPath || fp.startsWith(folderPath + "/");
      })
      .map((s) => s.id);
  const subtreeAllSelected = (folderPath: string) => {
    const ids = subtreeIds(folderPath);
    return ids.length > 0 && ids.every((id) => selected.has(id));
  };
  const toggleSubtree = (folderPath: string) => {
    const ids = subtreeIds(folderPath);
    const allOn = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const crumbs = currentPath ? currentPath.split("/") : [];

  const renderScenarioRow = (s: ScenarioRecord, showPath = false) => (
    <div key={s.id} className="tsp-card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} aria-label={`Select ${s.name}`} />
      <div style={{ flex: 1 }}>
        <strong>📄 {s.name}</strong>
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
          {showPath ? `${s.folder_path || "/"} · ` : ""}
          {s.inputs.length > 0 ? `${s.inputs.length} input(s)` : "no inputs"}
        </div>
      </div>
      <Button variant="secondary" onClick={() => setCodeScenario(s)}>
        Code
      </Button>
      <Button onClick={() => setWizard(s)}>Configure…</Button>
      <Button variant="primary" disabled={running === s.id} onClick={() => void runScenario(s)}>
        {running === s.id ? "…" : "▶ Run"}
      </Button>
    </div>
  );

  return (
    <div>
      <Link to="/projects">← Projects</Link>
      <h1>{t("page.scenarios")}</h1>
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "scenarios", label: t("page.scenarios") },
          { id: "settings", label: "Settings" }
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "overview" && projectId && <ProjectOverview projectId={projectId} />}

      {tab === "settings" && projectId && (
        <div>
          <h3 style={{ marginTop: 0 }}>Project variables — apply to this project only</h3>
          <ScopeLegend />
          <ProjectEnvironmentsPanel projectId={projectId} />
          <ProjectServerVarsPanel projectId={projectId} />
        </div>
      )}

      {tab === "scenarios" && (
        <>
          {scenarios.isLoading && <Spinner />}
          {scenarios.error && <ErrorState error={scenarios.error} />}

          {/* Search across the whole project */}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="🔎 Search scenarios by name or folder…"
            style={{ width: "100%", maxWidth: 420, marginBottom: 12 }}
          />

          {selected.size > 0 && (
            <div
              className="tsp-card"
              style={{ display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 8, zIndex: 10, marginBottom: 12 }}
            >
              <strong style={{ flex: 1 }}>{selected.size} selected</strong>
              <Button variant="secondary" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
              <Button variant="primary" onClick={() => setBatchOpen(true)}>
                ▶ Run selected…
              </Button>
            </div>
          )}

          {searchResults ? (
            // Flat search results
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{searchResults.length} match(es)</div>
              {searchResults.map((s) => renderScenarioRow(s, true))}
              {searchResults.length === 0 && <EmptyState>Nothing matches “{query}”.</EmptyState>}
            </div>
          ) : (
            // Explorer: breadcrumbs → subfolders → scenarios in this folder
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                <button onClick={() => setCurrentPath("")} style={crumbStyle}>
                  🏠 Project root
                </button>
                {crumbs.map((seg, i) => {
                  const path = crumbs.slice(0, i + 1).join("/");
                  return (
                    <span key={path} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: "var(--text-muted)" }}>/</span>
                      <button onClick={() => setCurrentPath(path)} style={crumbStyle}>
                        {seg}
                      </button>
                    </span>
                  );
                })}
              </div>

              {currentPath && (
                <button
                  className="tsp-card"
                  onClick={() => setCurrentPath(crumbs.slice(0, -1).join("/"))}
                  style={{ textAlign: "left", cursor: "pointer", color: "var(--text-muted)" }}
                >
                  ⬆ ..
                </button>
              )}

              {view.subfolders.map((f) => (
                <div key={f.path} className="tsp-card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <input
                    type="checkbox"
                    checked={subtreeAllSelected(f.path)}
                    onChange={() => toggleSubtree(f.path)}
                    aria-label={`Select all in ${f.name}`}
                    title="Select every scenario in this folder"
                  />
                  <button
                    onClick={() => setCurrentPath(f.path)}
                    style={{ flex: 1, textAlign: "left", background: "none", border: "none", color: "var(--text)", cursor: "pointer", fontSize: 15 }}
                  >
                    📁 <strong>{f.name}</strong>{" "}
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>· {f.count}</span>
                  </button>
                  <Button onClick={() => setCurrentPath(f.path)}>Open</Button>
                </div>
              ))}

              {view.here.map((s) => renderScenarioRow(s))}

              {view.subfolders.length === 0 && view.here.length === 0 && (
                <EmptyState>{allScenarios.length === 0 ? "No scenarios in this project." : "This folder is empty."}</EmptyState>
              )}
            </div>
          )}
        </>
      )}
      {wizard && projectId && <RunWizard scenario={wizard} projectId={projectId} onClose={() => setWizard(null)} />}
      {batchOpen && projectId && (
        <BatchRunWizard
          projectId={projectId}
          scenarios={selectedScenarios}
          onRemoveScenario={(id) => {
            const next = new Set(selected);
            next.delete(id);
            setSelected(next);
            if (next.size === 0) setBatchOpen(false);
          }}
          onClose={() => {
            setBatchOpen(false);
            setSelected(new Set());
          }}
        />
      )}
      {codeScenario && (
        <ScenarioCodeModal
          scenarioId={codeScenario.id}
          scenarioName={codeScenario.name}
          onClose={() => setCodeScenario(null)}
        />
      )}
    </div>
  );
}
