# Kargo Dashboard

This project is a lightweight Node.js app that summarizes the current state of Kargo powered projects, specifically visualizing the currently deployed version of several projects across their environments.

## Visualization

- Project names are the y-axis row names
- A project that uses several warehouses is still one row, split into one lane (sub-row) per warehouse, each labeled with its warehouse name (see [Configuration](#configuration))
- Each lane may have an inconsistent number of cells, tied to the number of stages in that pipeline
- Order of cells in a row matches the dependencies defined by Kargo Stages
- Individual cells show the version of that project deployed to that stage
- Cell color is a visual indicator of the version decay (more below in Version Decay)
- The first column in every lane is the latest freight version of that lane's warehouse

The visual is agnostic to stage names: there are no stage-name columns and rows are not aligned by name. Each lane is simply one warehouse's pipeline, left to right. The stage name appears as a small caption inside its cell.

Stages with no promotion steps ("control flow" stages) never hold Freight, so they are not drawn, though they still count when ordering the pipeline.

## Requirements

- Node.js 22 or later
- A Kargo API token with read access to each configured project (see [API token](#api-token))
- Customizations and settings live in `config.json`
- "Version" is determined from the warehouse's subscriptions:
  1. The first subscription that is an `image` or a `chart`: the image `Tag`, or the chart `version`, of the matching artifact in the Freight.
  2. Only if the warehouse has neither: the short (7 character) SHA of the first `git` subscription's commit.

## Version Decay

Version decay is a visual indicator of idle inventory; meaning versions built but not yet delivered into higher environments. The greater the count of freight objects between latest freight and currently deployed, the higher the considered "decay" to be.

Essentially this is the measure of how far out of date any environment or stage is. Only Freight from the lane's own warehouse is counted, so each lane has its own decay.

The color scheme is customizable (`decay.thresholds`), and defaults to Good, OK, Bad, Worse:

| Versions behind latest | Label | Meaning |
|---|---|---|
| 0 | Good | up to date |
| 1 | OK | 1 version behind |
| 2 to 3 | Bad | more than 1 and at most 3 behind (exactly 3 is Bad) |
| 4 or more | Worse | more than 3 behind |

A stage with nothing deployed, or whose Freight no longer exists, is shown as Worse with the label "unknown".

Freight, not version strings, is what is counted. A new commit can produce a new Freight that carries the same image tag, so a stage can show the same version as "latest" and still be 1 behind.

## Running

```sh
npm ci
cp config.example.json config.json   # then edit
export KARGO_TOKEN=...               # see "API token"
npm start                            # listens on :8080
```

| Env var | Purpose |
|---|---|
| `CONFIG_PATH` | Config file location (default `./config.json`) |
| `KARGO_URL` | Overrides `kargo.url` from the config |
| `KARGO_TOKEN` | Default API token (the variable name is configurable, see `tokenEnv`) |
| `PORT` | HTTP port (default `8080`) |

Endpoints: `/` (the dashboard), `/api/summary` (the JSON behind it), `/healthz` (503 until the first refresh completes).

Docker: `docker build -t kargo-dashboard .`, then run it with the config mounted at `/app/config.json` and the token passed as an environment variable. The image is published as `ghcr.io/akuity/sedemo-monorepo-kargo-dashboard` by `.github/workflows/publish-kargo-dashboard.yml`.

Tests: `npm test`. The tests under `test/fixtures` are scrubbed responses captured from a live Kargo API.

## Configuration

See [`config.example.json`](config.example.json).

- `kargo.url`: the Kargo instance (or `KARGO_URL`)
- `kargo.tokenEnv`: name of the env var holding the API token (default `KARGO_TOKEN`)
- `refreshIntervalSeconds`: how often the server re-reads Kargo, and the page re-polls (default 30)
- `decay.thresholds`: ascending list of `{ max, label, color }`, where `max` is the highest "versions behind" count the entry covers. Only the last entry may (and must) have `max: null`
- Projects to include, as a map (key order is display order), with individual values:
  - `displayName`: optional label
  - `warehouse`: show one warehouse (by name). A single lane with no warehouse caption
  - `warehouses`: a list of warehouse names; each becomes its own lane inside the project's row, in list order, with its name as a caption. Use either `warehouse` or `warehouses`, not both
  - With neither, every warehouse the project has becomes a lane (sorted by name). A project with a single warehouse is a single lane with no caption
  - `tokenEnv`: optional per-project token variable, overriding `kargo.tokenEnv`
  - `excludeStages`: stages to exclude (regex if prefixed with `regex:`, or full match otherwise)
  - `includeStages`: stages to include (regex if prefixed with `regex:`, or full match otherwise)
  - Stages will first consider all includes, and then remove any excludes. Absence of defined includes will include all, and then apply excludes if any. Regexes are unanchored, so add `^` and `$` where needed.

A project that fails as a whole (no token access, no warehouses) shows an error row. A single bad warehouse (for example a misspelled name in `warehouses`) shows an error in just that lane. Either way the other projects and lanes still render. `includeStages` and `excludeStages` apply to every lane of a project.

## API token

The dashboard only reads. The token's role needs `get`/`list` on `warehouses`, `stages` and `freight` in each project. A token that can only list projects authenticates but gets `403 ... list is not permitted` on everything else.

Kargo's API describes both project-level tokens (`POST /v1beta1/projects/{project}/roles/{role}/api-tokens`) and system-level tokens (`POST /v1beta1/system/roles/{role}/api-tokens`). If one token can't cover every project, create one per project and point each project at its variable with `tokenEnv`. The token is only ever read from the environment; it is never written to the config, logs or error messages.

# Resources

## Kargo Concepts

- Freight is an immutable tuple representing container images and supporting git configuration
- Stages define promotions into specific targets
- Promotion is an instance of moving freight into a target
- Warehouses define the source repositories and registries as subscriptions.
- Projects is the container for a pipeline or promotion flow where Warehouse, Freight, Stages, etc live.

## Kargo API

Kargo's API should expose all needed data. i.e. latest freight, what version is in each stage.

This app uses the Kargo REST API (`/v1beta1`, verified against Kargo v1.12.1), with read-only calls per project per refresh (two, plus one freight call per lane):

- `GET /v1beta1/projects/{project}/warehouses`
- `GET /v1beta1/projects/{project}/stages` (all of the project's stages; each lane picks those that request its warehouse)
- `GET /v1beta1/projects/{project}/freight?origins={warehouse}` (once per lane)

The current version of a stage comes from `status.freightHistory[0].items["Warehouse/{warehouse}"]`.
