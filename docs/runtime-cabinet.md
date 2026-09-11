# Runtime Cabinet

This document describes the server-side "personal cabinet" (`/cabinet`) and every field used by admins, merchants, pools, pool items, run snapshots, fetch scenarios, and auto-import rules.

## Cabinet Login

The cabinet is intentionally separated from the public project/runs pages.

Fields:

- `cabinet_user.id`: stable local user id. The server creates five empty users by default: `cabinet_user_1` through `cabinet_user_5`.
- `cabinet_user.display_name`: UI label shown on the login page and logout button.
- `cabinet_user.created_at`: when the empty user was created.
- `cabinet_user.updated_at`: when the user record was last changed.
- `cabinet_user.last_login_at`: last time this profile entered the cabinet.

Behavior:

- Opening `/cabinet` without a valid `cabinet_user` cookie shows the cabinet login page.
- Login only selects one of the prepared empty profiles. No password is required in this local runtime.
- The selected user is stored in a `cabinet_user` cookie.
- `/cabinet/logout` clears the cookie.

## Admins

Admins are server accounts used to resolve server placeholders and OTP.

Fields:

- `login`: account login. Also used as `{server_username}` when this admin is selected directly or through a merchant.
- `password`: account password. Used as `{server_password}`.
- `2fa_otp`: TOTP secret for generating server-side OTP. Used as `{server_2faotp}`.
- `created_at`: creation timestamp.
- `updated_at`: last update timestamp.

Notes:

- Existing API names remain `/api/accounts` for backward compatibility.
- Merchant OTP is not stored on the merchant. A merchant links to an admin, and that admin supplies OTP.

## Merchants

Merchants describe business merchant presets used in scenario runs.

Fields:

- `name`: merchant code/name. Used as `{server_merchant}`.
- `admin_login`: optional linked admin login. If set, selecting this merchant fills `{server_username}`, `{server_password}`, and `{server_2faotp}` from that admin.
- `env_ids`: optional environment allow-list. Empty means the merchant can be used in any environment.
- `created_at`: creation timestamp.
- `updated_at`: last update timestamp.

## Pools

Pools are reusable runtime dictionaries. They can be filled manually, from run outputs, from fetch scenario outputs, or by auto-import rules.

Fields:

- `id`: stable pool id used by API and run snapshots.
- `name`: human-readable pool name.
- `kind`: pool category. Supported values:
  - `deposit_address`: addresses used for deposit flows.
  - `payout_address`: addresses used for payout flows.
  - `trace_id`: trace identifiers.
  - `custom`: any other reusable runtime value.
- `project_id`: optional project scope. `null` means all projects.
- `env_ids`: optional environment scope. Empty means all environments.
- `dedupe`: when true, the same `value` is not duplicated inside the pool.
- `allocation_strategy`: how `auto` selection chooses a value:
  - `manual`: user normally chooses a concrete item.
  - `first_enabled`: first enabled item by creation order.
  - `round_robin`: reserved for rotating usage; currently falls back to first enabled item.
  - `random`: random enabled item.
  - `template`: generate value from `template` instead of selecting a stored item.
- `template`: template for generated pool values. Common trace template: `{date}_{testName}_{seq}`.
- `fetch_scenario_id`: scenario id to run when clicking `Fetch info`.
- `fetch_input_name`: input name that receives pool items JSON. Default: `addresses_json`.
- `fetch_output_key`: output key read from the fetch scenario result. Default: `address_info`.
- `auto_import_enabled`: enables automatic pool import after successful runs.
- `auto_import_scenario_id`: optional scenario filter for auto import. Empty means any scenario.
- `auto_import_output_key`: output key to import into the pool.
- `auto_import_mode`: `whole` imports the whole value; `array_items` splits arrays into separate pool items.
- `auto_import_json_path`: optional simple JSON path for extracting nested values.
- `created_at`: creation timestamp.
- `updated_at`: last update timestamp.

## Pool Items

Pool items are the actual reusable values.

Fields:

- `id`: stable item id.
- `pool_id`: parent pool id.
- `value`: value passed into scenario inputs.
- `label`: optional user-facing label.
- `enabled`: disabled items remain stored but are not used by auto selection.
- `currency`: optional currency marker, for example `USDT`.
- `network`: optional network marker, for example `TRC20`.
- `metadata`: arbitrary JSON object with fetched or user-provided details.
- `source.type`: where the item came from:
  - `manual`: added in the cabinet or by API.
  - `run_output`: promoted/imported from a run output.
  - `fetch_scenario`: produced by a fetch scenario.
- `source.run_id`: source run id for run-derived items.
- `source.scenario_id`: source scenario id for run-derived items.
- `source.output_key`: output key used as the source.
- `created_at`: creation timestamp.
- `updated_at`: last update timestamp.
- `last_fetched_at`: when fetch metadata was last applied.
- `last_fetch_status`: last fetch status for this item.

## Run Snapshot

Every run stores the exact runtime values it used.

Fields:

- `pool_selections`: requested pool choices from the run form. Keys are scenario input names.
- `runtime_snapshot`: resolved values that must be reused by retry.
- `retry_of_run_id`: original run id when the run was created by retry.

Retry behavior:

- Retry copies the same inputs and `runtime_snapshot`.
- Trace ID is not regenerated on retry.
- Selected pool values are not reallocated on retry.
- If a pool item was deleted after the original run, retry still uses the saved snapshot/input value.

## Fetch Info

`Fetch info` runs a scenario created in the agent against all enabled items in a pool.

Flow:

1. Configure `fetch_scenario_id`, `fetch_input_name`, and `fetch_output_key` on the pool.
2. Click `Fetch info` in `/cabinet`.
3. Server queues the selected scenario.
4. The scenario receives enabled pool items as JSON in `fetch_input_name`.
5. When the scenario passes, server reads `fetch_output_key` from outputs.
6. Matching item metadata, `last_fetched_at`, and `last_fetch_status` are updated.

Scenario labels in the cabinet include breadcrumbs:

```text
project_id / folder / subfolder / scenario name
```

This applies to both `fetch_scenario_id` and `auto_import_scenario_id`, so service scenarios are distinguishable when multiple folders contain similarly named scenarios.

## Auto Import

Auto import fills pools from successful runs automatically.

Fields:

- `auto_import_enabled`: turns the rule on.
- `auto_import_scenario_id`: limits import to one scenario. Empty means every successful run can match.
- `auto_import_output_key`: output key to read.
- `auto_import_mode`: import whole output or split array outputs.
- `auto_import_json_path`: optional extraction path for nested objects.

Behavior:

- Only `passed` runs are auto-imported.
- Missing output keys are ignored.
- If `dedupe` is enabled on the pool, existing values are updated instead of duplicated.

## Main API Routes

- `GET /cabinet`: cabinet page or login page.
- `POST /cabinet/login`: select a cabinet user.
- `GET /cabinet/logout`: clear cabinet session.
- `GET /api/pools`: list pools.
- `POST /api/pools`: create or update a pool.
- `DELETE /api/pools/{pool_id}`: delete a pool and its items.
- `GET /api/pools/{pool_id}/items`: list pool items.
- `POST /api/pools/{pool_id}/items`: create or update an item.
- `PATCH /api/pools/{pool_id}/items/{item_id}`: update an item.
- `DELETE /api/pools/{pool_id}/items/{item_id}`: delete an item.
- `POST /api/pools/{pool_id}/fetch`: run the configured fetch scenario.
- `POST /api/pools/{pool_id}/import-run-outputs`: bulk import outputs from completed runs.
- `POST /api/runs/{run_id}/outputs/{output_key}/add-to-pool`: promote one run output into a pool.
