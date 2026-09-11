import { describe, expect, it } from "vitest";
import { AppStateSchema, OTP_2FA_INPUT_TYPE, STRING_INPUT_TYPE } from "@ts-playwright/shared";
import {
  collectScenariosForFolderPaths,
  prepareFolderRunPlans,
  prepareScenarioRunPlan,
  previewServerBindings,
  scenarioBelongsToFolderTree
} from "../apps/server/src/run-planner";

const baseState = AppStateSchema.parse({
  projects: [
    {
      id: "proj_demo",
      name: "Demo Project",
      description: "Sample project"
    }
  ],
  environments: [
    {
      id: "staging",
      project_id: "proj_demo",
      name: "staging",
      base_url: "https://example.com",
      is_default: true
    }
  ],
  accounts: [
    {
      login: "alice",
      password: "secret-pass",
      "2fa_otp": "JBSWY3DPEHPK3PXP",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    }
  ],
  merchants: [
    {
      name: "acme",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    }
  ],
  scenarios: [
    {
      id: "scenario-a",
      project_id: "proj_demo",
      env_id: "staging",
      name: "A",
      slug: "a",
      folder_path: "suite/a",
      created_by: "tester",
      created_at: "2026-01-01T00:00:00.000Z",
      package_path: "suite/a/package.zip",
      status: "active",
      inputs: [
        {
          name: "user_name",
          type: STRING_INPUT_TYPE,
          description: "",
          otp_login: ""
        }
      ]
    },
    {
      id: "scenario-b",
      project_id: "proj_demo",
      env_id: "staging",
      name: "B",
      slug: "b",
      folder_path: "suite/b",
      created_by: "tester",
      created_at: "2026-01-01T00:00:00.000Z",
      package_path: "suite/b/package.zip",
      status: "active",
      inputs: []
    },
    {
      id: "scenario-c",
      project_id: "proj_demo",
      env_id: "staging",
      name: "C",
      slug: "c",
      folder_path: "suite/a/child",
      created_by: "tester",
      created_at: "2026-01-01T00:00:00.000Z",
      package_path: "suite/a/child/package.zip",
      status: "active",
      inputs: [
        {
          name: "secure_code",
          type: OTP_2FA_INPUT_TYPE,
          description: "",
          otp_login: "JBSWY3DPEHPK3PXP"
        }
      ]
    }
  ],
  runs: []
});

describe("folder run planner", () => {
  it("matches scenarios against folder trees including the project root", () => {
    expect(scenarioBelongsToFolderTree("suite/a", "suite")).toBe(true);
    expect(scenarioBelongsToFolderTree("suite/a/child", "suite/a")).toBe(true);
    expect(scenarioBelongsToFolderTree("suite/a", "suite/b")).toBe(false);
    expect(scenarioBelongsToFolderTree("suite/a", "")).toBe(true);
  });

  it("collects scenarios once even when selected folders overlap", () => {
    const scenarios = collectScenariosForFolderPaths(baseState, "proj_demo", ["suite", "suite/a"]);
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["scenario-a", "scenario-c", "scenario-b"]);
  });

  it("builds batch run plans with scenario-specific inputs", () => {
    const plans = prepareFolderRunPlans(
      baseState,
      "proj_demo",
      ["suite", "suite/a"],
      {
        "scenario-a": { user_name: "alice" }
      },
      {
        "scenario-a": { stage: 2 },
        "scenario-b": { stage: 3, default_timeout_ms: 45_000 }
      }
    );

    expect(plans).toHaveLength(3);
    expect(plans[0]?.scenario.id).toBe("scenario-a");
    expect(plans[0]?.run.inputs).toEqual({ user_name: "alice" });
    expect(plans[0]?.execution_stage).toBe(2);
    expect(plans[0]?.run.execution_stage).toBe(2);
    expect(plans[0]?.run.batch_id).toBeTruthy();
    expect(plans[1]?.scenario.id).toBe("scenario-c");
    expect(plans[1]?.run.inputs).toEqual({ secure_code: "JBSWY3DPEHPK3PXP" });
    expect(plans[1]?.execution_stage).toBe(1);
    expect(plans[1]?.otp_secrets).toEqual({ secure_code: "JBSWY3DPEHPK3PXP" });
    expect(plans[2]?.scenario.id).toBe("scenario-b");
    expect(plans[2]?.execution_stage).toBe(3);
    expect(plans[2]?.default_timeout_ms).toBe(45_000);
    expect(plans[2]?.run.default_timeout_ms).toBe(45_000);
    expect(plans[0]?.run.batch_id).toBe(plans[1]?.run.batch_id);
  });

  it("expands repeated scenario runs into staged parallel batches", () => {
    const plans = prepareFolderRunPlans(
      baseState,
      "proj_demo",
      ["suite/a"],
      {
        "scenario-a": { user_name: "alice" }
      },
      {
        "scenario-a": { stage: 2, amount_times_to_run: 5, parallel_batch_size: 2 }
      },
      {},
      {},
      ["scenario-a"]
    );

    expect(plans).toHaveLength(5);
    expect(plans.map((plan) => plan.run.run_iteration)).toEqual([1, 2, 3, 4, 5]);
    expect(plans.map((plan) => plan.run.amount_times_to_run)).toEqual([5, 5, 5, 5, 5]);
    expect(plans.map((plan) => plan.execution_stage)).toEqual([2, 2, 3, 3, 4]);
    expect(plans.every((plan) => plan.run.batch_id === plans[0]?.run.batch_id)).toBe(true);
  });

  it("builds folder run plans only for selected scenarios when scenario ids are provided", () => {
    const plans = prepareFolderRunPlans(baseState, "proj_demo", ["suite"], {}, {}, {}, {}, ["scenario-b", "scenario-a"]);

    expect(plans.map((plan) => plan.scenario.id)).toEqual(["scenario-a", "scenario-b"]);
    expect(plans.every((plan) => plan.run.batch_id === plans[0]?.run.batch_id)).toBe(true);
  });

  it("rejects selected scenario ids outside the selected folders", () => {
    expect(() => prepareFolderRunPlans(baseState, "proj_demo", ["suite/a"], {}, {}, {}, {}, ["scenario-b"])).toThrow(
      "Scenario is not part of the selected folders: scenario-b"
    );
  });

  it("keeps a per-run default timeout override when it is provided", () => {
    const scenario = baseState.scenarios.find((item) => item.id === "scenario-a");
    if (!scenario) {
      throw new Error("Scenario A not found");
    }

    const plan = prepareScenarioRunPlan(baseState, scenario, {
      default_timeout_ms: 12_345,
      inputs: {}
    });

    expect(plan.default_timeout_ms).toBe(12_345);
    expect(plan.run.default_timeout_ms).toBe(12_345);
  });

  it("rejects folder runs when a required otp input is missing", () => {
    const otpRequiredState = AppStateSchema.parse({
      ...baseState,
      scenarios: [
        ...baseState.scenarios,
        {
          id: "scenario-otp-required",
          project_id: "proj_demo",
          env_id: "staging",
          name: "OTP Required",
          slug: "otp_required",
          folder_path: "suite/otp",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "suite/otp/package.zip",
          status: "active",
          inputs: [
            {
              name: "one_time_code",
              type: OTP_2FA_INPUT_TYPE,
              description: "",
              otp_login: ""
            }
          ]
        }
      ]
    });

    expect(() => prepareFolderRunPlans(otpRequiredState, "proj_demo", ["suite/otp"], {})).toThrow(
      "Missing required inputs: one_time_code"
    );
  });

  it("applies shared inputs to matching scenarios and allows scenario overrides", () => {
    const sharedInputState = AppStateSchema.parse({
      ...baseState,
      scenarios: [
        ...baseState.scenarios,
        {
          id: "scenario-d",
          project_id: "proj_demo",
          env_id: "staging",
          name: "D",
          slug: "d",
          folder_path: "suite/d",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "suite/d/package.zip",
          status: "active",
          inputs: [
            {
              name: "user_name",
              type: STRING_INPUT_TYPE,
              description: "",
              otp_login: ""
            }
          ]
        }
      ]
    });

    const plans = prepareFolderRunPlans(
      sharedInputState,
      "proj_demo",
      ["suite"],
      {
        "scenario-d": { user_name: "bob" }
      },
      {},
      {
        user_name: "alice"
      }
    );

    const planByScenarioId = new Map(plans.map((plan) => [plan.scenario.id, plan]));
    expect(planByScenarioId.get("scenario-a")?.run.inputs).toEqual({ user_name: "alice" });
    expect(planByScenarioId.get("scenario-d")?.run.inputs).toEqual({ user_name: "bob" });
    expect(planByScenarioId.get("scenario-b")?.run.inputs).toEqual({});
  });

  it("auto-generates any string input when it is left empty", () => {
    const scenario = baseState.scenarios.find((item) => item.id === "scenario-a");
    if (!scenario) {
      throw new Error("Scenario A not found");
    }

    const plan = prepareScenarioRunPlan(baseState, scenario, {
      inputs: {}
    });

    expect(plan.run.inputs.user_name).toMatch(/^user_name_a_\d{15}$/);
    expect(plan.inputs.user_name).toBe(plan.run.inputs.user_name);
  });

  it("expands shared templates into unique values for each string input", () => {
    const templateBatchState = AppStateSchema.parse({
      ...baseState,
      scenarios: [
        ...baseState.scenarios,
        {
          id: "scenario-template-a",
          project_id: "proj_demo",
          env_id: "staging",
          name: "Template A",
          slug: "template_a",
          folder_path: "suite/a",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "suite/a/template-a.zip",
          status: "active",
          inputs: [
            {
              name: "order_id",
              type: STRING_INPUT_TYPE,
              description: "",
              otp_login: ""
            }
          ]
        },
        {
          id: "scenario-template-b",
          project_id: "proj_demo",
          env_id: "staging",
          name: "Template B",
          slug: "template_b",
          folder_path: "suite/b",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "suite/b/template-b.zip",
          status: "active",
          inputs: [
            {
              name: "order_id",
              type: STRING_INPUT_TYPE,
              description: "",
              otp_login: ""
            }
          ]
        }
      ]
    });

    const plans = prepareFolderRunPlans(
      templateBatchState,
      "proj_demo",
      ["suite"],
      {},
      {},
      {
        user_name: "alice",
        order_id: "custom_{input_name}_{folder_name}_{uniq_number}"
      }
    ).filter((plan) => plan.scenario.id === "scenario-template-a" || plan.scenario.id === "scenario-template-b");

    expect(plans).toHaveLength(2);
    expect(plans[0]?.run.inputs.order_id).toMatch(/^custom_order_id_a_\d{15}$/);
    expect(plans[1]?.run.inputs.order_id).toMatch(/^custom_order_id_b_\d{15}$/);
    expect(plans[0]?.run.inputs.order_id).not.toBe(plans[1]?.run.inputs.order_id);
  });

  it("resolves {random}, {uuid} and {date} generation tokens in any input", () => {
    const scenario = baseState.scenarios.find((item) => item.id === "scenario-a");
    if (!scenario) {
      throw new Error("Scenario A not found");
    }
    const plan = prepareScenarioRunPlan(baseState, scenario, {
      inputs: { user_name: "u_{random}_{date}_{uuid}" }
    });
    // {random} -> 9 digits, {date} -> YYYYMMDD, {uuid} -> a uuid. Like other automatic tokens, these
    // resolve at plan time (the stored form is the resolved value, not the template).
    expect(plan.inputs.user_name).toMatch(/^u_\d{9}_\d{8}_[0-9a-f-]{36}$/);
    expect(plan.run.inputs.user_name).toBe(plan.inputs.user_name);
  });

  it("generates a different {random} value per run", () => {
    const scenario = baseState.scenarios.find((item) => item.id === "scenario-a");
    if (!scenario) {
      throw new Error("Scenario A not found");
    }
    const a = prepareScenarioRunPlan(baseState, scenario, { inputs: { user_name: "{random}" } });
    const b = prepareScenarioRunPlan(baseState, scenario, { inputs: { user_name: "{random}" } });
    expect(a.inputs.user_name).not.toBe(b.inputs.user_name);
  });

  it("keeps datetime templates for container runtime resolution", () => {
    const scenario = baseState.scenarios.find((item) => item.id === "scenario-a");
    if (!scenario) {
      throw new Error("Scenario A not found");
    }

    const plan = prepareScenarioRunPlan(baseState, scenario, {
      inputs: {
        user_name: "auto_{datetime}_{input_name}"
      }
    });

    expect(plan.run.inputs.user_name).toBe("auto_{datetime}_user_name");
    expect(plan.inputs.user_name).toBe("auto_{datetime}_user_name");
  });

  it("expands increment templates across parallel and staged run plans", () => {
    const incrementState = AppStateSchema.parse({
      ...baseState,
      scenarios: [
        ...baseState.scenarios,
        {
          id: "scenario-d",
          project_id: "proj_demo",
          env_id: "staging",
          name: "D",
          slug: "d",
          folder_path: "suite/d",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "suite/d/package.zip",
          status: "active",
          inputs: [{ name: "user_name", type: STRING_INPUT_TYPE, description: "", otp_login: "" }]
        },
        {
          id: "scenario-e",
          project_id: "proj_demo",
          env_id: "staging",
          name: "E",
          slug: "e",
          folder_path: "suite/e",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "suite/e/package.zip",
          status: "active",
          inputs: [{ name: "user_name", type: STRING_INPUT_TYPE, description: "", otp_login: "" }]
        }
      ]
    });

    const plans = prepareFolderRunPlans(
      incrementState,
      "proj_demo",
      ["suite"],
      {},
      { "scenario-e": { stage: 2 } },
      { user_name: "auto_{increment}" },
      {},
      ["scenario-a", "scenario-d", "scenario-e"]
    );
    const increments = plans.map((plan) => Number(plan.run.inputs.user_name.replace("auto_", "")));

    expect(increments.every((value) => Number.isInteger(value))).toBe(true);
    expect(increments[1]).toBe(increments[0] + 1);
    expect(increments[2]).toBe(increments[1] + 1);
    expect(plans.map((plan) => plan.execution_stage)).toEqual([1, 1, 2]);
  });

  it("resolves selected server account and merchant placeholders for runtime inputs", () => {
    const scenario = AppStateSchema.parse({
      ...baseState,
      scenarios: [
        {
          id: "scenario-server-data",
          project_id: "proj_demo",
          env_id: "staging",
          name: "Server Data",
          slug: "server_data",
          folder_path: "suite/server",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "suite/server/package.zip",
          status: "active",
          inputs: [
            {
              name: "login_value",
              type: STRING_INPUT_TYPE,
              description: "",
              otp_login: ""
            },
            {
              name: "password_value",
              type: STRING_INPUT_TYPE,
              description: "",
              otp_login: ""
            },
            {
              name: "otp_value",
              type: OTP_2FA_INPUT_TYPE,
              description: "",
              otp_login: ""
            },
            {
              name: "merchant_value",
              type: STRING_INPUT_TYPE,
              description: "",
              otp_login: ""
            }
          ]
        }
      ]
    }).scenarios[0];

    const plan = prepareScenarioRunPlan(baseState, scenario, {
      account_login: "alice",
      merchant_name: "acme",
      inputs: {
        login_value: "{server_username}",
        password_value: "{server_password}",
        otp_value: "{server_2faotp}",
        merchant_value: "{server_merchant}"
      }
    });

    expect(plan.run.account_login).toBe("alice");
    expect(plan.run.merchant_name).toBe("acme");
    expect(plan.run.server_username).toBe("alice");
    expect(plan.run.server_password).toBe("secret-pass");
    expect(plan.run.server_2faotp).toBe("JBSWY3DPEHPK3PXP");
    expect(plan.run.server_merchant).toBe("acme");
    expect(plan.inputs).toMatchObject({
      login_value: "alice",
      password_value: "secret-pass",
      merchant_value: "acme",
      server_username: "alice",
      server_password: "secret-pass",
      server_merchant: "acme"
    });
    expect(plan.otp_secrets).toMatchObject({
      otp_value: "JBSWY3DPEHPK3PXP",
      server_2faotp: "JBSWY3DPEHPK3PXP"
    });
    expect(plan.run.inputs).toEqual({
      login_value: "{server_username}",
      password_value: "{server_password}",
      otp_value: "{server_2faotp}",
      merchant_value: "{server_merchant}"
    });
  });

  it("prefers explicit server values over presets for runtime placeholders", () => {
    const scenario = AppStateSchema.parse({
      ...baseState,
      scenarios: [
        {
          id: "scenario-server-data-manual",
          project_id: "proj_demo",
          env_id: "staging",
          name: "Server Data Manual",
          slug: "server_data_manual",
          folder_path: "suite/server",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "suite/server/package.zip",
          status: "active",
          inputs: [
            {
              name: "login_value",
              type: STRING_INPUT_TYPE,
              description: "",
              otp_login: ""
            },
            {
              name: "password_value",
              type: STRING_INPUT_TYPE,
              description: "",
              otp_login: ""
            },
            {
              name: "otp_value",
              type: OTP_2FA_INPUT_TYPE,
              description: "",
              otp_login: ""
            },
            {
              name: "merchant_value",
              type: STRING_INPUT_TYPE,
              description: "",
              otp_login: ""
            }
          ]
        }
      ]
    }).scenarios[0];

    const plan = prepareScenarioRunPlan(baseState, scenario, {
      account_login: "alice",
      merchant_name: "acme",
      server_username: "custom-user",
      server_password: "custom-pass",
      server_2faotp: "654321",
      server_merchant: "manual-merchant",
      inputs: {
        login_value: "{server_username}",
        password_value: "{server_password}",
        otp_value: "{server_2faotp}",
        merchant_value: "{server_merchant}"
      }
    });

    expect(plan.run.account_login).toBe("alice");
    expect(plan.run.merchant_name).toBe("acme");
    expect(plan.run.server_username).toBe("custom-user");
    expect(plan.run.server_password).toBe("custom-pass");
    expect(plan.run.server_2faotp).toBe("654321");
    expect(plan.run.server_merchant).toBe("manual-merchant");
    expect(plan.inputs).toMatchObject({
      login_value: "custom-user",
      password_value: "custom-pass",
      otp_value: "654321",
      merchant_value: "manual-merchant",
      server_username: "custom-user",
      server_password: "custom-pass",
      server_2faotp: "654321",
      server_merchant: "manual-merchant"
    });
    expect(plan.otp_secrets).toEqual({});
  });

  it("ensures compatible payout addresses and spreads them across a folder batch", () => {
    const { state, addresses } = createPayoutPoolState();

    const plans = prepareFolderRunPlans(
      state,
      "proj_demo",
      ["stage env"],
      {},
      {},
      {},
      {
        pool_selections: {
          address: { pool_id: "payout-pool", mode: "auto" }
        },
        ensure_right_address_to_run: true
      }
    );
    const plansByScenarioId = new Map(plans.map((plan) => [plan.scenario.id, plan]));

    expect(plansByScenarioId.get("payout-arb")?.run.inputs.address).toBe(addresses.evmOne);
    expect(plansByScenarioId.get("payout-eth")?.run.inputs.address).toBe(addresses.evmTwo);
    expect(plansByScenarioId.get("payout-tron")?.run.inputs.address).toBe(addresses.tronOne);

    const poolsSnapshot = plansByScenarioId.get("payout-arb")?.run.runtime_snapshot.pools as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(poolsSnapshot?.address?.address_family).toBe("evm");
    expect(poolsSnapshot?.address?.target_network).toBe("Arbitrum Ethereum");
    expect(poolsSnapshot?.address?.ensure_right_address_to_run).toBe(true);
  });

  it("replaces an incompatible manual pool item when address safety is enabled", () => {
    const { state, addresses } = createPayoutPoolState();
    const scenario = state.scenarios.find((item) => item.id === "payout-arb");
    if (!scenario) {
      throw new Error("Payout scenario not found");
    }

    const plan = prepareScenarioRunPlan(state, scenario, {
      pool_selections: {
        address: { pool_id: "payout-pool", item_id: "tron-1", mode: "manual" }
      },
      ensure_right_address_to_run: true
    });

    expect(plan.run.inputs.address).toBe(addresses.evmOne);
    const poolsSnapshot = plan.run.runtime_snapshot.pools as Record<string, Record<string, unknown>>;
    expect(poolsSnapshot.address?.item_id).toBe("evm-1");
  });

  it("rejects address-safe runs when the pool has no compatible item", () => {
    const { state } = createPayoutPoolState();
    const tronScenario = state.scenarios.find((item) => item.id === "payout-tron");
    if (!tronScenario) {
      throw new Error("Tron payout scenario not found");
    }
    const tronlessState = AppStateSchema.parse({
      ...state,
      pool_items: state.pool_items.filter((item) => item.id !== "tron-1")
    });

    expect(() =>
      prepareScenarioRunPlan(tronlessState, tronScenario, {
        pool_selections: {
          address: { pool_id: "payout-pool", mode: "auto" }
        },
        ensure_right_address_to_run: true
      })
    ).toThrow("Pool Payout addresses does not have an enabled Tron USDT address (tron) for address");
  });

  // Phase 2 / 2-R10 — arbitrary extra project-scoped server_* tokens.
  it("previews resolved server bindings with secrets masked", () => {
    const preview = previewServerBindings(extraServerVarsState(), {
      project_id: "proj_demo",
      account_login: "alice",
      merchant_name: "acme"
    });
    expect(preview).toEqual({
      server_username: "alice",
      has_password: true,
      has_2faotp: true,
      server_merchant: "acme",
      extra: { server_apikey: "secret-key-123", server_endpoint: "https://api.example.com" }
    });
  });

  it("previews empty server bindings when nothing is selected", () => {
    const preview = previewServerBindings(baseState, { project_id: "proj_demo" });
    expect(preview).toEqual({
      server_username: "",
      has_password: false,
      has_2faotp: false,
      server_merchant: "",
      extra: {}
    });
  });

  // Phase 2 / 2-R9 — project-scoped accounts/merchants resolve over global ones.
  it("prefers a project-scoped account over a global one with the same login", () => {
    const state = AppStateSchema.parse({
      ...baseState,
      accounts: [
        {
          login: "alice",
          password: "global-pass",
          "2fa_otp": "",
          project_id: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        },
        {
          login: "alice",
          password: "scoped-pass",
          "2fa_otp": "",
          project_id: "proj_demo",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ]
    });
    const scenario = state.scenarios.find((item) => item.id === "scenario-a");
    if (!scenario) {
      throw new Error("Scenario A not found");
    }
    const plan = prepareScenarioRunPlan(state, scenario, {
      account_login: "alice",
      inputs: { user_name: "{server_password}" }
    });
    expect(plan.inputs.user_name).toBe("scoped-pass");
  });

  it("falls back to the global account when no project-scoped one exists", () => {
    const state = AppStateSchema.parse({
      ...baseState,
      accounts: [
        {
          login: "alice",
          password: "global-pass",
          "2fa_otp": "",
          project_id: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ]
    });
    const scenario = state.scenarios.find((item) => item.id === "scenario-a");
    if (!scenario) {
      throw new Error("Scenario A not found");
    }
    const plan = prepareScenarioRunPlan(state, scenario, {
      account_login: "alice",
      inputs: { user_name: "{server_password}" }
    });
    expect(plan.inputs.user_name).toBe("global-pass");
  });

  it("substitutes extra project-scoped server_* tokens into runtime inputs", () => {
    const scenario = extraServerVarsScenario();
    const plan = prepareScenarioRunPlan(extraServerVarsState(), scenario, {
      inputs: {
        api_value: "{server_apikey}",
        url_value: "prefix-{server_endpoint}-suffix",
        keep_value: "{not_a_var}"
      }
    });

    expect(plan.inputs).toMatchObject({
      api_value: "secret-key-123",
      url_value: "prefix-https://api.example.com-suffix",
      // Unknown placeholders that match no token are left untouched for container-side resolution.
      keep_value: "{not_a_var}"
    });
    // The stored (templated) form is preserved so the value re-resolves on Retry.
    expect(plan.run.inputs.api_value).toBe("{server_apikey}");
  });

  it("throws when an extra token is referenced but its project value is empty", () => {
    const scenario = extraServerVarsScenario();
    expect(() =>
      prepareScenarioRunPlan(extraServerVarsState({ server_apikey: "" }), scenario, {
        inputs: { api_value: "{server_apikey}" }
      })
    ).toThrow("Set server variable server_apikey in the project defaults to use {server_apikey}");
  });

  it("ignores extra keys that collide with the standard server_* names", () => {
    const scenario = extraServerVarsScenario();
    // An extra entry named server_username must not shadow the account-resolved value.
    const plan = prepareScenarioRunPlan(extraServerVarsState({ server_username: "from-extra" }), scenario, {
      account_login: "alice",
      inputs: { url_value: "{server_username}" }
    });

    expect(plan.inputs.url_value).toBe("alice");
  });
});

function extraServerVarsScenario() {
  return AppStateSchema.parse({
    ...baseState,
    scenarios: [
      {
        id: "scenario-extra-vars",
        project_id: "proj_demo",
        env_id: "staging",
        name: "Extra Vars",
        slug: "extra_vars",
        folder_path: "suite/extra",
        created_by: "tester",
        created_at: "2026-01-01T00:00:00.000Z",
        package_path: "suite/extra/package.zip",
        status: "active",
        inputs: [
          { name: "api_value", type: STRING_INPUT_TYPE, description: "", otp_login: "" },
          { name: "url_value", type: STRING_INPUT_TYPE, description: "", otp_login: "" },
          { name: "keep_value", type: STRING_INPUT_TYPE, description: "", otp_login: "" }
        ]
      }
    ]
  }).scenarios[0];
}

function extraServerVarsState(extra: Record<string, string> = {}) {
  return AppStateSchema.parse({
    ...baseState,
    project_server_vars: [
      {
        project_id: "proj_demo",
        server_username: "",
        server_password: "",
        server_2faotp: "",
        server_merchant: "",
        extra: {
          server_apikey: "secret-key-123",
          server_endpoint: "https://api.example.com",
          ...extra
        },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      }
    ]
  });
}

function createPayoutPoolState() {
  const addresses = {
    evmOne: "0x1111111111111111111111111111111111111111",
    evmTwo: "0x2222222222222222222222222222222222222222",
    tronOne: `T${"A".repeat(33)}`
  };

  return {
    addresses,
    state: AppStateSchema.parse({
      ...baseState,
      pools: [
        {
          id: "payout-pool",
          name: "Payout addresses",
          kind: "payout_address",
          project_id: "proj_demo",
          env_ids: ["staging"],
          dedupe: true,
          allocation_strategy: "first_enabled",
          template: "",
          fetch_scenario_id: null,
          fetch_input_name: "addresses_json",
          fetch_output_key: "address_info",
          auto_import_enabled: false,
          auto_import_scenario_id: null,
          auto_import_output_key: "",
          auto_import_mode: "whole",
          auto_import_json_path: "",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ],
      pool_items: [
        {
          id: "evm-1",
          pool_id: "payout-pool",
          value: addresses.evmOne,
          label: "EVM one",
          enabled: true,
          currency: "ETH",
          network: "Ethereum",
          metadata: {},
          source: { type: "manual" },
          created_at: "2026-01-01T00:00:01.000Z",
          updated_at: "2026-01-01T00:00:01.000Z",
          last_fetched_at: null,
          last_fetch_status: null
        },
        {
          id: "evm-2",
          pool_id: "payout-pool",
          value: addresses.evmTwo,
          label: "EVM two",
          enabled: true,
          currency: "ETH",
          network: "Arbitrum Ethereum",
          metadata: {},
          source: { type: "manual" },
          created_at: "2026-01-01T00:00:02.000Z",
          updated_at: "2026-01-01T00:00:02.000Z",
          last_fetched_at: null,
          last_fetch_status: null
        },
        {
          id: "tron-1",
          pool_id: "payout-pool",
          value: addresses.tronOne,
          label: "Tron one",
          enabled: true,
          currency: "TRX",
          network: "Tron",
          metadata: {},
          source: { type: "manual" },
          created_at: "2026-01-01T00:00:03.000Z",
          updated_at: "2026-01-01T00:00:03.000Z",
          last_fetched_at: null,
          last_fetch_status: null
        }
      ],
      scenarios: [
        ...baseState.scenarios,
        {
          id: "payout-arb",
          project_id: "proj_demo",
          env_id: "staging",
          name: "Create payout",
          slug: "create_payout_arbitrum",
          folder_path: "stage env/Arbitrum Ethereum",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "stage env/arbitrum/package.zip",
          status: "active",
          inputs: [{ name: "address", type: STRING_INPUT_TYPE, description: "", otp_login: "" }]
        },
        {
          id: "payout-eth",
          project_id: "proj_demo",
          env_id: "staging",
          name: "Create payout",
          slug: "create_payout_ethereum",
          folder_path: "stage env/Ethereum",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "stage env/ethereum/package.zip",
          status: "active",
          inputs: [{ name: "address", type: STRING_INPUT_TYPE, description: "", otp_login: "" }]
        },
        {
          id: "payout-tron",
          project_id: "proj_demo",
          env_id: "staging",
          name: "Create payout",
          slug: "create_payout_tron",
          folder_path: "stage env/Tron USDT",
          created_by: "tester",
          created_at: "2026-01-01T00:00:00.000Z",
          package_path: "stage env/tron/package.zip",
          status: "active",
          inputs: [{ name: "address", type: STRING_INPUT_TYPE, description: "", otp_login: "" }]
        }
      ]
    })
  };
}
