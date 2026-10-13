#!/usr/bin/env bash
# Render tests for the rollouts-demo env-file chart. Requires helm and yq (mikefarah v4).
#
# The rendered output is used verbatim as a systemd EnvironmentFile. systemd's
# parser skips leading whitespace, treats '#' lines as comments and silently
# drops lines without '=', so kv_lines() below reads the file the same way.
set -euo pipefail

CHART="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$CHART/tests/fixtures"
fails=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; fails=$((fails + 1)); }

expect_eq() { # name got want
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi
}

# KEY=VALUE assignments as systemd sees them (leading whitespace stripped;
# Helm's '---', '# Source:' and the YAML key line carry no '=' and are dropped).
kv_lines() { sed -E 's/^[[:space:]]+//' | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' || true; }

# 1. dev renders all six keys with the expected values; defaults apply.
out="$(helm template rollouts-demo-env "$CHART" -f "$FIXTURES/dev.yaml" \
  --set color=blue --set semver=50-blue --set stage=dev 2>&1)" || {
  fail "dev renders ($out)"; out=""
}
want="COLOR=blue
SEMVER=50-blue
STAGE=dev
NAMESPACE=vm-dev
ERROR_RATE=0
LATENCY=0"
expect_eq "dev renders exactly the six KEY=VALUE lines" "$(kv_lines <<<"$out")" "$want"
expect_eq "ERROR_RATE defaults to 0" "$(kv_lines <<<"$out" | grep '^ERROR_RATE=' || true)" "ERROR_RATE=0"

# 2. nothing but KEY=VALUE lines, comments, the document separator and the one
#    YAML key that Helm needs to accept the output.
other="$(sed -E 's/^[[:space:]]+//' <<<"$out" | grep -vE '^([A-Za-z_][A-Za-z0-9_]*=.*|#.*|---|rollouts-demo\.env: \|)?$' || true)"
expect_eq "no other content" "$other" ""

expect_eq "no line containing '=' other than the six" "$(grep -c '=' <<<"$out" || true)" "6"
expect_eq "YAML view holds the same assignments" "$(yq '.["rollouts-demo.env"]' <<<"$out")" "$want"

# 3. overrides flow through.
out2="$(helm template rollouts-demo-env "$CHART" -f "$FIXTURES/dev.yaml" \
  --set color=red --set semver=51-red --set stage=dev --set errorRate=100 --set latency=2 2>&1)" || {
  fail "overrides render ($out2)"; out2=""
}
expect_eq "errorRate override" "$(kv_lines <<<"$out2" | grep '^ERROR_RATE=' || true)" "ERROR_RATE=100"
expect_eq "latency override" "$(kv_lines <<<"$out2" | grep '^LATENCY=' || true)" "LATENCY=2"

# 4. missing per-env namespace fails rendering, naming the key.
if err="$(helm template rollouts-demo-env "$CHART" -f "$FIXTURES/sit-missing.yaml" \
  --set color=blue --set semver=50-blue --set stage=sit 2>&1 >/dev/null)"; then
  fail "missing namespace exits non-zero"
else
  pass "missing namespace exits non-zero"
  if grep -q 'namespace is required' <<<"$err"; then
    pass "error names namespace"
  else
    fail "error names namespace (stderr: $err)"
  fi
fi

# 5. color, semver and stage are required too.
for key in color semver stage; do
  args=(--set color=blue --set semver=50-blue --set stage=dev)
  filtered=()
  for ((i = 0; i < ${#args[@]}; i += 2)); do
    [[ "${args[i+1]}" == "$key="* ]] || filtered+=("${args[i]}" "${args[i+1]}")
  done
  if err="$(helm template rollouts-demo-env "$CHART" -f "$FIXTURES/dev.yaml" "${filtered[@]}" 2>&1 >/dev/null)"; then
    fail "missing $key exits non-zero"
  elif grep -q "$key is required" <<<"$err"; then
    pass "missing $key fails naming the key"
  else
    fail "missing $key fails naming the key (stderr: $err)"
  fi
done

if ((fails > 0)); then
  printf '%d check(s) failed\n' "$fails"
  exit 1
fi
echo "all checks passed"
