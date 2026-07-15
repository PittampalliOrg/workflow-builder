#!/bin/sh
# dev-sync client — push edited source to a per-run dev preview and, on a
# dependency-manifest change, trigger an in-pod reinstall. Committed to the repo
# (not heredoc'd into the workflow fixture) so it is shellcheck- and unit-testable;
# the microservice-dev-session workflow copies this into /sandbox/work/sync.sh
# beside its per-service config. The interactive pod activates the archived
# checkout on local storage and exposes it through /sandbox/work/repo.
#
# Config is read from (whichever exists, in order):
#   $DEV_SYNC_ENV_DIR/*   — one file per service (multi-service fan-out), or
#   $DEV_SYNC_ENV         — a single service.
# Each config file sets:
#   SUBDIR     repo subdir whose source maps onto the dev pod workdir ("." = root)
#   PATHS      space-separated syncPaths (relative to SUBDIR) to tar + push
#   SYNCURL    the pod's /__sync URL (…:<syncPort>/__sync)
#   HEALTHURL  the catalog-derived application health URL (url + healthPath)
#   EXTRASYNC  optional: space-separated  from:to  pairs (from rel to SUBDIR, to rel
#              to the tar root/pod workdir) staged into the tar before it is built
#   SYNC_TOKEN x-sync-token capability used for uploads and status proof
#
# On each run, per service: stage extraSync → tar existing paths → POST /__sync →
# if a dep manifest changed since the last run, POST /__run?cmd=deps (the sidecar
# runs the allowlisted `deps` command in the pod-LOCAL workdir; NEVER on JuiceFS).
set -u

WORK="${DEV_SYNC_WORK:-/sandbox/work}"
REPO="${DEV_SYNC_REPO:-$WORK/repo}"
ENV_DIR="${DEV_SYNC_ENV_DIR:-$WORK/.syncenv.d}"
ENV_FILE="${DEV_SYNC_ENV:-$WORK/.syncenv}"
# Dependency manifests whose change (per service) triggers /__run?cmd=deps.
DEP_MANIFESTS="package.json pnpm-lock.yaml .npmrc requirements.txt pyproject.toml uv.lock"

rc=0
CONVERGENCE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dev-sync-convergence.XXXXXX") || exit 1
chmod 700 "$CONVERGENCE_DIR"
PREPARING_DIR=""

# Keep the recovery journal on the pod-local checkout when possible. The fallback
# name is already covered by the workflow workspace's `/.syncdeps.*` ignore rule.
if [ -n "${DEV_SYNC_TRANSACTION_DIR:-}" ]; then
	TRANSACTION_DIR=$DEV_SYNC_TRANSACTION_DIR
elif [ -d "$REPO/.git" ] && [ -w "$REPO/.git" ]; then
	TRANSACTION_DIR="$REPO/.git/wfb-dev-sync-transaction"
else
	TRANSACTION_DIR="$WORK/.syncdeps.dev-sync-transaction"
fi
LOCK_DIR="$TRANSACTION_DIR.lock"
LOCK_OWNED=0

# Invoked by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
	[ -z "$PREPARING_DIR" ] || rm -rf "$PREPARING_DIR"
	rm -rf "$CONVERGENCE_DIR"
	[ "$LOCK_OWNED" -eq 0 ] || rm -rf "$LOCK_DIR"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Serialize sync clients sharing one checkout. A killed owner leaves a recoverable
# lock; an active owner makes a second invocation fail before either can mutate a
# receiver with a competing generation.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
	_lock_owner=""
	[ -f "$LOCK_DIR/owner" ] && IFS= read -r _lock_owner <"$LOCK_DIR/owner"
	if [ -z "$_lock_owner" ]; then
		sleep 1
		[ -f "$LOCK_DIR/owner" ] && IFS= read -r _lock_owner <"$LOCK_DIR/owner"
	fi
	case "$_lock_owner" in
		""|*[!0-9]*) _lock_active=0 ;;
		*)
			if kill -0 "$_lock_owner" 2>/dev/null; then
				_lock_active=1
			else
				_lock_active=0
			fi
			;;
	esac
	if [ "$_lock_active" -eq 1 ]; then
		echo "sync transaction already active (pid=$_lock_owner)" >&2
		exit 1
	fi
	echo "sync transaction: recovering stale client lock${_lock_owner:+ (pid=$_lock_owner)}" >&2
	rm -rf "$LOCK_DIR"
	mkdir "$LOCK_DIR" || exit 1
fi
LOCK_OWNED=1
printf '%s\n' "$$" >"$LOCK_DIR/owner" || exit 1

CONFIGS=""
if [ -d "$ENV_DIR" ] && [ -n "$(ls -A "$ENV_DIR" 2>/dev/null)" ]; then
	for cfg in "$ENV_DIR"/*; do
		[ -f "$cfg" ] && CONFIGS="$CONFIGS $cfg"
	done
elif [ -f "$ENV_FILE" ]; then
	CONFIGS=" $ENV_FILE"
fi
if [ -z "$CONFIGS" ]; then
	echo "no sync config: neither $ENV_DIR/* nor $ENV_FILE exists" >&2
	exit 1
fi

CONFIG_COUNT=0
for cfg in $CONFIGS; do CONFIG_COUNT=$((CONFIG_COUNT + 1)); done

# sha256 of the concatenated existing manifests in the CWD (empty if none).
manifest_hash() {
	present=""
	for m in $DEP_MANIFESTS; do
		[ -f "$m" ] && present="$present $m"
	done
	[ -n "$present" ] || return 0
	# shellcheck disable=SC2086
	cat $present 2>/dev/null | sha256sum | cut -d' ' -f1
}

# Trigger an in-pod dependency action on the first sync and whenever the manifest
# hash changes afterward. The checkout may be an exact feature SHA while the baked
# dev image is older, so recording an unproved first-run baseline would deploy code
# against the wrong dependency graph.
maybe_deps() {
	_subdir="$1"
	_syncurl="$2"
	_deps_output="$3"
	newhash="$4"
	[ -n "$newhash" ] || return 0
	state="$WORK/.syncdeps.$(printf '%s' "$_subdir" | tr '/.' '__')"
	oldhash=""
	[ -f "$state" ] && oldhash=$(cat "$state" 2>/dev/null)
	if [ -n "$oldhash" ] && [ "$newhash" = "$oldhash" ]; then
		return 0
	fi
	runurl=$(printf '%s' "$_syncurl" | sed 's#/__sync$#/__run#')
	echo "deps: manifest changed for $_subdir → POST $runurl?cmd=deps"
	code=$(curl -s -o "$_deps_output" -w '%{http_code}' -X POST \
		--connect-timeout "$UPLOAD_CONNECT_TIMEOUT" --max-time "$UPLOAD_TIMEOUT" \
		${SYNC_TOKEN:+-H "x-sync-token: $SYNC_TOKEN"} "$runurl?cmd=deps" 2>/dev/null)
	if [ "$code" = "404" ]; then
		echo "deps: no deps command configured for this service (skip)"
		printf '%s' "$newhash" >"$state"
		return 0
	fi
	sed 's/^/deps> /' "$_deps_output" 2>/dev/null
	echo "deps: /__run?cmd=deps → HTTP $code"
	if [ "$code" != "200" ] || ! python3 -c 'import json, sys; data = json.load(open(sys.argv[1], encoding="utf-8")); exit_code = data.get("exitCode") if isinstance(data, dict) else None; sys.exit(0 if isinstance(data, dict) and data.get("ok") is True and (0 if exit_code is None or exit_code is False else exit_code) == 0 else 1)' \
			"$_deps_output" >/dev/null 2>&1; then
		echo "deps: install failed for $_subdir; leaving the prior manifest baseline for retry" >&2
		rc=1
		return 1
	fi
	# Advance the baseline only after the in-pod dependency action really passed.
	printf '%s' "$newhash" >"$state"
}

load_config() {
	_cfg=$1
	_config_service=${2:-}
	SUBDIR="" PATHS="" SYNCURL="" HEALTHURL="" EXTRASYNC="" SYNC_TOKEN="" SERVICE=""
	# shellcheck disable=SC1090
	. "$_cfg"
	: "${SUBDIR:=.}"
	: "${PATHS:=src}"
	: "${SYNCURL:=}"
	: "${HEALTHURL:=}"
	: "${EXTRASYNC:=}"
	: "${SYNC_TOKEN:=}"
	: "${SERVICE:=}"
	_sync_service=$SERVICE
	[ -n "$_sync_service" ] || _sync_service=$_config_service
	if [ -z "$_sync_service" ]; then
		if [ "$SUBDIR" = "." ]; then
			_sync_service=workflow-builder
		else
			_sync_service=${SUBDIR##*/}
		fi
	fi
	if [ -z "$SYNCURL" ]; then
		echo "skip: no SYNCURL for $SUBDIR"
		return 1
	fi
	if [ -z "$HEALTHURL" ]; then
		echo "skip: no HEALTHURL for $SUBDIR"
		return 1
	fi
	svcdir="$REPO/$SUBDIR"
	if [ ! -d "$svcdir" ]; then
		echo "skip: repo dir not found: $svcdir"
		return 1
	fi
	return 0
}

declared_roots_json() {
	declared_roots=$(
		for p in $PATHS; do printf '%s\n' "$p"; done
		for pair in $EXTRASYNC; do
			eto=${pair#*:}
			[ -n "$eto" ] && printf '%s\n' "$eto"
		done
	) || return 1
	printf '%s\n' "$declared_roots" | python3 -c 'import json, sys; print(json.dumps(sorted(set(filter(None, (line.rstrip("\n") for line in sys.stdin)))), separators=(",", ":")))'
}

# Freeze every service archive before the first receiver mutation. A published
# transaction is immutable and can therefore reuse the receiver's generation +
# digest idempotency contract after interruption.
prepare_one() {
	_prepare_index=$1
	_prepare_cfg=$2
	_prepare_default=$3
	load_config "$_prepare_cfg" "$_prepare_default" || return 1
	cd "$svcdir" || return 1
	_prepare_roots=$(declared_roots_json) || {
		echo "invalid sync roots for $SUBDIR" >&2
		return 1
	}

	# Stage extraSync/capture-only sources (from rel to SUBDIR -> to rel to tar
	# root). Removing the target even when the source vanished propagates deletion.
	staged=""
	for pair in $EXTRASYNC; do
		efrom=${pair%%:*}
		eto=${pair#*:}
		if [ -n "$eto" ]; then
			rm -rf "${svcdir:?}/$eto"
			staged="$staged $eto"
		fi
		if [ -e "$svcdir/$efrom" ] && [ -n "$eto" ]; then
			if [ -d "$svcdir/$efrom" ]; then
				mkdir -p "$svcdir/$eto"
				cp -a "$svcdir/$efrom/." "$svcdir/$eto/" 2>/dev/null
			else
				mkdir -p "$(dirname "$svcdir/$eto")"
				cp -a "$svcdir/$efrom" "$svcdir/$eto" 2>/dev/null
			fi
			echo "staged extraSync $efrom -> $eto"
		fi
	done

	# Collect the paths that actually exist (sync + export both tolerate absentees,
	# but tarring a missing member fails the archive).
	syncpaths=""
	for p in $PATHS $staged; do
		[ -e "$p" ] && syncpaths="$syncpaths $p"
	done
	archive="$PREPARING_DIR/archive.$_prepare_index.tgz"
	if [ -n "$syncpaths" ]; then
		# shellcheck disable=SC2086
		tar -czf "$archive" $syncpaths
	else
		tar -czf "$archive" -T /dev/null
	fi || {
		echo "tar failed for $SUBDIR"
		return 1
	}
	_archive_hash=$(sha256sum "$archive") || return 1
	_archive_hash=${_archive_hash%% *}
	_manifest_hash=$(manifest_hash)
	_prepare_name=$(basename "$_prepare_cfg")
	[ "$_prepare_cfg" = "$ENV_FILE" ] && _prepare_name=__single__
	printf '%s\n' "$_prepare_name" >"$PREPARING_DIR/config.$_prepare_index"
	printf '%s\n' "$_sync_service" >"$PREPARING_DIR/service.$_prepare_index"
	printf '%s\n' "$SUBDIR" >"$PREPARING_DIR/subdir.$_prepare_index"
	printf '%s\n' "$_prepare_roots" >"$PREPARING_DIR/roots.$_prepare_index.json"
	printf '%s\n' "sha256:$_archive_hash" >"$PREPARING_DIR/digest.$_prepare_index"
	printf '%s\n' "$_manifest_hash" >"$PREPARING_DIR/manifest.$_prepare_index"
}

validate_transaction_target() {
	_target_index=$1
	_target_cfg=$2
	_target_default=$3
	load_config "$_target_cfg" "$_target_default" || return 1
	_target_name=$(basename "$_target_cfg")
	[ "$_target_cfg" = "$ENV_FILE" ] && _target_name=__single__
	IFS= read -r _expected_name <"$TRANSACTION_DIR/config.$_target_index" || return 1
	IFS= read -r _expected_service <"$TRANSACTION_DIR/service.$_target_index" || return 1
	IFS= read -r _expected_subdir <"$TRANSACTION_DIR/subdir.$_target_index" || return 1
	IFS= read -r _expected_roots <"$TRANSACTION_DIR/roots.$_target_index.json" || return 1
	IFS= read -r _expected_digest <"$TRANSACTION_DIR/digest.$_target_index" || return 1
	_target_roots=$(declared_roots_json) || return 1
	if [ "$_target_name" != "$_expected_name" ] || \
		[ "$_sync_service" != "$_expected_service" ] || \
		[ "$SUBDIR" != "$_expected_subdir" ] || \
		[ "$_target_roots" != "$_expected_roots" ]; then
		echo "sync transaction target changed at index $_target_index; rebase the pending transaction explicitly" >&2
		return 1
	fi
	_target_archive="$TRANSACTION_DIR/archive.$_target_index.tgz"
	if [ ! -f "$_target_archive" ] || [ -L "$_target_archive" ]; then
		echo "sync transaction archive is missing at index $_target_index" >&2
		return 1
	fi
	_target_hash=$(sha256sum "$_target_archive") || return 1
	_target_hash="sha256:${_target_hash%% *}"
	if [ "$_target_hash" != "$_expected_digest" ]; then
		echo "sync transaction archive digest changed at index $_target_index" >&2
		return 1
	fi
	return 0
}

upload_one() {
	_upload_index=$1
	_upload_attempt=$2
	_upload_cfg=$3
	_upload_default=$4
	validate_transaction_target "$_upload_index" "$_upload_cfg" "$_upload_default" || return 1
	_result_key=$(printf '%s' "$_sync_service" | tr -c 'A-Za-z0-9._-' '_')
	_sync_output="$CONVERGENCE_DIR/sync-$_result_key.json"
	_sync_error="$CONVERGENCE_DIR/sync-$_result_key.err"
	result=$(curl -sS -o "$_sync_output" -w '%{http_code} %{time_total}' -X POST \
		--connect-timeout "$UPLOAD_CONNECT_TIMEOUT" --max-time "$UPLOAD_TIMEOUT" \
		--data-binary @"$_target_archive" -H 'content-type: application/gzip' \
		-H "x-sync-generation: $SYNC_GENERATION_VALUE" \
		-H "x-sync-service: $_sync_service" \
		-H "x-sync-roots: $_expected_roots" \
		${SYNC_TOKEN:+-H "x-sync-token: $SYNC_TOKEN"} "$SYNCURL" 2>"$_sync_error")
	_curl_exit=$?
	case "$result" in
		*" "*) code=${result%% *}; elapsed=${result#* } ;;
		*) code=$result; elapsed="" ;;
	esac
	if [ "$_curl_exit" -ne 0 ] || [ "$code" != "200" ]; then
		echo "APPLY FAILED $SUBDIR → HTTP ${code:-000}${elapsed:+ in ${elapsed}s} (service=$_sync_service generation=$SYNC_GENERATION_VALUE attempt=$_upload_attempt)" >&2
		sed 's/^/curl> /' "$_sync_error" 2>/dev/null >&2
		sed 's/^/sync> /' "$_sync_output" 2>/dev/null
		return 1
	fi
	summary=$(python3 - "$_sync_output" "$SYNC_GENERATION_VALUE" "$_sync_service" "$_expected_digest" <<'PY_RESPONSE'
import json
import sys

try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(1)
if not (
    isinstance(data, dict)
    and data.get("ok") is True
    and data.get("generation") == sys.argv[2]
    and data.get("service") == sys.argv[3]
    and data.get("contentSha256") == sys.argv[4]
):
    raise SystemExit(1)
parts = []
parts.append("idempotent={}".format(str(data.get("idempotent") is True).lower()))
changed = data.get("changedPathCount")
if isinstance(changed, int):
    parts.append(f"changed={changed}")
timings = data.get("timingsMs")
if isinstance(timings, dict) and isinstance(timings.get("total"), (int, float)):
    parts.append("apply={}ms".format(timings["total"]))
paths = data.get("changedPaths")
if isinstance(paths, list) and paths:
    shown = ",".join(str(item) for item in paths[:3])
    parts.append("paths={}{}".format(shown, ",..." if len(paths) > 3 else ""))
print(" ".join(parts))
PY_RESPONSE
	)
	_response_ok=$?
	if [ "$_response_ok" -ne 0 ]; then
		echo "APPLY FAILED $SUBDIR: receiver returned an invalid generation receipt" >&2
		sed 's/^/sync> /' "$_sync_output" 2>/dev/null >&2
		return 1
	fi
	echo "APPLIED $SUBDIR → HTTP $code${elapsed:+ in ${elapsed}s} (service=$_sync_service generation=$SYNC_GENERATION_VALUE attempt=$_upload_attempt)"
	[ -z "$summary" ] || echo "sync> $summary"
}

deps_one() {
	_deps_index=$1
	_deps_cfg=$2
	_deps_default=$3
	validate_transaction_target "$_deps_index" "$_deps_cfg" "$_deps_default" || return 1
	IFS= read -r _prepared_manifest <"$TRANSACTION_DIR/manifest.$_deps_index" || return 1
	cd "$svcdir" || return 1
	_result_key=$(printf '%s' "$_sync_service" | tr -c 'A-Za-z0-9._-' '_')
	maybe_deps "$SUBDIR" "$SYNCURL" "$CONVERGENCE_DIR/deps-$_result_key.json" "$_prepared_manifest"
}

UPLOAD_ATTEMPTS=${DEV_SYNC_FANOUT_ATTEMPTS:-3}
UPLOAD_RETRY_DELAY=${DEV_SYNC_FANOUT_RETRY_DELAY_SECONDS:-1}
UPLOAD_CONNECT_TIMEOUT=${DEV_SYNC_UPLOAD_CONNECT_TIMEOUT_SECONDS:-5}
UPLOAD_TIMEOUT=${DEV_SYNC_UPLOAD_TIMEOUT_SECONDS:-120}
for _value in "$UPLOAD_ATTEMPTS" "$UPLOAD_RETRY_DELAY" "$UPLOAD_CONNECT_TIMEOUT" "$UPLOAD_TIMEOUT"; do
	case "$_value" in
		""|*[!0-9]*) echo "fanout configuration must use whole seconds/counts" >&2; exit 1 ;;
	esac
done
if [ "$UPLOAD_ATTEMPTS" -lt 1 ] || [ "$UPLOAD_CONNECT_TIMEOUT" -lt 1 ] || [ "$UPLOAD_TIMEOUT" -lt 1 ]; then
	echo "fanout requires attempts>=1 and upload timeouts>=1" >&2
	exit 1
fi

if [ -L "$TRANSACTION_DIR" ]; then
	echo "sync transaction path must not be a symbolic link" >&2
	exit 1
fi
if [ -d "$TRANSACTION_DIR" ] && [ "${DEV_SYNC_REBASE_PENDING:-}" = "1" ]; then
	if [ -n "${DEV_SYNC_GENERATION:-${SYNC_GENERATION:-}}" ]; then
		echo "pending rebase requires an unpinned fresh generation" >&2
		exit 1
	fi
	echo "sync transaction: rebasing pending generation onto the current checkout" >&2
	rm -rf "$TRANSACTION_DIR"
fi

if [ -d "$TRANSACTION_DIR" ]; then
	IFS= read -r _phase <"$TRANSACTION_DIR/phase" || _phase=""
	IFS= read -r SYNC_GENERATION_VALUE <"$TRANSACTION_DIR/generation" || SYNC_GENERATION_VALUE=""
	IFS= read -r _transaction_count <"$TRANSACTION_DIR/count" || _transaction_count=""
	if [ "$_phase" != "ready" ] || [ "$_transaction_count" != "$CONFIG_COUNT" ] || \
		! python3 -c 'import re, sys; raise SystemExit(0 if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", sys.argv[1]) else 1)' "$SYNC_GENERATION_VALUE"; then
		echo "pending sync transaction is incomplete or does not match the current service set" >&2
		exit 1
	fi
	_requested_generation=${DEV_SYNC_GENERATION:-${SYNC_GENERATION:-}}
	if [ -n "$_requested_generation" ] && [ "$_requested_generation" != "$SYNC_GENERATION_VALUE" ]; then
		echo "pending generation $SYNC_GENERATION_VALUE conflicts with requested generation $_requested_generation" >&2
		exit 1
	fi
	echo "sync transaction: recovering generation=$SYNC_GENERATION_VALUE services=$CONFIG_COUNT"
else
	for _stale in "$TRANSACTION_DIR".prepare.*; do
		[ -d "$_stale" ] && rm -rf "$_stale"
	done
	SYNC_GENERATION_VALUE=${DEV_SYNC_GENERATION:-${SYNC_GENERATION:-}}
	if [ -z "$SYNC_GENERATION_VALUE" ]; then
		if [ -r /proc/sys/kernel/random/uuid ]; then
			IFS= read -r SYNC_GENERATION_VALUE </proc/sys/kernel/random/uuid
		else
			SYNC_GENERATION_VALUE="sync-$(date -u +%Y%m%dT%H%M%S 2>/dev/null)-$$"
		fi
	fi
	if ! python3 -c 'import re, sys; raise SystemExit(0 if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", sys.argv[1]) else 1)' "$SYNC_GENERATION_VALUE"; then
		echo "invalid sync generation" >&2
		exit 1
	fi
	PREPARING_DIR=$(mktemp -d "$TRANSACTION_DIR.prepare.XXXXXX") || exit 1
	chmod 700 "$PREPARING_DIR"
	_prepare_index=0
	_prepare_ok=1
	for _cfg in $CONFIGS; do
		_prepare_default=$(basename "$_cfg")
		[ "$_cfg" = "$ENV_FILE" ] && _prepare_default=""
		prepare_one "$_prepare_index" "$_cfg" "$_prepare_default" || _prepare_ok=0
		_prepare_index=$((_prepare_index + 1))
	done
	if [ "$_prepare_ok" -ne 1 ]; then
		echo "sync transaction preparation failed before any receiver was mutated" >&2
		exit 1
	fi
	printf '%s\n' "$SYNC_GENERATION_VALUE" >"$PREPARING_DIR/generation"
	printf '%s\n' "$CONFIG_COUNT" >"$PREPARING_DIR/count"
	printf '%s\n' ready >"$PREPARING_DIR/phase"
	mv "$PREPARING_DIR" "$TRANSACTION_DIR" || exit 1
	PREPARING_DIR=""
	echo "sync transaction: prepared generation=$SYNC_GENERATION_VALUE services=$CONFIG_COUNT"
fi

_fanout_ok=0
_attempt=1
while [ "$_attempt" -le "$UPLOAD_ATTEMPTS" ]; do
	echo "sync transaction: fanout attempt=$_attempt/$UPLOAD_ATTEMPTS generation=$SYNC_GENERATION_VALUE"
	_round_ok=1
	_index=0
	for _cfg in $CONFIGS; do
		_default_service=$(basename "$_cfg")
		[ "$_cfg" = "$ENV_FILE" ] && _default_service=""
		upload_one "$_index" "$_attempt" "$_cfg" "$_default_service" || _round_ok=0
		_index=$((_index + 1))
	done
	if [ "$_round_ok" -eq 1 ]; then
		_fanout_ok=1
		break
	fi
	_attempt=$((_attempt + 1))
	if [ "$_attempt" -le "$UPLOAD_ATTEMPTS" ] && [ "$UPLOAD_RETRY_DELAY" -gt 0 ]; then
		sleep "$UPLOAD_RETRY_DELAY"
	fi
done

if [ "$_fanout_ok" -eq 1 ]; then
	_index=0
	for _cfg in $CONFIGS; do
		_default_service=$(basename "$_cfg")
		[ "$_cfg" = "$ENV_FILE" ] && _default_service=""
		deps_one "$_index" "$_cfg" "$_default_service" || rc=1
		_index=$((_index + 1))
	done
else
	rc=1
fi

# Check one service's receiver generation and application health concurrently.
# The caller launches this function once per service, so a slow service cannot
# serialize the rest of the round.
convergence_check_one() {
	_cfg=$1
	_default_service=$2
	_diag=$3
	SUBDIR="" SYNCURL="" HEALTHURL="" SYNC_TOKEN="" SERVICE=""
	# shellcheck disable=SC1090
	. "$_cfg"
	_check_service=$SERVICE
	[ -n "$_check_service" ] || _check_service=$_default_service
	if [ -z "$_check_service" ]; then
		if [ "${SUBDIR:-.}" = "." ]; then
			_check_service=workflow-builder
		else
			_check_service=${SUBDIR##*/}
		fi
	fi
	case "$SYNCURL" in
		*/__sync) _status_url=${SYNCURL%/__sync}/__status ;;
		*)
			printf '%s: status=invalid SYNCURL; health=not checked\n' "$_check_service" >"$_diag"
			return 1
			;;
	esac
	case "$HEALTHURL" in
		http://*|https://*) ;;
		*)
			printf '%s: status=not checked; health=invalid HEALTHURL\n' "$_check_service" >"$_diag"
			return 1
			;;
	esac
	if [ -z "$SYNC_TOKEN" ]; then
		printf '%s: status=missing sync capability; health=not checked\n' "$_check_service" >"$_diag"
		return 1
	fi

	(
		_status_code=$(curl -sS -o "$_diag.status.json" -w '%{http_code}' \
			--connect-timeout "$CONVERGENCE_REQUEST_TIMEOUT_CURRENT" \
			--max-time "$CONVERGENCE_REQUEST_TIMEOUT_CURRENT" \
			-H "x-sync-token: $SYNC_TOKEN" "$_status_url" 2>"$_diag.status.err")
		_status_exit=$?
		printf '%s\n' "$_status_code" >"$_diag.status.code"
		printf '%s\n' "$_status_exit" >"$_diag.status.exit"
	) &
	_status_pid=$!
	(
		_health_code=$(curl -sS -o /dev/null -w '%{http_code}' \
			--connect-timeout "$CONVERGENCE_REQUEST_TIMEOUT_CURRENT" \
			--max-time "$CONVERGENCE_REQUEST_TIMEOUT_CURRENT" \
			"$HEALTHURL" 2>"$_diag.health.err")
		_health_exit=$?
		printf '%s\n' "$_health_code" >"$_diag.health.code"
		printf '%s\n' "$_health_exit" >"$_diag.health.exit"
	) &
	_health_pid=$!
	wait "$_status_pid"
	wait "$_health_pid"

	IFS= read -r _status_code <"$_diag.status.code"
	IFS= read -r _status_exit <"$_diag.status.exit"
	IFS= read -r _health_code <"$_diag.health.code"
	IFS= read -r _health_exit <"$_diag.health.exit"

	_status_ok=1
	if [ "$_status_exit" -eq 0 ]; then
		_status_detail=$(python3 - "$_diag.status.json" "$SYNC_GENERATION_VALUE" "$_check_service" "$_status_code" <<'PY_STATUS'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        payload = json.load(handle)
except (OSError, UnicodeError, json.JSONDecodeError):
    payload = None
generation = payload.get("generation") if isinstance(payload, dict) else None
service = payload.get("syncService") if isinstance(payload, dict) else None
ok = (
    sys.argv[4] == "200"
    and isinstance(payload, dict)
    and payload.get("ok") is True
    and generation == sys.argv[2]
    and service == sys.argv[3]
)
print(f"http={sys.argv[4]} generation={generation!r} syncService={service!r}")
raise SystemExit(0 if ok else 1)
PY_STATUS
		)
		_status_ok=$?
	else
		_status_detail="curl-exit=$_status_exit http=$_status_code"
	fi

	_health_ok=1
	case "$_health_exit:$_health_code" in
		0:2??|0:3??) _health_detail="http=$_health_code" ;;
		0:*)
			_health_ok=0
			_health_detail="http=$_health_code"
			;;
		*)
			_health_ok=0
			_health_detail="curl-exit=$_health_exit http=$_health_code"
			;;
	esac
	printf '%s: status=%s; health=%s\n' \
		"$_check_service" "$_status_detail" "$_health_detail" >"$_diag"
	[ "$_status_ok" -eq 0 ] && [ "$_health_ok" -eq 1 ]
}

# Only a complete upload/dependency fanout is eligible to converge. This is an
# observation barrier, not rollback or transaction coordination.
if [ "$rc" -eq 0 ]; then
	CONVERGENCE_TIMEOUT=${DEV_SYNC_CONVERGENCE_TIMEOUT_SECONDS:-300}
	CONVERGENCE_SETTLE=${DEV_SYNC_CONVERGENCE_SETTLE_SECONDS:-1}
	CONVERGENCE_INTERVAL=${DEV_SYNC_CONVERGENCE_POLL_INTERVAL_SECONDS:-1}
	CONVERGENCE_REQUEST_TIMEOUT=${DEV_SYNC_CONVERGENCE_REQUEST_TIMEOUT_SECONDS:-5}
	CONVERGENCE_SUCCESS_ROUNDS=${DEV_SYNC_CONVERGENCE_SUCCESS_ROUNDS:-2}
	for _value in "$CONVERGENCE_TIMEOUT" "$CONVERGENCE_SETTLE" \
		"$CONVERGENCE_INTERVAL" "$CONVERGENCE_REQUEST_TIMEOUT" \
		"$CONVERGENCE_SUCCESS_ROUNDS"; do
		case "$_value" in
			""|*[!0-9]*)
				echo "convergence configuration must use whole seconds/counts" >&2
				rc=1
				break
				;;
		esac
	done
	if [ "$rc" -eq 0 ] && {
		[ "$CONVERGENCE_TIMEOUT" -lt 1 ] ||
			[ "$CONVERGENCE_REQUEST_TIMEOUT" -lt 1 ] ||
			[ "$CONVERGENCE_SETTLE" -ge "$CONVERGENCE_TIMEOUT" ] ||
			[ "$CONVERGENCE_SUCCESS_ROUNDS" -lt 2 ];
	}; then
		echo "convergence requires timeout>=1, settle<timeout, request-timeout>=1, successes>=2" >&2
		rc=1
	fi

	CONVERGENCE_CONFIGS=""
	if [ "$rc" -eq 0 ] && [ -d "$ENV_DIR" ] && [ -n "$(ls -A "$ENV_DIR" 2>/dev/null)" ]; then
		for _cfg in "$ENV_DIR"/*; do
			[ -f "$_cfg" ] && CONVERGENCE_CONFIGS="$CONVERGENCE_CONFIGS $_cfg"
		done
	elif [ "$rc" -eq 0 ] && [ -f "$ENV_FILE" ]; then
		CONVERGENCE_CONFIGS=" $ENV_FILE"
	fi
	if [ "$rc" -eq 0 ] && [ -z "$CONVERGENCE_CONFIGS" ]; then
		echo "convergence has no service configs" >&2
		rc=1
	fi

	if [ "$rc" -eq 0 ]; then
		_deadline=$(($(date +%s) + CONVERGENCE_TIMEOUT))
		[ "$CONVERGENCE_SETTLE" -eq 0 ] || sleep "$CONVERGENCE_SETTLE"
		_consecutive=0
		_round=0
		_target_count=0
		for _cfg in $CONVERGENCE_CONFIGS; do _target_count=$((_target_count + 1)); done

		while [ "$(date +%s)" -lt "$_deadline" ]; do
			_round=$((_round + 1))
			_remaining=$((_deadline - $(date +%s)))
			CONVERGENCE_REQUEST_TIMEOUT_CURRENT=$CONVERGENCE_REQUEST_TIMEOUT
			if [ "$CONVERGENCE_REQUEST_TIMEOUT_CURRENT" -gt "$_remaining" ]; then
				CONVERGENCE_REQUEST_TIMEOUT_CURRENT=$_remaining
			fi
			[ "$CONVERGENCE_REQUEST_TIMEOUT_CURRENT" -gt 0 ] || break

			_pids=""
			_index=0
			for _cfg in $CONVERGENCE_CONFIGS; do
				_default_service=$(basename "$_cfg")
				[ "$_cfg" = "$ENV_FILE" ] && _default_service=""
				_diag="$CONVERGENCE_DIR/$_index.diag"
				convergence_check_one "$_cfg" "$_default_service" "$_diag" &
				_pids="$_pids $!"
				_index=$((_index + 1))
			done
			_all_healthy=1
			for _pid in $_pids; do
				wait "$_pid" || _all_healthy=0
			done
			if [ "$_all_healthy" -eq 1 ]; then
				_consecutive=$((_consecutive + 1))
				echo "convergence: generation=$SYNC_GENERATION_VALUE round=$_round all=$_target_count healthy ($_consecutive/$CONVERGENCE_SUCCESS_ROUNDS)"
				if [ "$_consecutive" -ge "$CONVERGENCE_SUCCESS_ROUNDS" ]; then
					break
				fi
			else
				_consecutive=0
			fi
			[ "$(date +%s)" -lt "$_deadline" ] || break
			[ "$CONVERGENCE_INTERVAL" -eq 0 ] || sleep "$CONVERGENCE_INTERVAL"
		done

		if [ "$_consecutive" -lt "$CONVERGENCE_SUCCESS_ROUNDS" ]; then
			echo "convergence failed: generation=$SYNC_GENERATION_VALUE did not stabilize across $_target_count service(s) within ${CONVERGENCE_TIMEOUT}s" >&2
			for _diag in "$CONVERGENCE_DIR"/*.diag; do
				[ -f "$_diag" ] && sed 's/^/  /' "$_diag" >&2
			done
			rc=1
		fi
	fi
else
	echo "convergence skipped: source/dependency fanout did not complete" >&2
fi

if [ "$rc" -eq 0 ]; then
	rm -rf "$TRANSACTION_DIR"
	echo "SYNCED generation=$SYNC_GENERATION_VALUE services=$CONFIG_COUNT convergence=healthy"
else
	echo "sync transaction pending: generation=$SYNC_GENERATION_VALUE; rerun sync.sh to replay the immutable fanout (later edits are deferred)" >&2
fi
exit $rc
