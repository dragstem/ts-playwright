import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import type { ProjectRecord } from "@ts-playwright/shared";
import { api } from "../api";

// Header project switcher: jump straight to any project's detail page. Reflects the current
// /projects/:projectId route, and hides itself until at least one project exists.
export function ProjectSwitcher() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ProjectRecord[]>("/api/projects")
  });

  const items = projects.data ?? [];
  if (items.length === 0) {
    return null;
  }

  return (
    <select
      value={projectId ?? ""}
      onChange={(e) => {
        if (e.target.value) {
          navigate(`/projects/${e.target.value}`);
        }
      }}
      title="Switch project"
      style={{ maxWidth: 180 }}
    >
      <option value="">Project…</option>
      {items.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}
