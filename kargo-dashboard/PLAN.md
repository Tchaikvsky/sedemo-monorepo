# Kargo Dashboard — Implementation Plan

Source of truth for intent: [README.md](README.md). This plan turns it into concrete, ordered work. Owner decisions are in section 11. Nothing is open. The one external dependency, the API token, is handled by the protocol in section 12. **Change request 1 (multiple warehouses per project) is planned in section 13 and supersedes 6.1 (including its "multiple warehouses" error), 6.7 and the frontend row layout where they disagree.** Where this plan and the README disagree, follow this plan and update the README in step 12.

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
