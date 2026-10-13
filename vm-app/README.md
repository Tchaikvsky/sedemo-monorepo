# vm-app

A small Go HTTP service, `nav-service` (fund NAV pricing), and the Helm chart
that renders its config. Kargo promotes both to Proxmox VMs; Ansible installs
them. The deployment side lives elsewhere (Kargo manifests in `sedemo-platform`
under `apps/vm-demo/`, VM infrastructure in a separate repo).

## Layout

| Path | Contents |
|------|----------|
| `app/` | Go service, systemd unit, `VERSION` |
| `config-chart/` | Helm chart `nav-config`; its only template renders `config.yaml` |
| `../.github/workflows/publish-vm-app.yml` | Builds and pushes the release artifact |

## Service

- Listens on `service.listenAddr` (default `:8080`).
- Reads `/etc/nav-service/config.yaml` (override with `--config`).
- Runs as user `nav` from `/usr/local/bin/nav-service` under `nav-service.service`.

| Endpoint | Response |
|----------|----------|
| `GET /` | HTML page: version, stage, currency, NAV cutoff, database host |
| `GET /version` | `{"version": "...", "stage": "...", "configHash": "..."}`; `configHash` is the first 12 hex chars of the SHA-256 of the config file |
| `GET /healthz` | `200 ok`, or `500` with the reason when `pricing.feedUrl` is not an `https://` URL with a host |

Malformed YAML makes the service exit non-zero. A config that parses but is
semantically invalid still starts, and `/healthz` reports the problem; this is
what Kargo verification catches.

Config schema:

```yaml
service:  { stage: string, listenAddr: string }
pricing:  { feedUrl: string, currency: string, navCutoff: string, roundingDecimals: int }
database: { host: string, name: string }
```

## Develop

```bash
cd vm-app/app
go test ./... && go vet ./...
go run . --config /path/to/config.yaml
```

## Release

Bump `app/VERSION` and merge to `main`. The publish workflow builds a static
linux/amd64 binary and pushes
`ghcr.io/akuity/sedemo-monorepo-vm-app:<VERSION>` with `oras`. The
artifact has one layer, `nav-service_<VERSION>_linux_amd64.tar.gz`, holding
`nav-service` and `nav-service.service`. Existing tags are never overwritten,
so the workflow fails if `VERSION` was not bumped.

## Config chart

```bash
helm template nav-config vm-app/config-chart -f <env>/values.yaml --set service.stage=<stage>
bash vm-app/config-chart/tests/render_test.sh
```

`service.stage`, `database.host` and `database.name` are required per
environment; rendering fails if any is missing.
