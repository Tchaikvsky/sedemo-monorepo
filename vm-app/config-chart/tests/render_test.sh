#!/usr/bin/env bash
# Render tests for the nav-config chart. Requires helm and yq (mikefarah v4).
set -euo pipefail

CHART="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$CHART/tests/fixtures"
fails=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; fails=$((fails + 1)); }

expect_eq() { # name got want
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi
}

# 1. dev renders; per-env value comes from the fixture, shared value from the default.
out="$(helm template nav-config "$CHART" -f "$FIXTURES/dev.yaml" --set service.stage=dev)" || {
  fail "dev renders"; out=""
}
expect_eq "database.host from env values" "$(yq '.database.host' <<<"$out")" "navdb-dev.internal.example"
expect_eq "pricing.feedUrl from defaults" "$(yq '.pricing.feedUrl' <<<"$out")" "https://feeds.navpricing.example/v1/nav"
expect_eq "service.stage from --set" "$(yq '.service.stage' <<<"$out")" "dev"
expect_eq "roundingDecimals is an int" "$(yq '.pricing.roundingDecimals | tag' <<<"$out")" "!!int"

# 2. output is exactly one YAML document with top-level keys service, pricing, database.
expect_eq "single YAML document" "$(yq ea '[.] | length' <<<"$out")" "1"
expect_eq "top-level keys" "$(yq -o=json -I=0 'keys | sort' <<<"$out")" '["database","pricing","service"]'

# 3. missing required per-env value fails rendering with a message naming the key.
if err="$(helm template nav-config "$CHART" -f "$FIXTURES/sit-missing.yaml" --set service.stage=sit 2>&1 >/dev/null)"; then
  fail "missing database.host exits non-zero"
else
  pass "missing database.host exits non-zero"
  if grep -q 'database.host is required' <<<"$err"; then
    pass "error names database.host"
  else
    fail "error names database.host (stderr: $err)"
  fi
fi

# 4. service.stage is required too.
if helm template nav-config "$CHART" -f "$FIXTURES/dev.yaml" >/dev/null 2>&1; then
  fail "missing service.stage exits non-zero"
else
  pass "missing service.stage exits non-zero"
fi

if ((fails > 0)); then
  printf '%d check(s) failed\n' "$fails"
  exit 1
fi
echo "all checks passed"
