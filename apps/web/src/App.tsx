import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { AppShell } from "./components/AppShell";
import { Login } from "./screens/Login";
import { Dashboard } from "./screens/Dashboard";
import { Projects } from "./screens/Projects";
import { ProjectDetail } from "./screens/ProjectDetail";
import { RunLive } from "./screens/RunLive";
import { Runs } from "./screens/Runs";
import { Batches, BatchDetail } from "./screens/Batches";
import { Users } from "./screens/Users";
import { Audit } from "./screens/Audit";
import { Credentials } from "./screens/Credentials";
import { Merchants } from "./screens/Merchants";
import { Pools } from "./screens/Pools";
import { Tokens } from "./screens/Tokens";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <p className="tsp-app">Loading…</p>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <AppShell>{children}</AppShell>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <p className="tsp-app">Loading…</p>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (user.role !== "admin") {
    return <AppShell><p style={{ color: "var(--status-failed)" }}>Forbidden — admin only.</p></AppShell>;
  }
  return <AppShell>{children}</AppShell>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/projects"
        element={
          <RequireAuth>
            <Projects />
          </RequireAuth>
        }
      />
      <Route
        path="/projects/:projectId"
        element={
          <RequireAuth>
            <ProjectDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/runs"
        element={
          <RequireAuth>
            <Runs />
          </RequireAuth>
        }
      />
      <Route
        path="/runs/:runId"
        element={
          <RequireAuth>
            <RunLive />
          </RequireAuth>
        }
      />
      <Route
        path="/batches"
        element={
          <RequireAuth>
            <Batches />
          </RequireAuth>
        }
      />
      <Route
        path="/batches/:batchId"
        element={
          <RequireAuth>
            <BatchDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/credentials"
        element={
          <RequireAuth>
            <Credentials />
          </RequireAuth>
        }
      />
      <Route
        path="/merchants"
        element={
          <RequireAuth>
            <Merchants />
          </RequireAuth>
        }
      />
      <Route
        path="/pools"
        element={
          <RequireAuth>
            <Pools />
          </RequireAuth>
        }
      />
      <Route
        path="/tokens"
        element={
          <RequireAuth>
            <Tokens />
          </RequireAuth>
        }
      />
      <Route
        path="/admin/users"
        element={
          <RequireAdmin>
            <Users />
          </RequireAdmin>
        }
      />
      <Route
        path="/admin/audit"
        element={
          <RequireAdmin>
            <Audit />
          </RequireAdmin>
        }
      />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}
