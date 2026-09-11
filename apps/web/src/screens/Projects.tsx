import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button, EmptyState, ErrorState, Spinner } from "@ts-playwright/ui";
import type { ProjectRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { ProjectWizard } from "../components/ProjectWizard";
import { useT } from "../i18n";

export function Projects() {
  const { t } = useT();
  const [creating, setCreating] = useState(false);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ProjectRecord[]>("/api/projects")
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ flex: 1 }}>{t("page.projects")}</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          + New project
        </Button>
      </div>
      <p style={{ color: "var(--text-muted)", marginTop: 0 }}>Pick a project to see its runs, scenarios and settings.</p>
      {projects.isLoading && <Spinner />}
      {projects.error && <ErrorState error={projects.error} />}
      <div style={{ display: "grid", gap: 12 }}>
        {(projects.data ?? []).map((p) => (
          <Link
            key={p.id}
            to={`/projects/${p.id}`}
            className="tsp-card"
            style={{ display: "block", color: "var(--text)" }}
          >
            <strong>{p.name}</strong>
            {p.description && <div style={{ color: "var(--text-muted)" }}>{p.description}</div>}
          </Link>
        ))}
        {projects.data?.length === 0 && (
          <EmptyState>No projects yet. Click “New project” to create your first one.</EmptyState>
        )}
      </div>
      {creating && <ProjectWizard onClose={() => setCreating(false)} />}
    </div>
  );
}
