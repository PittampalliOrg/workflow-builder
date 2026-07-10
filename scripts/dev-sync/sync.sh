#!/bin/sh
# dev-sync client — push edited source to a per-run dev preview and, on a
# dependency-manifest change, trigger an in-pod reinstall. Committed to the repo
# (not heredoc'd into the workflow fixture) so it is shellcheck- and unit-testable;
# the microservice-dev-session workflow clones the repo and copies this into
# /sandbox/work/sync.sh, then writes the per-service config it reads.
#
# Config is read from (whichever exists, in order):
#   $DEV_SYNC_ENV_DIR/*   — one file per service (multi-service fan-out), or
#   $DEV_SYNC_ENV         — a single service.
# Each config file sets:
#   SUBDIR     repo subdir whose source maps onto the dev pod workdir ("." = root)
#   PATHS      space-separated syncPaths (relative to SUBDIR) to tar + push
#   SYNCURL    the pod's /__sync URL (…:<syncPort>/__sync)
#   EXTRASYNC  optional: space-separated  from:to  pairs (from rel to SUBDIR, to rel
#              to the tar root/pod workdir) staged into the tar before it is built
#   SYNC_TOKEN optional: x-sync-token shared secret
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
	if [ "$code" != "200" ] || ! jq -e '.ok == true and ((.exitCode // 0) == 0)' \
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
	declared_roots_json=$(printf '%s\n' "$declared_roots" | jq -Rsc '
		split("\n") | map(select(length > 0)) | unique
	') || {
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
		SUBDIR="" PATHS="" SYNCURL="" EXTRASYNC="" SYNC_TOKEN="" SERVICE=""
		# shellcheck disable=SC1090
		. "$cfg"
		sync_one "$(basename "$cfg")"
	done
elif [ -f "$ENV_FILE" ]; then
	SUBDIR="" PATHS="" SYNCURL="" EXTRASYNC="" SYNC_TOKEN="" SERVICE=""
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	sync_one ""
else
	echo "no sync config: neither $ENV_DIR/* nor $ENV_FILE exists"
	rc=1
fi

exit $rc
