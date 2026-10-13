# vm-app

Config for the VM deployment demo. The application is the existing
`rollouts-app` (`ghcr.io/akuity/sedemo-monorepo-rollouts-app`, tags like
`50-blue`), run natively on Proxmox VMs under systemd instead of in Kubernetes.
No separate app or image is built for this demo; it promotes tags that
`rollouts-app` already publishes.

This directory holds only the Helm chart that renders the app's systemd
`EnvironmentFile`. Kargo renders it per stage and Ansible copies the result to
`/etc/rollouts-demo/rollouts-demo.env` unchanged. The pipeline itself lives
elsewhere: Kargo manifests in `sedemo-platform` under `apps/vm-demo/`, and
VM infrastructure in a separate repo.

## Config chart (`config-chart/`, chart `rollouts-demo-env`)

| Value | Env var | Default | Set by |
|-------|---------|---------|--------|
| `color` | `COLOR` | required | promotion (suffix of the image tag) |
| `semver` | `SEMVER` | required | promotion (the image tag) |
| `stage` | `STAGE` | required | promotion (stage name) |
| `namespace` | `NAMESPACE` | required | per-stage values file (e.g. `vm-dev`) |
| `errorRate` | `ERROR_RATE` | `0` | chart default (integer percent of failing `/color` requests) |
| `latency` | `LATENCY` | `0` | chart default |

A missing required value fails rendering with `<key> is required`, before any
VM is touched.

Example output:

```text
---
# Source: rollouts-demo-env/templates/rollouts-demo.env.yaml
rollouts-demo.env: |
  COLOR=blue
  SEMVER=50-blue
  STAGE=dev
  NAMESPACE=vm-dev
  ERROR_RATE=0
  LATENCY=0
```

Helm (and Kargo's `helm-template` step) parses every rendered template as YAML
and rejects a bare `KEY=VALUE` file, so the variables sit in a block scalar
under one key. systemd's `EnvironmentFile` parser skips leading whitespace,
ignores `#` comments and silently drops lines without `=`, so the same bytes are
a valid environment file with exactly the six variables above.

```bash
helm template rollouts-demo-env vm-app/config-chart -f <stage>/values.yaml \
  --set color=blue --set semver=50-blue --set stage=dev
bash vm-app/config-chart/tests/render_test.sh   # needs helm and yq
```
