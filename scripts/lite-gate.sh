#!/usr/bin/env bash
# `pnpm gate` — the fast pre-preview contract gate for the lite loop.
#
# Default (warm target < 2 min): the TS + Python workflow-data contract fixtures
# plus the dependency-cruiser boundary check — the things that catch a
# portability break before it reaches a preview. `--full` runs the whole unit +
# orchestrator suites instead (matches CI's pr-checks.yml).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/node_modules/.bin:$PATH"

FULL=false
[ "${1:-}" = "--full" ] && FULL=true

ORCH=services/workflow-orchestrator
start=$(date +%s)
step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

step "contract fixtures (vitest, TS)"
if $FULL; then
	vitest run
else
	vitest run src/routes/api/internal/workflow-data/workflow-data-contract.test.ts
fi

step "contract fixtures (pytest, orchestrator — Dapr-free)"
if $FULL; then
	( cd "$ORCH" && uv run pytest tests/ -q )
else
	( cd "$ORCH" && uv run pytest tests/test_workflow_data_activity_migration.py -q )
fi

step "boundaries (dependency-cruiser)"
svelte-kit sync
depcruise src/lib/server src/routes --config .dependency-cruiser.cjs

printf '\n\033[32m✓ gate passed\033[0m in %ss%s\n' "$(( $(date +%s) - start ))" \
	"$($FULL && echo ' (--full)' || echo '')"
