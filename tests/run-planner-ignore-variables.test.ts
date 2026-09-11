import { describe, expect, it } from "vitest";
import { AppStateSchema, OTP_2FA_INPUT_TYPE, STRING_INPUT_TYPE } from "@ts-playwright/shared";
import { prepareFolderRunPlans, prepareScenarioRunPlan } from "../apps/server/src/run-planner";

// "Ignore variables" mode: the planner inserts nothing for any input variable. It skips input
// resolution (pools, automatic tokens, server templates) and the required-input check, and persists
// ignore_variables on the run so the runner blanks every input() at run time.
function stateWithScenarios() {
  return AppStateSchema.parse({
    projects: [{ id: "proj_demo", name: "Demo" }],
    environments: [
      { id: "staging", project_id: "proj_demo", name: "staging", base_url: "https://example.com", is_default: true }
    ],
    scenarios: [
      {
        id: "needs-otp",
        project_id: "proj_demo",
        env_id: "staging",
        name: "Needs OTP",
        slug: "needs_otp",
        folder_path: "suite",
        created_by: "tester",
        created_at: "2026-01-01T00:00:00.000Z",
        package_path: "suite/needs-otp/package.zip",
        status: "active",
        // A 2fa_otp input with no otp_login is required and cannot be auto-filled.
        inputs: [{ name: "otp", type: OTP_2FA_INPUT_TYPE, description: "", otp_login: "" }]
      },
      {
        id: "has-input",
        project_id: "proj_demo",
        env_id: "staging",
        name: "Has Input",
        slug: "has_input",
        folder_path: "suite",
        created_by: "tester",
        created_at: "2026-01-01T00:00:00.000Z",
        package_path: "suite/has-input/package.zip",
        status: "active",
        inputs: [{ name: "user_name", type: STRING_INPUT_TYPE, description: "", otp_login: "" }]
      },
      {
        id: "mixed",
        project_id: "proj_demo",
        env_id: "staging",
        name: "Mixed",
        slug: "mixed",
        folder_path: "suite",
        created_by: "tester",
        created_at: "2026-01-01T00:00:00.000Z",
        package_path: "suite/mixed/package.zip",
        status: "active",
        // A required OTP plus a normal string input, to prove per-input skipping is selective.
        inputs: [
          { name: "user_name", type: STRING_INPUT_TYPE, description: "", otp_login: "" },
          { name: "otp", type: OTP_2FA_INPUT_TYPE, description: "", otp_login: "" }
        ]
      }
    ]
  });
}

describe("ignore_variables planning", () => {
  it("normally throws on a missing required input, but succeeds (with empty inputs) when ignoring", () => {
    const state = stateWithScenarios();
    const scenario = state.scenarios.find((item) => item.id === "needs-otp")!;

    // Without the flag and no OTP provided, the required-input check fires.
    expect(() => prepareScenarioRunPlan(state, scenario, {})).toThrow(/Missing required inputs/);

    // With the flag, planning succeeds and inserts nothing.
    const plan = prepareScenarioRunPlan(state, scenario, { ignore_variables: true });
    expect(plan.ignore_variables).toBe(true);
    expect(plan.run.ignore_variables).toBe(true);
    expect(plan.inputs).toEqual({});
    expect(plan.run.inputs).toEqual({});
    expect(plan.otp_secrets).toEqual({});
  });

  it("skips automatic input values too (a normal string input resolves to nothing)", () => {
    const state = stateWithScenarios();
    const scenario = state.scenarios.find((item) => item.id === "has-input")!;

    // Normally user_name gets an auto-generated value…
    const normal = prepareScenarioRunPlan(state, scenario, {});
    expect(normal.run.ignore_variables).toBe(false);
    expect(normal.inputs.user_name ?? "").not.toBe("");

    // …but with ignore_variables nothing is inserted.
    const ignored = prepareScenarioRunPlan(state, scenario, { ignore_variables: true });
    expect(ignored.inputs).toEqual({});
    expect(ignored.run.inputs).toEqual({});
  });

  it("carries ignore_variables onto every run of a folder/batch run", () => {
    const state = stateWithScenarios();
    const plans = prepareFolderRunPlans(
      state,
      "proj_demo",
      ["suite"],
      {},
      {},
      {},
      { ignore_variables: true }
    );
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((plan) => plan.ignore_variables && plan.run.ignore_variables)).toBe(true);
    expect(plans.every((plan) => Object.keys(plan.inputs).length === 0)).toBe(true);
  });

  it("skips only the named inputs — required check is bypassed for them, others still resolve", () => {
    const state = stateWithScenarios();
    const scenario = state.scenarios.find((item) => item.id === "mixed")!;

    // Without skipping, the required otp fails planning.
    expect(() => prepareScenarioRunPlan(state, scenario, {})).toThrow(/Missing required inputs/);

    // Skip just "otp": planning succeeds, user_name still resolves, otp is absent.
    const plan = prepareScenarioRunPlan(state, scenario, { ignored_inputs: ["otp"] });
    expect(plan.run.ignore_variables).toBe(false);
    expect(plan.run.ignored_inputs).toEqual(["otp"]);
    expect(plan.inputs.user_name ?? "").not.toBe("");
    expect("otp" in plan.inputs).toBe(false);
    expect("otp" in plan.run.inputs).toBe(false);
  });

  it("carries ignored_inputs onto every run of a folder/batch run", () => {
    const state = stateWithScenarios();
    const plans = prepareFolderRunPlans(state, "proj_demo", ["suite"], {}, {}, {}, { ignored_inputs: ["otp"] });
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((plan) => plan.run.ignored_inputs.includes("otp"))).toBe(true);
    // A scenario that has no "otp" input is unaffected and still resolves its own inputs.
    const hasInputPlan = plans.find((plan) => plan.scenario.id === "has-input");
    expect(hasInputPlan?.inputs.user_name ?? "").not.toBe("");
  });
});
