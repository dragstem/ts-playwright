import { describe, expect, it } from "vitest";
import { buildDockerRuntimeArgs } from "@ts-playwright/runner";

describe("buildDockerRuntimeArgs (Phase 0 / P0-T01)", () => {
  it("emits no flags when nothing is configured", () => {
    expect(buildDockerRuntimeArgs({})).toEqual([]);
  });

  it("adds cap-drop and no-new-privileges when configured", () => {
    expect(buildDockerRuntimeArgs({ cap_drop: "ALL", no_new_privileges: true })).toEqual([
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges"
    ]);
  });

  it("does not add no-new-privileges unless explicitly enabled", () => {
    expect(buildDockerRuntimeArgs({ cap_drop: "ALL" })).toEqual(["--cap-drop", "ALL"]);
  });

  it("pins memory-swap to the memory limit to block swap bypass", () => {
    expect(buildDockerRuntimeArgs({ memory: "2g" })).toEqual(["--memory", "2g", "--memory-swap", "2g"]);
  });

  it("adds cpus and a positive pids-limit, ignoring non-positive pids", () => {
    expect(buildDockerRuntimeArgs({ cpus: "2", pids_limit: 512 })).toEqual([
      "--cpus",
      "2",
      "--pids-limit",
      "512"
    ]);
    expect(buildDockerRuntimeArgs({ pids_limit: 0 })).toEqual([]);
  });

  it("includes shm-size, ipc, network and non-empty add-hosts", () => {
    expect(
      buildDockerRuntimeArgs({ shm_size: "1g", ipc: "host", network: "bridge", add_hosts: ["a:1.2.3.4", ""] })
    ).toEqual(["--shm-size", "1g", "--ipc", "host", "--network", "bridge", "--add-host", "a:1.2.3.4"]);
  });

  it("keeps a stable flag order", () => {
    expect(
      buildDockerRuntimeArgs({
        cap_drop: "ALL",
        no_new_privileges: true,
        shm_size: "1g",
        cpus: "2",
        memory: "2g",
        pids_limit: 512,
        ipc: "host",
        network: "none",
        add_hosts: ["h:9.9.9.9"]
      })
    ).toEqual([
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--shm-size",
      "1g",
      "--cpus",
      "2",
      "--memory",
      "2g",
      "--memory-swap",
      "2g",
      "--pids-limit",
      "512",
      "--ipc",
      "host",
      "--network",
      "none",
      "--add-host",
      "h:9.9.9.9"
    ]);
  });
});
