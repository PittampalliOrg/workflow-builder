#!/usr/bin/env bash
#
# verify-agent-teams-dev.sh — dev-cluster acceptance checks D + F for Agent Teams
# (docs/agent-teams-phase1.md). Read-only: it inspects state, it does NOT drive a
# run. Run an end-to-end team FIRST (lead spawns teammate, create_task, teammate
# claim_task + update_task(completed)), then pass the TEAM_ID (and optionally the
# LEAD_SESSION_ID) to prove the aftermath.
#
# Usage:
#   scripts/verify-agent-teams-dev.sh                 # checks A + D only
#   scripts/verify-agent-teams-dev.sh <TEAM_ID> [LEAD_SESSION_ID]   # + check F
#
# Assumes kubectl is pointed at the dev cluster (context vc-hex-*), namespace
# workflow-builder. psql runs INSIDE the BFF pod, which holds DATABASE_URL.
set -euo pipefail

NS="${TEAMS_NS:-workflow-builder}"
TEAM_ID="${1:-}"
LEAD_SESSION_ID="${2:-}"
DEPLOYS=(workflow-mcp-server workflow-builder workflow-orchestrator)

echo "== context: $(kubectl config current-context) / ns=$NS =="

# Run a SQL statement (from stdin) via psql inside the BFF pod. DATABASE_URL stays
# in-pod; the SQL is composed out here and piped in.
psql_dev() {
	kubectl -n "$NS" exec -i deploy/workflow-builder -c workflow-builder -- \
		sh -lc 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -A -F"|" -t -c "$(cat)"'
}

fail() { echo "FAIL: $*" >&2; exit 1; }

# ── A: schema present ────────────────────────────────────────────────────────
echo; echo "== A. tables present =="
present="$(printf '%s' "
  select string_agg(table_name, ',' order by table_name)
  from information_schema.tables
  where table_schema='public' and table_name in ('teams','team_members','team_tasks');
" | psql_dev)"
echo "found: ${present:-<none>}"
for t in teams team_members team_tasks; do
	case ",$present," in *",$t,"*) : ;; *) fail "table $t missing (migration not applied)";; esac
done
echo "A OK: teams, team_members, team_tasks exist"

# ── D: runtime pods Ready 2/2 (no 1/2 daprd) ─────────────────────────────────
echo; echo "== D. pod readiness (want 2/2, no 1/2 daprd) =="
kubectl -n "$NS" get pods -o wide | grep -E "$(IFS='|'; echo "${DEPLOYS[*]}")" || true
for d in "${DEPLOYS[@]}"; do
	# newest Running pod for this deployment
	pod="$(kubectl -n "$NS" get pods -l "app=$d" \
		--field-selector=status.phase=Running \
		--sort-by=.metadata.creationTimestamp -o name 2>/dev/null | tail -1)"
	[ -n "$pod" ] || pod="$(kubectl -n "$NS" get pods -o name | grep -m1 "$d" || true)"
	[ -n "$pod" ] || fail "no pod found for $d"
	ready="$(kubectl -n "$NS" get "$pod" -o jsonpath='{range .status.containerStatuses[*]}{.ready}{"\n"}{end}')"
	total=$(printf '%s\n' "$ready" | grep -c . || true)
	up=$(printf '%s\n' "$ready" | grep -c true || true)
	echo "  $d: $up/$total ready"
	[ "$up" = "$total" ] && [ "$total" -ge 2 ] || fail "$d not fully ready ($up/$total) — check daprd sidecar"
done
echo "D OK: all runtime pods Ready"

# ── F: end-to-end aftermath (needs a completed team run) ─────────────────────
if [ -z "$TEAM_ID" ]; then
	echo; echo "F SKIPPED: pass <TEAM_ID> [LEAD_SESSION_ID] after running an end-to-end team."
	echo "ALL PRESENT CHECKS PASSED (A, D)."
	exit 0
fi

echo; echo "== F. end-to-end for team=$TEAM_ID =="

echo "-- members --"
printf '%s' "select name,role,status,session_id from team_members where team_id='$TEAM_ID' order by joined_at;" | psql_dev

echo "-- tasks --"
tasks="$(printf '%s' "select id,status,assignee_session_id from team_tasks where team_id='$TEAM_ID' order by created_at;" | psql_dev)"
echo "$tasks"
echo "$tasks" | grep -q '|completed|' || fail "no completed team_task with an assignee (teammate did not finish a claimed task)"
echo "F.a OK: a task reached completed with an assignee"

# Injected teammate/idle messages carry deterministic sourceEventId (team-msg / team-idle).
echo "-- injected session_events (origin + sourceEventId) --"
sess_filter=""
[ -n "$LEAD_SESSION_ID" ] && sess_filter="and se.session_id in ('$LEAD_SESSION_ID', se.session_id)"
events="$(printf '%s' "
  select se.session_id, se.source_event_id, se.data->>'origin' as origin
  from session_events se
  where se.source_event_id like 'team-%'
    and se.session_id in (select session_id from team_members where team_id='$TEAM_ID')
  order by se.sequence desc limit 20;
" | psql_dev)"
echo "$events"
echo "$events" | grep -Eq 'team-(msg|idle|broadcast)' || fail "no injected team-* session_events (mailbox/idle-notice not delivered)"
echo "F.b OK: injected messages present with team-* sourceEventId"

# Runtime/orchestrator log markers (best-effort, non-fatal).
echo "-- recent orchestrator log (team markers) --"
kubectl -n "$NS" logs deploy/workflow-orchestrator --tail=200 2>/dev/null \
	| grep -iE "team|teammate|claim_task|spawn_teammate" | tail -20 || echo "(no matching log lines)"

echo; echo "ALL CHECKS PASSED (A, D, F) for team $TEAM_ID."
