import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agent", {
  clipboardReadText: () => ipcRenderer.invoke("agent:clipboard-read-text"),
  clipboardWriteText: (text: string) => ipcRenderer.invoke("agent:clipboard-write-text", { text }),
  getConfig: () => ipcRenderer.invoke("agent:get-config"),
  setServerUrl: (serverUrl: string) => ipcRenderer.invoke("agent:set-server-url", { server_url: serverUrl }),
  getRuntimeState: () => ipcRenderer.invoke("agent:get-runtime-state"),
  getAuthHeader: () => ipcRenderer.invoke("agent:get-auth-header"),
  getAuthStatus: () => ipcRenderer.invoke("agent:get-auth-status"),
  setToken: (token: string) => ipcRenderer.invoke("agent:set-token", { token }),
  onRuntime: (callback: (state: unknown) => void) =>
    ipcRenderer.on("agent:runtime", (_event, state) => callback(state)),
  startRecording: (payload: { start_url: string; save_auth_state: boolean }) =>
    ipcRenderer.invoke("agent:start-recording", payload),
  stopRecording: () => ipcRenderer.invoke("agent:stop-recording"),
  readFile: (payload: { path: string }) => ipcRenderer.invoke("agent:read-file", payload),
  writeFile: (payload: { path: string; content: string }) => ipcRenderer.invoke("agent:write-file", payload),
  replay: (payload: { source_path: string; metadata: unknown; auth_state_path?: string | null }) =>
    ipcRenderer.invoke("agent:replay", payload),
  upload: (payload: {
    source_path: string;
    project_id: string;
    env_id: string;
    folder_path: string;
    scenario_name: string;
    recorded_base_url: string;
    outputs: unknown[];
    inputs: unknown[];
    auth_state_path?: string | null;
  }) => ipcRenderer.invoke("agent:upload", payload)
});
