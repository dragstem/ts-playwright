import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button, SecretField } from "@ts-playwright/ui";
import type { EnvironmentRecord, ProjectRecord } from "@ts-playwright/shared";
import { api } from "../api";
import { Modal } from "./Modal";
import { toastMessage, useToast } from "./Toast";

// Guided project creation: name → first environment (required) → server vars (optional). An
// environment is a hard prerequisite (scenarios can only be uploaded/run against an existing env),
// so it is its own required step. Creates project → env → server-vars in sequence, then opens the
// new project's Overview.
export function ProjectWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState("");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [envName, setEnvName] = useState("staging");
  const [baseUrl, setBaseUrl] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [username, setUsername] = useState("");
  const [merchant, setMerchant] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(toastMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const createProject = () =>
    run(async () => {
      const project = await api.post<ProjectRecord>("/api/projects", { name: name.trim(), description: description.trim() || null });
      setProjectId(project.id);
      setStep(1);
    });

  const createEnvironment = () =>
    run(async () => {
      await api.post<EnvironmentRecord>(`/api/projects/${projectId}/environments`, {
        name: envName.trim(),
        base_url: baseUrl.trim(),
        is_default: isDefault
      });
      setStep(2);
    });

  const finish = (withServerVars: boolean) =>
    run(async () => {
      if (withServerVars) {
        const body: Record<string, unknown> = { server_username: username.trim(), server_merchant: merchant.trim() };
        if (password) body.server_password = password;
        if (otp) body.server_2faotp = otp;
        await api.post(`/api/projects/${projectId}/server-vars`, body);
      }
      await qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      navigate(`/projects/${projectId}`);
    });

  const stepLabel = ["1. Project", "2. Environment", "3. Server vars (optional)"][step];

  return (
    <Modal onClose={onClose} width={520}>
        <h2 style={{ margin: 0 }}>New project</h2>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{stepLabel}</div>

        {step === 0 && (
          <>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Project name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Payments QA" autoFocus />
            </label>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Description (optional)</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void createProject()}>
                Next
              </Button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
              A project needs at least one environment before scenarios can be uploaded or run.
            </p>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Environment name</span>
              <input value={envName} onChange={(e) => setEnvName(e.target.value)} placeholder="staging" />
            </label>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Base URL</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging.example.com" />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              Default environment for this project
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="primary" disabled={busy || !envName.trim() || !baseUrl.trim()} onClick={() => void createEnvironment()}>
                Next
              </Button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
              Optional project defaults for {"{server_*}"} placeholders. Add these if your scenarios log in.
            </p>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>server_username</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>server_password</span>
              <SecretField value={password} onChange={(e) => setPassword(e.target.value)} placeholder="optional" />
            </label>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>server_2faotp (base32)</span>
              <SecretField value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="optional" />
            </label>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>server_merchant</span>
              <input value={merchant} onChange={(e) => setMerchant(e.target.value)} />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button disabled={busy} onClick={() => void finish(false)}>
                Skip &amp; finish
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void finish(true)}>
                Save &amp; finish
              </Button>
            </div>
          </>
        )}
    </Modal>
  );
}
