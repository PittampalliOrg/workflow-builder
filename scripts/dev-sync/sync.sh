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

# One logical generation spans the ENTIRE fanout. Callers may pin it for a
# larger transaction; otherwise generate it once before reading any service
# config so every /__sync in this invocation carries the same value.
SYNC_GENERATION_VALUE=${DEV_SYNC_GENERATION:-${SYNC_GENERATION:-}}
if [ -z "$SYNC_GENERATION_VALUE" ]; then
	if [ -r /proc/sys/kernel/random/uuid ]; then
		IFS= read -r SYNC_GENERATION_VALUE </proc/sys/kernel/random/uuid
	else
		SYNC_GENERATION_VALUE="sync-$(date -u +%Y%m%dT%H%M%S 2>/dev/null)-$$"
	fi
fi

rc=0
CONVERGENCE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dev-sync-convergence.XXXXXX") || exit 1
chmod 700 "$CONVERGENCE_DIR"
trap 'rm -rf "$CONVERGENCE_DIR"' 0

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
	newhash=$(manifest_hash)
	[ -n "$newhash" ] || return 0
	state="$WORK/.syncdeps.$(printf '%s' "$_subdir" | tr '/.' '__')"
	oldhash=""
	[ -f "$state" ] && oldhash=$(cat "$state" 2>/dev/null)
	if [ -n "$oldhash" ] && [ "$newhash" = "$oldhash" ]; then
		return 0
	fi
	runurl=$(printf '%s' "$_syncurl" | sed 's#/__sync$#/__run#')
	echo "deps: manifest changed for $_subdir → POST $runurl?cmd=deps"
	code=$(curl -s -o /tmp/dev-sync-deps.out -w '%{http_code}' -X POST \
		${SYNC_TOKEN:+-H "x-sync-token: $SYNC_TOKEN"} "$runurl?cmd=deps" 2>/dev/null)
	if [ "$code" = "404" ]; then
		echo "deps: no deps command configured for this service (skip)"
		printf '%s' "$newhash" >"$state"
		return 0
	fi
	sed 's/^/deps> /' /tmp/dev-sync-deps.out 2>/dev/null
	echo "deps: /__run?cmd=deps → HTTP $code"
	if [ "$code" != "200" ] || ! python3 -c 'import json, sys; data = json.load(open(sys.argv[1], encoding="utf-8")); exit_code = data.get("exitCode") if isinstance(data, dict) else None; sys.exit(0 if isinstance(data, dict) and data.get("ok") is True and (0 if exit_code is None or exit_code is False else exit_code) == 0 else 1)' \
		/tmp/dev-sync-deps.out >/dev/null 2>&1; then
		echo "deps: install failed for $_subdir; leaving the prior manifest baseline for retry" >&2
		rc=1
		return 1
	fi
	# Advance the baseline only after the in-pod dependency action really passed.
	printf '%s' "$newhash" >"$state"
}

# Sync one service. Reads SUBDIR/PATHS/SYNCURL/EXTRASYNC/SYNC_TOKEN from the env.
sync_one() {
	_config_service=${1:-}
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
		rc=1
		return
	fi
	if [ -z "$HEALTHURL" ]; then
		echo "skip: no HEALTHURL for $SUBDIR"
		rc=1
		return
	fi
	svcdir="$REPO/$SUBDIR"
	if [ ! -d "$svcdir" ]; then
		echo "skip: repo dir not found: $svcdir"
		rc=1
		return
	fi
	cd "$svcdir" || {
		rc=1
		return
	}

	# The service catalog is the receiver authority. Declare its complete root set
	# on every upload; a declared root absent from the archive is an intentional
	# deletion, so stale files cannot survive under a new generation.
	declared_roots=$(
		for p in $PATHS; do printf '%s\n' "$p"; done
		for pair in $EXTRASYNC; do
			eto=${pair#*:}
			[ -n "$eto" ] && printf '%s\n' "$eto"
		done
	) || {
		rc=1
		return
	}
	declared_roots_json=$(printf '%s\n' "$declared_roots" | python3 -c 'import json, sys; print(json.dumps(sorted(set(filter(None, (line.rstrip("\n") for line in sys.stdin)))), separators=(",", ":")))') || {
		echo "invalid sync roots for $SUBDIR" >&2
		rc=1
		return
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
	archive="/tmp/dev-sync-$$.tgz"
	if [ -n "$syncpaths" ]; then
		# shellcheck disable=SC2086
		tar -czf "$archive" $syncpaths
	else
		tar -czf "$archive" -T /dev/null
	fi || {
		echo "tar failed for $SUBDIR"
		rc=1
		return
	}
	code=$(curl -s -o /tmp/dev-sync.out -w '%{http_code}' -X POST \
		--data-binary @"$archive" -H 'content-type: application/gzip' \
		-H "x-sync-generation: $SYNC_GENERATION_VALUE" \
		-H "x-sync-service: $_sync_service" \
		-H "x-sync-roots: $declared_roots_json" \
		${SYNC_TOKEN:+-H "x-sync-token: $SYNC_TOKEN"} "$SYNCURL" 2>/dev/null)
	rm -f "$archive"
	echo "SYNCED $SUBDIR → HTTP $code (service=$_sync_service generation=$SYNC_GENERATION_VALUE)"
	if [ "$code" != "200" ]; then
		sed 's/^/sync> /' /tmp/dev-sync.out 2>/dev/null
		rc=1
		return
	fi

	maybe_deps "$SUBDIR" "$SYNCURL"
}

# Multi-service fan-out (.syncenv.d/*) if present, else the single-service .syncenv.
if [ -d "$ENV_DIR" ] && [ -n "$(ls -A "$ENV_DIR" 2>/dev/null)" ]; then
	for cfg in "$ENV_DIR"/*; do
		[ -f "$cfg" ] || continue
		# Reset per-service so a value from a prior file never leaks forward.
		SUBDIR="" PATHS="" SYNCURL="" HEALTHURL="" EXTRASYNC="" SYNC_TOKEN="" SERVICE=""
		# shellcheck disable=SC1090
		. "$cfg"
		sync_one "$(basename "$cfg")"
	done
elif [ -f "$ENV_FILE" ]; then
	SUBDIR="" PATHS="" SYNCURL="" HEALTHURL="" EXTRASYNC="" SYNC_TOKEN="" SERVICE=""
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	sync_one ""
else
	echo "no sync config: neither $ENV_DIR/* nor $ENV_FILE exists"
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
exit $rc
