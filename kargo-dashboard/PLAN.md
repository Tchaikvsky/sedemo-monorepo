# Kargo Dashboard — Implementation Plan

Source of truth for intent: [README.md](README.md). This plan turns it into concrete, ordered work. Owner decisions are in section 11. Nothing is open. The one external dependency, the API token, is handled by the protocol in section 12. **Change request 1 (multiple warehouses per project) is planned in section 13 and supersedes 6.1 (including its "multiple warehouses" error), 6.7 and the frontend row layout where they disagree.** **Change requests 2 (live promotion status on cards) and 3 (multiple dashboards) are designed in sections 14–16, which revisit the data-fetching architecture; where they disagree with earlier sections, sections 14–16 win.** Where this plan and the README disagree, follow this plan and update the README in step 12.

## 1. Goal

A small Node.js web app that renders one row per configured Kargo project:

```
                 latest   dev      staging   prod
demo-rollouts    7-red    7-red    6-blue    5-green
sedemo-app-demo  1.4.0    1.4.0    1.3.2
team-eddie       3-x      2-y      1-z
```

- Column 1 is always the newest Freight version from the project's warehouse.
- The remaining cells are stages, in pipeline order, each showing the version currently deployed there.
- Each cell's color shows **version decay**: how many Freight versions that stage is behind the latest (Good / OK / Bad / Worse).

## 2. Tech choices

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS, ESM, no TypeScript build step (JSDoc types are fine) | "Lightweight"; uses the built-in `fetch`. |
| HTTP server | `express` (only runtime dependency) | Static files and a JSON route. `node:http` is also fine if you'd rather have zero deps. |
| Frontend | One `public/index.html` plus vanilla `app.js` and `style.css`, no framework | Matches the other apps in this monorepo (rollouts-app, active-active). |
| Kargo access | **Kargo REST API** (`/v1beta1/...`) authenticated with a **Kargo API token** (bearer). This is a decided requirement; don't add a kubeconfig path or use the old Connect-RPC API. | Works with Akuity-hosted Kargo. All network I/O stays in `src/kargo-client.js`. |
| Tests | `node:test` + `node:assert` | No extra deps. |
| Container | `node:22-alpine`, non-root | |

## 3. Directory layout

```
kargo-dashboard/
  README.md               (existing; update at the end)
  PLAN.md                 (this file)
  package.json
  config.example.json
  Dockerfile
  .dockerignore
  src/
    server.js             express app, routes, cache/refresh loop
    config.js             load and validate config.json, apply defaults
    kargo-client.js       thin Kargo API wrapper (the only module that does network I/O)
    stage-filter.js       include/exclude matching
    stage-order.js        build the stage graph and order it
    version.js            Freight -> "version" string
    decay.js              versions-behind count and color bucket
    summarize.js          joins it all into the view model
  public/
    index.html
    app.js
    style.css
  test/
    fixtures/             JSON captured from a real Kargo API (scrubbed)
    config.test.js
    kargo-client.test.js  (mocked fetch)
    stage-filter.test.js
    stage-order.test.js
    version.test.js
    decay.test.js
    summarize.test.js
```

## 4. Configuration (`config.json`)

Loaded from `CONFIG_PATH` (default `./config.json`). Secrets come from env vars, never from the file.

```jsonc
{
  "kargo": {
    "url": "https://kargo.akpdemoapps.link",          // env KARGO_URL overrides
    "tokenEnv": "KARGO_TOKEN"                          // name of the env var holding the API token (default KARGO_TOKEN)
  },
  "refreshIntervalSeconds": 30,
  "decay": {
    "thresholds": [                  // vs versions behind (6.6); ascending, first match wins
      { "max": 0,   "label": "Good",  "color": "#2e7d32" },
      { "max": 1,   "label": "OK",    "color": "#fdd835" },
      { "max": 3,   "label": "Bad",   "color": "#fb8c00" },
      { "max": null, "label": "Worse", "color": "#c62828" }   // null = no upper bound
    ]
  },
  "projects": {
    "demo-rollouts": {
      "displayName": "Rollouts Demo",          // optional, defaults to the key
      "warehouse": "demo-rollouts",            // optional if the project has exactly one warehouse
      "tokenEnv": "KARGO_TOKEN_DEMO_ROLLOUTS", // optional per-project token override (see section 5)
      "includeStages": [],                     // optional; e.g. ["dev", "regex:^prod-.*$"]
      "excludeStages": []                      // optional
    },
    "sedemo-app-demo": {
      "warehouse": "sedemo-app-demo"           // required: the project has 2 warehouses (see 6.1)
    }
  }
}
```

Validation in `config.js`, failing fast at startup with a clear message:
- `projects` must be a non-empty object. Each value must be an object, where `{}` is valid.
- Every stage pattern must be a string. If it starts with `regex:`, compile `new RegExp(rest)` at load time so bad regexes fail at startup.
- `thresholds`: non-negative integer `max` values in strictly ascending order. Only the last entry may be `null`, and it must be. If the block is omitted, default to Good/OK/Bad/Worse above.
- Every referenced token env var must be set and non-empty at startup. Never log token values.
- Project order in the UI is the key order in the file.

## 5. Kargo data access (`src/kargo-client.js`)

**Verified 2026-10-14** against `swagger.json` at Kargo tag `v1.12.1` (the infra repo pins `v1.12.1-ak.0`). Its source tree has **no Connect-RPC/proto service definitions**. The API is REST under `/v1beta1`, documented in `swagger.json` at the repo root (`gh api -H 'Accept: application/vnd.github.raw' 'repos/akuity/kargo/contents/swagger.json?ref=v1.12.1'`).

All requests are `GET {url}{path}` with `Authorization: Bearer <token>` and `Accept: application/json`. Calls per project per refresh:

| Purpose | Endpoint | Response |
|---|---|---|
| Warehouses | `GET /v1beta1/projects/{project}/warehouses` | `WarehouseList` (`.items[]`) |
| Stages | `GET /v1beta1/projects/{project}/stages?freightOrigins={warehouse}` | `StageList` (`.items[]`) |
| Freight | `GET /v1beta1/projects/{project}/freight?origins={warehouse}` | `{ groups: { <key>: { items: Freight[] } } }`. Without `groupBy` the group key isn't documented, so **flatten every group's `items`** and de-duplicate by `metadata.name`. |

Warehouses must be fetched first because the warehouse name is needed for the other two calls. Array query params: confirm against the live server whether they're repeated (`?origins=a&origins=b`) or comma-joined. Only one value is ever sent, so either works.

**Instance URL:** `https://kargo.akpdemoapps.link`. On 2026-10-14, unauthenticated `GET /v1beta1/projects` and `/v1beta1/projects/demo-rollouts/stages` returned `401 application/json`, which confirms the REST API is served there. The owner supplies the token (section 12).

**API token.** A Kargo API token is required. The dashboard is read-only, so the token's role only needs `get`/`list` on `stages`, `warehouses` and `freight` in each configured project. Kargo 1.12 has both:
- project-level tokens: `POST /v1beta1/projects/{project}/roles/{role}/api-tokens`
- system-level tokens: `POST /v1beta1/system/roles/{role}/api-tokens`

It's **unverified** whether a system-level role can read project resources. If it can't, each project needs its own token. That's why the token is resolved per project: `projects.<p>.tokenEnv` if set, otherwise the global `kargo.tokenEnv`. A `401`/`403` puts an error on that project's row ("token lacks access to project X") and does not crash the app. Step 12 documents the token-creation steps that actually worked, including the `kargo` CLI command if there is one.

**Live capture comes first.** Before writing this module, `curl` all three endpoints against the real instance for `demo-rollouts` and `sedemo-app-demo`. Save the scrubbed responses (no tokens, no hostnames) to `test/fixtures/<project>/{warehouses,stages,freight}.json`. All downstream code and tests work from these real shapes, not from this plan's description of them.

Fields relied on (Kargo v1alpha1, confirmed in v1.12.1 source):
- **Warehouse `spec.subscriptions[]`** is *raw JSON*. Each entry has an optional `name` plus **exactly one** other top-level key that names its type: `image` (`repoURL`), `chart` (`repoURL`, `name` — empty for OCI), `git` (`repoURL`), or any other key for a generic artifact subscription. Generic types are ignored by this app.
- **Freight:**
  - `metadata.name`, `metadata.creationTimestamp`, `discoveredAt`, `alias`, `origin.{kind,name}`
  - `images[].{repoURL,tag,digest,subscriptionName}`, `charts[].{repoURL,name,version,subscriptionName}`, `commits[].{repoURL,id,tag,subscriptionName}`
  - `status.currentlyIn.<stage>.since`
- **Stage:**
  - `spec.requestedFreight[]`, each with `origin.{kind,name}` and `sources.{direct:bool, stages:[]}`.
  - `spec.promotionTemplate.spec.steps`: empty or missing means a **control-flow stage**, which never holds Freight (see 6.4).
  - `status.freightHistory[0].items`: a map keyed **exactly** `"Warehouse/<warehouseName>"` (`FreightOrigin.String()` is `"%s/%s"` of Kind/Name). Each value is a FreightReference (`name`, `origin`, `images[]`, `charts[]`, `commits[]`). Index 0 is the currently deployed collection.

The client returns plain objects and does no business logic. It uses a 10s timeout per request (`AbortSignal.timeout`). Projects are fetched concurrently. One failing project must not fail the whole page: return `{ error }` for that row.

## 6. Core logic

### 6.1 Warehouse selection
- Use `project.warehouse` if it's set; error the row if no warehouse with that name exists.
- Otherwise, if the project has exactly one warehouse, use it.
- ~~If it has more than one, error the row with "multiple warehouses; set `warehouse` in config".~~ **Superseded by section 13 (D7):** with more than one warehouse and no key, every warehouse becomes a lane.

**Reference multi-warehouse case: `sedemo-app-demo`.** This is a templated-teams project (`sedemo-platform/templated-teams/kargo-chart`) with two warehouses:
- `<app>`: subscriptions `[image, git]`, with `freightCreationCriteria` tying the image revision to the commit. Its version is the image tag.
- `<app>-chart`: `[git]` only. If someone configures this one, the version is the short SHA.

Every stage requests Freight from **both** warehouses, so `status.freightHistory[0].items` holds two keys. Only the `"Warehouse/<configured>"` entry is used, and decay counts only that warehouse's Freight. The warehouse is assumed to be named `sedemo-app-demo` (chart convention: warehouse = `application.name`). Confirm this from the live capture and fix `config.example.json` if it's wrong.

### 6.2 Version string (`version.js`)
Owner-decided rule, which replaces the README's "first subscription" wording:

1. Walk `warehouse.spec.subscriptions` in order and pick the **first subscription that has an `image` or `chart` key**.
   - **Matching a Freight artifact to the subscription:** if the subscription has a top-level `name`, match the artifact's `subscriptionName === name`. Otherwise match by `repoURL`, plus chart `name` when the subscription sets one. For OCI charts, `name` is empty and the chart is identified by `repoURL` alone.
   - `image`: version = the matched image's `tag`.
   - `chart`: version = the matched chart's `version`.
2. **Only if the warehouse has no image or chart subscription:** use the first `git` subscription, and set version = the matching commit's `id.slice(0, 7)` (short SHA).
3. If the chosen subscription has no matching entry in the Freight (shouldn't happen), use `freight.alias` and log a warning.

Resolve the "version source" once per warehouse, then apply it to each Freight. Return `{ version, freightName, alias }`. The UI shows `version`, with `alias` and `freightName` in a tooltip.

Tests: image-first; git-then-image (picks the image); chart-only; git-only (short SHA); image and chart (picks whichever is listed first); OCI chart with an empty `name`; two image subscriptions with the same repoURL but different `name`s (matched by `subscriptionName`); a generic (non-image/chart/git) subscription listed first (skipped).

### 6.3 Stage filtering (`stage-filter.js`), per the README
1. Start with the stages that request freight from the selected warehouse. Other stages are ignored.
2. If `includeStages` is set and non-empty, keep only stages matching any include pattern. Otherwise keep all.
3. Remove stages matching any exclude pattern.

Matching: `regex:<re>` means `re.test(name)` (unanchored, so authors add `^$`). Anything else is exact `===` equality.

### 6.4 Stage ordering (`stage-order.js`)
Build a DAG over **all** stages for the warehouse, before filtering:
- Edge `U → S` for every `U` in `S.spec.requestedFreight[origin == warehouse].sources.stages`.
- `sources.direct: true` makes `S` a root.

Ordering:
1. Compute `depth(S)` = longest path from any root. Using all stages here keeps depth stable when intermediate stages are filtered out.
2. Sort by `(depth asc, name asc)`. Siblings at the same depth, such as `prod-east` and `prod-west`, sit next to each other alphabetically.
3. Then apply the filter from 6.3 and keep the relative order.
4. Cycles shouldn't exist in Kargo. If one is detected, log a warning and fall back to name order for that project.
5. **Control-flow stages** (no `promotionTemplate.spec.steps`) stay in the DAG so depth is correct, but they are **not rendered** as cells, because they never hold Freight. This mirrors Kargo's `Stage.IsControlFlow()`. `apps/demo-ephemeral` in sedemo-platform probably has some.

Unit tests should cover: linear `dev→staging→prod`; fan-out `dev→{east,west}`; fan-in; an intermediate stage excluded; a stage with no upstream that isn't `direct` (treat as root, depth 0); a control-flow stage in the middle (hidden, downstream depth unchanged).

### 6.5 Latest freight
Take the newest Freight with `origin.name == warehouse`, ordered as defined in 6.6. That fills column 1. If the warehouse has **no Freight at all**, column 1 shows "—" and every stage cell is neutral gray with the label "no freight". This is the only case where stage cells skip the decay colors.

### 6.6 Version decay (`decay.js`)
README definition: decay is how far out of date a stage is, measured as the **count of Freight between the latest Freight and the Freight currently deployed** to that stage.

- Let `F_all` be the warehouse's Freight, sorted newest-first by `discoveredAt` (falling back to `metadata.creationTimestamp`), with ties broken by `metadata.name`. This matches Kargo's own `first_seen` ordering.
- For a stage currently on Freight `C`, **versions behind** = the index of `C` in `F_all`. That is the number of Freight created after `C`, so it is 0 when the stage is on the latest.
- Map it to the first threshold whose `max` is ≥ the value (`null` matches everything). Defaults from the README:

  | Versions behind | Label | 
  |---|---|
  | 0 | Good (up to date) |
  | 1 | OK |
  | 2–3 | Bad |
  | 4+ | Worse |

  Exactly 3 behind is **Bad** (owner-confirmed 2026-10-14). Step 12 corrects the README to say Bad is 2–3 (`>1 and ≤3`) and Worse is `>3`.
- A stage with no Freight yet, or whose current Freight is no longer in `F_all` (garbage-collected), is shown as **Worse** with the label "unknown".
- The tooltip shows "N versions behind latest".
- The latest-Freight column has no decay. Give it its own neutral style.

Note that Kargo only keeps a limited Freight history. If the count is capped by retention, it still lands in Worse, which is fine.

**Freight versus versions:** the README counts Freight objects, so this does too. A warehouse with git and image subscriptions and no `freightCreationCriteria` can create Freight that only changes the commit. A stage can then show the same version string as `latest` and still be "1 behind". That is expected behavior; don't de-duplicate by version.

Tests: 0, 1, 2, 3, 4 and 10 behind; a stage with no Freight; garbage-collected Freight; custom thresholds; equal timestamps.

### 6.7 View model (`summarize.js`)

> **Superseded by 13.5.** The project row now carries `lanes[]` (one per warehouse); the single-warehouse shape below is the content of one lane.

```json
{
  "generatedAt": "2026-10-14T18:00:00Z",
  "rows": [
    {
      "project": "demo-rollouts",
      "displayName": "Rollouts Demo",
      "warehouse": "demo-rollouts",
      "latest": { "version": "7-red", "alias": "...", "createdAt": "..." },
      "stages": [
        { "name": "dev", "version": "7-red", "alias": "...", "freightName": "...", "since": "...", "decay": { "behind": 0, "color": "#2e7d32", "label": "Good" } }
      ],
      "error": null
    }
  ]
}
```

## 7. Server (`server.js`)
- On boot, load the config and start a refresh loop every `refreshIntervalSeconds`. Store the last good summary in memory. If a refresh fails, keep serving the previous rows and attach the new `error`.
- `GET /api/summary` returns the cached view model.
- `GET /healthz` returns 200 once the first refresh has completed. Before that it returns 503.
- `GET /` serves the files in `public/`.
- `PORT` env var, default 8080.
- Log with `console`, one line per refresh with its timing.

## 8. Frontend (`public/`)

> **Layout superseded by section 13:** a project is one row with its label once on the left and one lane per warehouse; a lane is the `[latest][cells…]` strip described below.
- Poll `/api/summary` every `refreshIntervalSeconds`. The server can expose that in the payload.
- Use a CSS grid where each row is `[project label][latest][stage cells…]`, so rows can have different lengths per the README.
- **The visual is agnostic to stage names.** There are no stage-name column headers and no alignment across rows by name. Each row's cells are left-packed in that project's pipeline order (section 6.4), so rows differ in length and naming freely. Show the stage name as a small caption inside its cell, purely as a label. Nothing in layout or styling may depend on it.
- The color legend comes from `decay.thresholds`.
- Tooltip on each cell: freight alias, freight name, "N versions behind latest", and deployed-since (`freight.status.currentlyIn[stage].since`, omitted if absent).
- A row with `error` shows the project name and the error message in a muted style.
- Dark/light via `prefers-color-scheme`. Keep text readable on every threshold color by picking black or white text from luminance.

## 9. Packaging
- `Dockerfile`: multi-stage `node:22-alpine`. `npm ci --omit=dev`, copy `src` and `public`, `USER node`, `EXPOSE 8080`, `CMD ["node","src/server.js"]`. Config is mounted at `/app/config.json`.
- `.github/workflows/publish-kargo-dashboard.yml` at the repo root: copy `publish-rollouts-app.yml`, but trigger on `kargo-dashboard/**`, use image `ghcr.io/akuity/sedemo-monorepo-kargo-dashboard`, use tags `latest` and `${{ github.run_number }}`, and **drop** the color step, the `COLOR` build-arg and the "Tag release in git" step. Keep multi-arch, OCI labels and attestation.
- Out of scope for this pass: Helm chart and Argo CD app in `sedemo-platform`. Note it as follow-up work, with the token in a Secret and the config in a ConfigMap.

## 10. Execution order (for the coding agent)

1. Scaffold `package.json` (`"type": "module"`, scripts `start` and `test`), `config.example.json`, and `.gitignore` covering `config.json` and `node_modules`.
2. `config.js` with tests.
3. `stage-filter.js` with tests.
4. `stage-order.js` with tests (cases from 6.4).
5. `version.js` with tests.
6. `decay.js` with tests.
7. `kargo-client.js`: verify the RPC names first (section 5) and capture fixtures.
8. `summarize.js` with a fixture-driven test that builds a full row from captured JSON.
9. `server.js` with the refresh loop.
10. Frontend.
11. Dockerfile and GH workflow.
12. Update `README.md`:
    - Remove the "Kargo projects must use consistent Stage names" requirement.
    - Replace the "Version" requirement with the rule in 6.2.
    - Under "Version Decay", change Bad to "≥2 and ≤3" (3 behind is Bad), note that thresholds are configurable, and fix "frieght".
    - Add run instructions (`KARGO_URL`, `KARGO_TOKEN`, per-project token env vars, `CONFIG_PATH`, `npm start`), how to create a read-only Kargo API token, and the config reference.
    - Fix the typos ("visuallizing", "dependecnies", "indivudal", "many have", "Promption", "freigth", "subsriptions", "configurtaion").


## 10a. Ground rules and acceptance (how the work is judged)

**Scope:** create or modify files only under `kargo-dashboard/`, plus `.github/workflows/publish-kargo-dashboard.yml`. Work on branch `feat/kargo-dashboard`. Commit at logical checkpoints. **Do not push or open a PR** unless the owner says to.

**Rules:**
- No secrets in the repo. `config.json` is gitignored, and fixtures are scrubbed of tokens and hostnames.
- When reality contradicts this plan (an API shape, a field name), follow reality, then record it under "Deviations" in the report. Don't silently work around it.
- Don't add dependencies beyond `express` without listing the reason in the report.

**Acceptance criteria.** All must hold:
1. `npm test` passes, with tests for every module in section 3 and every case listed in 6.2, 6.4 and 6.6.
2. `summarize.test.js` runs on **real captured fixtures** for `demo-rollouts` and `sedemo-app-demo`, not hand-written ones.
3. `npm start` against `https://kargo.akpdemoapps.link` renders both projects. For each one, the stage order, the version per stage and the "behind" count match what the Kargo UI shows at the same moment.
4. A project configured with a bad token or a nonexistent warehouse shows an error row, and the others still render. *(The original check that removing `warehouse` from `sedemo-app-demo` gives a "multiple warehouses" error is superseded by section 13 D7: it now renders both warehouses as lanes.)*
5. `docker build` succeeds, and the container serves `/healthz` → 200 with a mounted config.
6. The README has been updated per step 12.

**Required report** (final message):
- `npm test` output, a summary is fine
- the fixture file list
- a screenshot or HTML capture of the rendered page
- for acceptance 3, a table per project: stage | dashboard version | Kargo UI version | behind
- the token type used (project or system) and the exact creation steps that worked
- a "Deviations" list with reasons
- anything left undone

## 11. Resolved decisions (owner, 2026-10-14)
1. **Decay:** count of Freight between the latest and the deployed version, colored Good/OK/Bad/Worse (6.6). Exactly 3 behind is Bad.
5. **API surface:** Kargo v1.12 REST `/v1beta1` (verified; replaces the earlier Connect-RPC assumption).
6. **Live instance:** `https://kargo.akpdemoapps.link`.
7. **Reference projects:** `demo-rollouts` (one warehouse) and `sedemo-app-demo` (two warehouses).
2. **Stage names:** the visual is agnostic to them. Rows are left-packed by pipeline order, and the "consistent Stage names" requirement is dropped.
3. **Kargo access:** use the Kargo API with an API token.
4. **Version source:** use the first `image` or `chart` subscription. Fall back to the short SHA of the first `git` subscription only when the warehouse has neither.

## 12. API token protocol
The owner provides a token when live validation starts. The token is never written to any file, fixture, log or commit.

1. Steps 1–6 (config, filter, order, version and decay logic) need no token. Build them first using hand-written test data shaped from section 5.
2. Before step 7, **stop and ask the owner for the token**. Request read access to `demo-rollouts` and `sedemo-app-demo`, and say whether a system-level or a per-project token is needed. Ask for one system-level token first. If it gets `403` on project endpoints, ask for per-project tokens and use `projects.<p>.tokenEnv`.
3. The token is passed only as an env var (`KARGO_TOKEN` or the per-project vars) in the agent's shell.
4. Before committing, grep the working tree and fixtures for the token value and for `Bearer`. The report must state that this check was done.

## 13. Change request: `warehouses` (plural) renders one lane per warehouse

Requested 2026-10-14. Status: **implemented 2026-10-14** (see the report in the session; one deviation noted below). Decision D7 is confirmed by the owner (no key means all warehouses become lanes); the other defaults in 13.4 stand unless the owner says otherwise.

### 13.1 Requirement
A project config may give `warehouses` (a list) instead of `warehouse` (singular). Each listed warehouse becomes **its own lane (sub-row)** inside the project's one larger row. The project name stays once, on the left, and links to the project.

```
Project          Lane (warehouse)    latest   cells (that warehouse's pipeline, left to right)
┌──────────────┬──────────────────┬────────┬─────────────────────────────────┐
│ team-ada     │ akkoma-main      │ 1.4.2  │ dev 1.4.2   release 1.4.0       │
│              ├──────────────────┼────────┼─────────────────────────────────┤
│              │ akkoma-release   │ 2.0.1  │ staging 2.0.1   prod 1.9.9      │
├──────────────┼──────────────────┼────────┼─────────────────────────────────┤
│ demo-rollouts│                  │ 50-blue│ dev  staging  prod  ...         │   ← singular `warehouse`: unchanged, no lane caption
└──────────────┴──────────────────┴────────┴─────────────────────────────────┘
```

### 13.2 Live facts that shape the design (captured 2026-10-14)
- `config.json` already contains `team-ada` with `warehouses: ["akkoma-main", "akkoma-release"]`. Today that key is **silently ignored**, so the project errors with "multiple warehouses; set `warehouse` in config". It is the ready-made live test case.
- `team-ada` has two warehouses with **disjoint pipelines**: `akkoma-main` feeds `dev` then `release`; `akkoma-release` feeds `staging` then `prod`. Each stage requests Freight from exactly one warehouse here, so the lanes show different stages.
- `sedemo-app-demo` is the opposite case: every stage requests both warehouses, so both lanes show the **same stage names** with different versions and decay. Fixtures for it already exist in `test/fixtures/sedemo-app-demo/`.
- `gatekeeper-stage: {}` and `demo-snow: {}` each have a single warehouse, so omitting the key keeps working (one lane, no caption). A project with several warehouses and no key now shows all of them (D7).
- All of this works with the data we already fetch. A stage's deployed Freight is keyed per warehouse (`status.freightHistory[0].items["Warehouse/<name>"]`), and `buildRow` already picks the entry for one warehouse, so decay and version logic are **already per-warehouse**.

### 13.3 Impact assessment

| Area | Impact | What changes |
|---|---|---|
| `stage-filter.js`, `stage-order.js`, `version.js`, `decay.js` | **None** | Already parameterised by a single warehouse. Reused once per lane. |
| `config.js` | Small | Accept `warehouses`. Reject both `warehouse` and `warehouses` set, an empty list, non-strings, duplicates. Normalise to `projects.<p>.warehouses: string[]` (`[]` meaning "unspecified: use every warehouse the project has", `[x]` for singular) plus a flag recording whether the plural form was used. |
| `kargo-client.js` | Small | `listStages` stops filtering by warehouse: one unfiltered `GET .../stages` per project (verified earlier to return all stages; `orderStages` already filters by warehouse). `listFreight` is still called **once per lane**. Calls per project: 1 warehouses + 1 stages + N freight, down from 1 + 2N. |
| `summarize.js` | **Main work** | `selectWarehouse` becomes `selectWarehouses` (returns the chosen list; with nothing configured it returns **all** the project's warehouses, replacing the old "multiple warehouses" error). `summarizeProject` builds one **lane** per warehouse and assembles them into the row. Errors are isolated per lane (13.4 D3). |
| View model (`/api/summary`) | **Breaking shape change** | Row gets `lanes[]`. See 13.5. The only consumer is the bundled page, so there is no external compatibility concern, but 6.7 must be updated. |
| `public/app.js`, `style.css` | Medium | Row becomes a project label spanning N lanes. Lane caption shown only when the row has more than one lane. |
| Tests | Medium | New cases below. Existing summarize tests assert on `row.latest` / `row.stages`, so they move to `row.lanes[0]`. |
| Docs/config | Small | `README.md` config reference, `config.example.json`, `deploy/chart/values.yaml` (switch `sedemo-app-demo` to a two-lane example), PLAN 6.1/6.7/8. |
| API load | Lower | Fewer calls per project than today. |
| Risk | Low to medium | Mostly the UI layout and the changed view-model shape. No change to the Kargo API surface already verified. |

### 13.4 Decisions (D7 owner-confirmed; the rest are recommended defaults)
- **D1 Config shape.** `warehouses: ["a", "b"]`, a plain list of names whose order is the lane order. `warehouse` (singular) keeps working exactly as before. Setting both is a config error at startup. *Alternative not recommended now:* objects with per-lane options (`{name, displayName}`). Add later if needed.
- **D2 Uniform view model.** Always emit `lanes[]`. A singular `warehouse` becomes one lane, and the UI shows no lane caption when there is only one lane, so existing rows look identical.
- **D3 Error isolation.** Project-level failures (token, project fetch, no warehouses listed) stay a single error row. A **lane-level** failure (a listed warehouse doesn't exist, or its Freight fetch fails) shows an error inside that lane while the other lanes render.
- **D4 Filters.** `includeStages` / `excludeStages` apply to **every lane** (one set per project, as now). No per-lane filters.
- **D5 Same stage in several lanes** appears in each lane, showing that lane's warehouse's Freight, version and decay. A stage that has never received Freight from a lane's warehouse is Worse / "unknown" in that lane (existing behavior).
- **D6 Links.** Project label links to the project. Cells link as today. Lane caption is plain text because the owner has not given a warehouse URL pattern.
- **D7 No key given (owner decision, 2026-10-14).** If a project config names neither `warehouse` nor `warehouses`, **every warehouse the project has becomes a lane**, in the order Kargo lists them, sorted by name so the order is stable between refreshes. This replaces the previous "multiple warehouses; set `warehouse` in config" error, so `selectWarehouse`'s multiple-warehouses error and its test are removed. A project with exactly one warehouse is unchanged (one lane, no caption). A project with zero warehouses is still a project-level error ("project has no warehouses").

### 13.5 View model (replaces 6.7 for the project row)

```json
{
  "project": "team-ada",
  "displayName": "team-ada",
  "projectUrl": "https://.../project/team-ada",
  "lanes": [
    {
      "warehouse": "akkoma-main",
      "latest": { "version": "...", "freightName": "...", "freightUrl": "...", "createdAt": "..." },
      "stages": [ { "name": "dev", "stageUrl": "...", "freightUrl": "...", "version": "...", "decay": { "behind": 0, "color": "#...", "label": "Good" } } ],
      "error": null
    }
  ],
  "showLaneCaptions": true,
  "error": null
}
```

`showLaneCaptions` is true when the plural `warehouses` form was given (even with one entry, honoring the explicit choice) **or** when the project resolved to more than one lane (including the no-key case). It is false for the singular `warehouse` form and for a no-key project with exactly one warehouse. Project-level `error` replaces all lanes. A project error row has `lanes: []`.

### 13.6 Implementation steps (for the coding agent, in order)
1. **config.js + tests:** parse and validate `warehouses` per 13.4 D1. Tests: valid list, both keys set, empty list, non-string entry, duplicate entries, singular unchanged, normalised output.
2. **kargo-client.js + tests:** `listStages(project, token)` unfiltered. Update the mocked-fetch test for the new URL (`.../stages` with no query). Re-verify live that unfiltered stages for `team-ada` returns all four stages.
3. **summarize.js + tests:**
   - `selectWarehouses(available, configured[])`: preserves config order, per-name "not found" errors become lane errors, and the no-key case returns all available warehouses sorted by name (D7). Zero available is a project-level error.
   - `buildLane(...)`: the current `buildRow` body, returning `{ warehouse, latest, stages, error }`. Keep `buildRow` as the project-level assembler.
   - Tests (use the real fixtures): `sedemo-app-demo` with both warehouses gives two lanes with the same stage names and different versions and decay (`15`/Good vs `8e87771`/staging 5 behind); a missing warehouse among valid ones gives one lane error and one good lane; a freight-fetch failure for one lane does not affect the other; a singular `warehouse` gives exactly one lane with `showLaneCaptions: false`; **no key on a two-warehouse project (`sedemo-app-demo`) gives two lanes sorted by name with captions; no key on a one-warehouse project gives one lane with no caption; no key on a project with zero warehouses is a project-level error**; link fields still present in every lane.
   - Add a small synthetic `team-ada` style fixture (disjoint pipelines) captured live, scrubbed the same way as the others, to `test/fixtures/team-ada/`.
4. **Frontend:** project label cell spans all lanes (CSS grid with a left label column and a stack of lane grids, or `grid-row: span N`). Each lane is the existing `[latest][cells…]` strip, with a small warehouse caption on the left of the lane when `showLaneCaptions`. Lane error renders as the muted message inside that lane. Keep the dark/light themes, the horizontal scroll inside the lane, and a phone-width layout with no page-level horizontal scroll.
5. **Docs/config:** README (config reference and example), `config.example.json`, `deploy/chart/values.yaml`, and the PLAN sections noted in 13.3.
6. **Live verification** with the owner's `config.json` and token: render `team-ada` (two lanes, disjoint stages), `sedemo-app-demo` as `warehouses: [sedemo-app-demo, sedemo-app-demo-chart]` and again with **no key at all** (both must give the same two lanes), and one singular project (unchanged look). Take screenshots at about 1100px and about 390px wide.

### 13.7 Acceptance criteria (all must hold)
1. `npm test` passes, with the new cases above, and the previously passing tests still pass (updated only for the `lanes` shape).
2. `team-ada` renders two lanes under one project label: `akkoma-main` shows `dev` and `release`; `akkoma-release` shows `staging` and `prod`. Versions and "behind" counts match an independent API read (the same cross-check method used for the original build).
3. `sedemo-app-demo` with both warehouses listed shows two lanes with identical stage names and the chart lane's 5-behind / unknown results from before. With **neither key set** it renders the same two lanes, and the old "multiple warehouses" error no longer appears anywhere (code, tests, README).
4. Singular-`warehouse` projects render exactly as before, with no lane captions.
5. Both keys set fails at startup with a clear message. One bad warehouse name produces a lane error only.
6. The project name links to the project page, on error rows too.
7. No token or hostname appears in any new fixture, and `git grep` for the token value is clean.

**Required report:** test summary; the `team-ada` and `sedemo-app-demo` live results in a table (lane, stage, dashboard version, API version, behind); screenshots at both widths; any deviation from 13.4 with the reason. Do not change architecture beyond what 13.3 lists; raise anything else with the owner first.

### 13.8 Implementation notes (2026-10-14)
- Done per 13.6 steps 1-4 and 6; step 5 covered the README, `config.example.json` and the PLAN markers.
- **Deviation:** `deploy/chart/values.yaml` was left untouched. The owner had already added the plural form (`team-ada`) and several no-key projects there, which work under the new rules, so no edit was needed.
- Phone-width caveat: captioned lanes show the latest cell and the first stage cell before the lane scrolls sideways. The page itself does not overflow.


---

# Change requests 2 and 3 (designed 2026-10-15, not implemented)

Sections 14–16 are the build instructions. Section 14 is the live promotion status on cards (CR2). Section 15 is multiple dashboards (CR3). Section 16 is the shared architecture change both need, plus execution order, acceptance criteria and the report. Decisions marked **(owner confirmed 2026-10-15)** have a recommended default the agent implements unless the owner says otherwise.

## 14. CR2: live promotion status on stage cards

### 14.1 Requirement (owner, 2026-10-15)
- Each stage card checks whether a promotion is in progress.
- While one is active, the card switches to a configured color (default blue), plays a gentle heartbeat (pulse) effect, and summarizes the step it's on, e.g. `5 of 7: helm-template`.
- Some promotions wait for a person (approval, a PR merge, a ticket, a form). Those steps are recognized by `wait-for` in the step name, **plus the `get-user-input` step** (owner amendment, 2026-10-15). The card must clearly show that the promotion is **waiting for interaction**.

### 14.2 Kargo facts (verified 2026-10-15 against v1.12.1 source, the API spec, and live Promotions)
- **Running promotions are free to detect.** `Stage.status.currentPromotion` is documented as "a reference to the currently Running promotion". We already fetch every stage, so detection costs no extra calls. It is a `PromotionReference`: `{ name, freight, status, finishedAt }`. On a completed reference, `status` carried `phase`, `currentStep`, `stepExecutionMetadata[]` (each `{ alias, status, message, startedAt, finishedAt }`), `freight` and `freightCollection`. **It does not carry the step list**, so the step type and the total count need the Promotion itself.
- **Promotion objects:** `GET /v1beta1/projects/{project}/promotions/{name}`. There is also `GET .../promotions?stage=<stage>` (lists the ~20 retained Promotions for a stage, heavy).
  - `spec.steps[]` is **already expanded**: PromotionTask steps are inlined with aliases such as `task-1::step-1` and `push-manifests::wait-for-pr`. So `spec.steps.length` is the true total.
  - Each step has `uses` (the step type, e.g. `helm-template`) and `as` (the alias).
  - `status.currentStep` is a **0-based index** into `spec.steps`. A succeeded 22-step Promotion reported `currentStep: 21`.
  - Conditional steps that didn't run show `status: Skipped` but still count toward the total.
- **Phases:** `Pending` (queued; per-stage queue ordered by creation time), `Running`, `Succeeded`, `Failed`, `Errored`, `Aborted`. A step waiting on people keeps the Promotion **Running** (documented for `wait-for-approval`).
- **Waiting steps in Kargo v1.12.1:**
  - `wait-for-approval` (Akuity Platform v1.12.0+, beta: "pauses a promotion until the required number of users approve, or one rejects");
  - `get-user-input` (Akuity Platform v1.12.0+: "pauses a promotion and waits for a user to submit input through a form in the Kargo UI", defined by a JSON schema);
  - `git-wait-for-pr`, `gh-wait-for-issue-state`, `gha-wait-for-workflow` and `snow-wait-for-condition`.

  **Only `wait-for-approval` starts with `wait-for`.** Four others contain it mid-name (this repo's own pipelines use `git-wait-for-pr` and `snow-wait-for-condition`), and `get-user-input` doesn't contain it at all.
- **`PromotionRequest`** (and `Stage.status.currentPromotionRequest`) is Kargo Enterprise fan-out of Freight to Targets. It is **not** an approval queue and is out of scope.
- No promotion was running at capture time, so the in-flight shape of `currentPromotion.status` has not been observed live (see 14.8).

### 14.3 Decisions
- **P1 What counts as active.** A card is "promoting" when its stage has `status.currentPromotion` set and its `status.phase` is absent, `Running` or `Pending`. **Queued (`Pending`) Promotions behind another, or held by a closed promotion window, are out of scope for this change.** Detecting them needs the heavy per-stage Promotions list on every refresh. *(owner confirmed 2026-10-15)*
- **P2 Waiting detection.** A step is "waiting for interaction" when its `uses` matches the configured regex `promotion.waitingStepPattern`, **default `wait-for|^get-user-input$`**. `wait-for` matches anywhere, so it catches all five `wait-for` steps; `get-user-input` is matched exactly (owner amendment, 2026-10-15). A rule of "starts with `wait-for`" (`^wait-for`) would catch only `wait-for-approval`, missing the PR and ServiceNow waits this repo uses. Changing it is one config value. *(owner confirmed: contains `wait-for`, plus `get-user-input`)*
- **P3 Step label.** `"{N} of {M}: {uses}"` with `N = currentStep + 1` (clamped to `1..M`), `M = spec.steps.length`, and the step **type** (`uses`) as the label, matching the owner's example. The alias (e.g. `push-manifests::wait-for-pr`) and the current step's `stepExecutionMetadata.message`, if any, go in the tooltip.
- **P4 Waiting look.** A waiting card uses a separate color, `promotion.waitingColor`, **default purple `#7b1fa2`**. It is distinct from blue and from all four decay colors. The status line reads `Waiting for input · {N} of {M}: {uses}`, prefixed with ⏸ so the meaning doesn't rely on color alone. *(owner confirmed 2026-10-15)*
- **P5 Card content while promoting.**
  - Stage name (link unchanged).
  - Version shows `current → target`, e.g. `50-blue → 51-blue`. The target is the version of `currentPromotion.freight` (same version rule as 6.2), and each version links to its own Freight.
  - The status line is replaced by the promotion summary (P3 or P4).
  - The decay label moves into the tooltip.
- **P6 Motion.**
  - **Running:** a gentle heartbeat. Opacity and glow pulse from `1 → 0.82 → 1` with a soft outer `box-shadow` in the promotion color, `1.6s ease-in-out infinite`.
  - **Waiting:** a slower "breathing" pulse (`3s`) to read as "paused, needs you" rather than "busy".
  - Under `prefers-reduced-motion: reduce` there is no animation; the color, the ⏸/● marker and the text carry the state.
  - `promotion.animate: false` disables motion globally.
  - No flashing faster than once per second (photosensitivity).
- **P7 Faster refresh while something is promoting.** A 30s poll is too slow to watch steps advance. When any configured stage has a running promotion, the server refreshes every `promotion.activeRefreshIntervalSeconds` (**default 5**). Otherwise it uses `refreshIntervalSeconds`. The API payload reports the interval in effect so the page polls at the same rate.
- **P8 Promotion links.** The owner has given URL patterns for projects, stages and Freight but **not for promotions**, so the promotion summary is not linked. The stage link already leads to the stage, where Kargo shows the promotion. *(owner confirmed 2026-10-15; a pattern can be added later)*
- **P9 Legend.** Add `● Promoting` (promotion color) and `⏸ Waiting for input` (waiting color) to the legend.

### 14.4 Configuration (new top-level block, all optional)
```jsonc
"promotion": {
  "color": "#1e6fd9",                  // running promotion card color
  "waitingColor": "#7b1fa2",           // card color while the current step is a waiting step
  "waitingStepPattern": "wait-for|^get-user-input$",  // regex tested against the current step's `uses`; compiled at startup
  "animate": true,
  "activeRefreshIntervalSeconds": 5    // integer >= 1, <= refreshIntervalSeconds
}
```
Validation follows section 4 style: fail fast. Colors must be `#rrggbb`. The pattern must compile.

### 14.5 Data flow
1. The stages call (already made) yields `currentPromotion` per stage.
2. For each stage with an active `currentPromotion`, the collector (section 16) needs that Promotion's `spec.steps`.
   - `GET /v1beta1/projects/{project}/promotions/{name}` is fetched **once per Promotion name** and the step list is cached; `spec.steps` never changes for a given Promotion.
   - Live progress (`currentStep`, `phase`, per-step metadata) is read from the stage's `currentPromotion.status` on every refresh.
   - If that status lacks `currentStep`, fall back to the fetched Promotion's `status` and re-fetch it each refresh while active.
   - Evict cache entries whose Promotion is no longer current anywhere.
3. A promotion fetch failure must not break the card. Show `Promoting…` without step detail, and log a warning with no token in it.

### 14.6 View model addition (per stage cell)
```jsonc
"promotion": null | {
  "name": "dev.01j…",              // Promotion name, for the tooltip
  "phase": "Running",
  "step": 5, "steps": 7,           // 1-based; steps = spec.steps.length (null if unknown)
  "uses": "helm-template",          // null if unknown
  "alias": "step-4",
  "waiting": false,
  "message": null,                  // current step's stepExecutionMetadata message, if any
  "targetVersion": "51-blue", "targetFreightName": "…", "targetFreightUrl": "…",
  "startedAt": "…"
}
```
The payload also carries `promotionStyle: { color, waitingColor, animate }` for the legend and the CSS variables, and `refreshIntervalSeconds` (the interval currently in effect).

### 14.7 Modules
- **New pure module `src/promotion.js`:** `promotionState(stage, promotionSteps, cfg, versionSource)` returns the 14.6 object or `null`. It handles step clamping, waiting detection, missing step lists, and target-version resolution (reusing `versionFor`).
- **`kargo-client.js`:** add `getPromotion(project, name, token)`.
- **`summarize.js`:** a cell gets `promotion` from `promotionState`.
- **Frontend:**
  - cell class `promoting` or `promoting waiting`;
  - CSS variables `--promo` and `--promo-wait` set from the payload;
  - `@keyframes heartbeat` and `breathe` animations, with the reduced-motion override;
  - text color chosen by the existing luminance helper;
  - the legend entries from P9.

### 14.8 Tests and live verification
- **Unit tests (`promotion.test.js`) use real shapes.** Capture one live Promotion with an approval or PR wait step (e.g. a completed `demo-snow` `prod` Promotion: 22 steps ending in `snow-wait-for-condition`) and scrub it into `test/fixtures/promotions/`. Derive "running" variants from it by setting `currentStep` and `phase`. Cases:
  - mid-run (`5 of 22: helm-template`);
  - on `snow-wait-for-condition` (waiting, with the default pattern);
  - the same step with pattern `^wait-for` (not waiting);
  - `wait-for-approval` (waiting, synthetic step);
  - `get-user-input` (waiting, synthetic step), and a look-alike such as `get-user-input-extra` (**not** waiting, since the match is exact);
  - `currentStep` past the end (clamped);
  - steps unknown because the fetch failed (`Promoting…`);
  - no `currentPromotion` (`null`);
  - a terminal phase on a stale reference (`null`);
  - the target version resolved through a chart-first warehouse.
- **Collector tests:** each Promotion fetched once across two refreshes, evicted once no longer current, and a fetch failure isolated to that one card.
- **Frontend:** the DOM shows classes and text for both states, the animation is suppressed under reduced motion (checked with an emulated media feature), and the legend has the two new entries.
- **Live (needs the owner):** no promotion was running at design time, and the dashboard's token is read-only. At verification time **the agent asks the owner to start promotions**: one ordinary run (e.g. `demo-rollouts` → `dev`) and one that waits (e.g. `demo-snow` → `prod`, which blocks on `snow-wait-for-condition`). The agent records the observed in-flight `currentPromotion.status` shape. If it differs from 14.2, the agent follows reality and reports the deviation. The agent must never promote, approve or abort anything itself.

## 15. CR3: multiple dashboards

### 15.1 Requirement (owner, 2026-10-15)
- The app serves several named dashboards.
- Each dashboard wraps today's `projects` configuration and adds a name.
- A top-level setting picks the default dashboard.
- Other dashboards are selected from a drop-down or menu, styled for the best look.

### 15.2 Configuration
```jsonc
{
  "kargo": { "url": "https://kargo.akpdemoapps.link", "tokenEnv": "KARGO_TOKEN" },
  "refreshIntervalSeconds": 30,
  "decay": { "thresholds": [ ... ] },
  "promotion": { ... },                         // section 14.4
  "defaultDashboard": "demos",                  // key of a dashboard below
  "dashboards": {                               // key = URL id; key order = menu order
    "demos": {
      "name": "SE Demos",
      "projects": { "demo-rollouts": { "warehouse": "demo-rollouts" }, "demo-snow": {} }
    },
    "teams": {
      "name": "Team Apps",
      "projects": { "team-ada": { "warehouses": ["akkoma-main", "akkoma-release"] }, "sedemo-app-demo": {} }
    }
  }
}
```
- **Dashboard keys** must match `^[a-z0-9][a-z0-9-]{0,62}$` because they appear in URLs. `name` is a required non-empty string. Each dashboard's `projects` follows sections 4 and 13 exactly (same validation, same `warehouse`/`warehouses` rules).
- **`defaultDashboard`:** must name an existing key. It's optional only when there is exactly one dashboard. With two or more it is required, and its absence is a startup error with a clear message.
- **The same project may appear in several dashboards**, even with different `displayName`, warehouses or stage filters. Its `tokenEnv` must resolve to the same variable everywhere it appears; a conflict is a startup error, because the project is fetched once (section 16).
- **Legacy shape:** a top-level `projects` (today's format) is still accepted. It becomes one dashboard with key `default` and name `"Kargo Dashboard"`, and a one-line deprecation warning is logged. Setting both `projects` and `dashboards` is a startup error. *(owner confirmed 2026-10-15)*
- **Out of scope:** per-dashboard decay thresholds, refresh intervals or tokens. They're global, as now. This is easy to add later if asked.

### 15.3 URLs and API
- **Page URLs:**
  - `/` shows the default dashboard;
  - `/d/<id>` shows a specific one, so links can be bookmarked and shared;
  - `/d/<unknown>` shows a friendly "No dashboard named …" message with a link to the default and an HTTP 404 status.
- **Static assets** must be referenced by absolute path (`/style.css`, `/app.js`) so they resolve under `/d/<id>`. The app is assumed to be served at the domain root, which matches the chart's Ingress (`path: /`).
- **API:**
  - `GET /api/dashboards` returns `[{ "id", "name", "default": bool }]` in config order.
  - `GET /api/summary?dashboard=<id>` returns the 13.5 payload for that dashboard plus `dashboard: { id, name }`. Without the parameter it serves the default. An unknown id returns 404 JSON.
  - `/healthz` is unchanged.
- **Switching dashboards** in the page uses `history.pushState` to `/d/<id>` and re-renders without a full reload. Back and forward work through `popstate`. `document.title` becomes `<dashboard name> · Kargo Dashboard`.

### 15.4 Look and feel (recommended)
- **The dashboard name is the page title and also the switcher.** The header reads `Kargo Dashboard` in small muted text, with the current dashboard name below it in the existing `h1` style and a chevron `▾` after it. Clicking it opens the list of dashboards. This is the familiar "title as picker" pattern (Grafana, Linear). It keeps the header uncluttered, scales to many dashboards, and works at phone width, where a tab row would overflow.
- **Build it on a native `<select>`** styled to look like the heading: `appearance: none`, inherited font, a custom chevron, a visible focus ring. That gives keyboard, screen-reader and mobile picker support for free. Options list dashboard names, with the default suffixed ` (default)`.
- **With a single dashboard**, render a plain heading with no chevron, so it looks exactly as it does today.
- The legend stays on the right of the header and wraps below it on narrow screens, as now.
- No per-viewer memory of the last dashboard: `/` always means the configured default, and the URL is the state.

### 15.5 Helm chart and docs
- **`deploy/chart/values.yaml` (owner decision, 2026-10-15):** the owner migrates this file themselves by wrapping the existing `config.projects` block, unchanged, in a single dashboard: `config.dashboards.default.name` plus `config.dashboards.default.projects`. **The agent does not edit `values.yaml` and does not propose a split.** Until the owner edits it, the legacy `config.projects` must keep working via the 15.2 fallback (with the warning). The startup error for a dashboard without a `name` must name the offending key, so a mis-nested `config.dashboards.projects` gets a clear message, e.g. `dashboards.projects: missing name (did you mean dashboards.<id>.projects?)`. The ConfigMap template needs no change, since it renders `config` verbatim.
- Update `config.example.json` to a two-dashboard example, and update the README's configuration reference and "Running" notes for the URLs.

## 16. Shared architecture change, execution order and acceptance (CR2 + CR3)

### 16.1 Why the architecture changes
Today `summarizeAll` walks `config.projects`, and fetching is tangled with building rows (`summarizeProject`). With dashboards, one Kargo project can appear in several dashboards with different views. With promotions, there is extra per-promotion state that must be cached across refreshes. So fetching and presentation are split:

- **New `src/collector.js` (all I/O orchestration).** Each refresh, it builds the set of **unique projects across all dashboards** and fetches a **snapshot** per project, concurrently:
  - `warehouses`;
  - all `stages`;
  - Freight for the **union** of warehouses any dashboard needs for that project (resolved after the warehouses list, so "no key = all" works);
  - step lists for active promotions (14.5 cache).

  Errors are recorded at project level (token, warehouses or stages call) and at warehouse level (a Freight call). It owns the promotion step cache. The calls per project match today's, plus one per newly seen running promotion.
- **`summarize.js` becomes pure.** `buildDashboard(dashboardConfig, snapshots, ctx)` returns `{ dashboard, rows }`, where `buildRow(projectKey, projectConfig, snapshot, ctx)` reuses `selectWarehouses`, `buildLane` and the new `promotionState`. A project-level snapshot error becomes an error row in every dashboard that lists the project. A warehouse-level error becomes that lane's error.
- **`server.js`.** One refresh loop for everything:
  1. The collector produces the snapshots.
  2. Every dashboard's payload is built from them and cached.
  3. The `/api/summary?dashboard=` handler serves from the cache.

  The interval adapts per P7. The "keep last good data on failure" behavior from section 7 is unchanged, now per dashboard.
- **Unchanged modules:** `stage-order.js`, `stage-filter.js`, `version.js` and `decay.js`.

### 16.2 Execution order (each step with tests; commit at each checkpoint)
Work on branch `feat/promotions-and-dashboards` off `main`. Commit at checkpoints. **Do not push or open a PR.** The ground rules in section 10a and the token protocol in section 12 still apply.
1. **Config:** the `dashboards`, `defaultDashboard`, legacy wrapping, `promotion` block, key, `tokenEnv` consistency and color validation (15.2, 14.4).
2. **Collector:** extract fetching out of `summarize.js` into `collector.js`, with no behavior change yet. Prove it by running the existing summarize tests through the new path; they must stay green.
3. **Dashboards:** `buildDashboard`, the per-dashboard payload cache, the routes, `/api/dashboards` and `?dashboard=` (15.3).
4. **Frontend switcher and routing** (15.4).
5. **Promotions:** `kargo-client.getPromotion`, the collector cache, `promotion.js`, the cell model (14.5–14.7).
6. **Promotion card styling, animation, legend and adaptive polling** (P4–P7, P9).
7. **Docs and config:** README, `config.example.json`, `values.yaml` migration (15.5), and a PLAN status note.
8. **Live verification:** two dashboards, then the owner-triggered promotions (14.8).

### 16.3 Acceptance criteria (all must hold)
1. `npm test` passes, covering every case listed in 14.8 and 15.2 (config errors included) and the collector behaviors. All previously passing tests still pass, updated only for moved functions.
2. A config with `dashboards.projects` (mis-nested, no `name`) fails at startup with the message from 15.5.
3. With a two-dashboard config:
   - `/` shows the default, and `/d/<other>` shows the other.
   - Switching via the title picker changes the URL, and Back returns to the previous dashboard.
   - `/d/nope` returns 404 with a link to the default.
   - A project listed in both dashboards is fetched **once** per refresh (assert on the mocked client's call log).
4. A legacy single-`projects` config still works unchanged, with the deprecation warning. Single-dashboard mode shows no chevron.
5. During owner-triggered promotions:
   - the running card is the promotion color with the heartbeat, and reads `N of M: <uses>` matching Kargo's UI step;
   - the waiting card is the waiting color with ⏸ and `Waiting for input …`;
   - the poll interval drops to the active value and returns to normal after the promotions finish;
   - with reduced motion emulated, nothing animates.
6. No page-level horizontal scroll at 390px. The switcher is usable by keyboard.
7. No token, hostname or approver identity appears in new fixtures or logs. The repo-wide token grep is clean.

**Required report:**
- the test summary;
- screenshots of both dashboards and both promotion states, desktop and phone;
- the observed live `currentPromotion.status` shape while running;
- the request counts per refresh before and after;
- every deviation from sections 14–16, with the reason.

### 16.4 Owner decisions (all confirmed 2026-10-15)
| # | Decision | Default in this plan |
|---|---|---|
| P1 | Show queued (`Pending`) promotions too? | **Confirmed:** no, only running; queued needs a heavy per-stage call |
| P2 | Which steps count as waiting for interaction? | **Confirmed:** `uses` contains `wait-for` (approval, PR, GitHub, GHA, ServiceNow waits) **or** is exactly `get-user-input` (form input). Default pattern `wait-for\|^get-user-input$` |
| P4 | Waiting color | **Confirmed:** purple `#7b1fa2` (running stays blue `#1e6fd9`) |
| P7 | Faster refresh while promoting | **Confirmed:** 5s while any promotion runs, else `refreshIntervalSeconds` |
| P8 | Link the promotion summary? | **Confirmed:** no URL pattern given, so not linked |
| 15.2 | Keep accepting the legacy top-level `projects`? | **Confirmed:** yes, as one `default` dashboard, with a warning |
| 15.5 | How to split today's `values.yaml` projects into dashboards | **Confirmed:** the owner wraps the existing list in one `default` dashboard; the agent leaves `values.yaml` alone |

### 16.5 Implementation notes (2026-10-15)
Built per 16.2. Deviations and additions:
- **Legend glyph:** the legend shows a round swatch for "Promoting" (standing in for the card's `●`) and keeps `⏸` for "Waiting for input", instead of a swatch plus a glyph for both (P9). The swatch + glyph combination looked doubled.
- **`deploy/chart/values.yaml` was not edited** (15.5): the owner migrates it. Until then the legacy `config.projects` form works with a startup warning.
- **Dev-only dependency:** `puppeteer-core` (not installed in the image) powers `npm run test:e2e`, which runs the real server against `e2e/fake-kargo.mjs`, a fake Kargo API built on the repo fixtures. It covers the browser behavior of 14.8 and 15.3 and 16.3 items 3-6, because live promotions can only be started by the owner.
- **Captured promotion:** the in-flight `currentPromotion.status` shape was **not** observed live (nothing was running, and the token is read-only), so the code reads progress from the reference when it has a `phase` and otherwise fetches the Promotion itself. See the verification section of the report for the live check the owner needs to trigger.
