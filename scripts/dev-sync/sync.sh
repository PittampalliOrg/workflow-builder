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

# Trigger an in-pod dep reinstall iff the manifest hash changed since last run.
# First run records the baseline WITHOUT installing (the dev image's baked deps
# match the cloned manifest for a main-clone); a subsequent manifest edit installs.
maybe_deps() {
	_subdir="$1"
	_syncurl="$2"
	newhash=$(manifest_hash)
	[ -n "$newhash" ] || return 0
	state="$WORK/.syncdeps.$(printf '%s' "$_subdir" | tr '/.' '__')"
	oldhash=""
	[ -f "$state" ] && oldhash=$(cat "$state" 2>/dev/null)
	if [ -z "$oldhash" ]; then
		printf '%s' "$newhash" >"$state"
		echo "deps: baseline recorded for $_subdir (no install on first sync)"
		return 0
	fi
	if [ "$newhash" = "$oldhash" ]; then
		return 0
	fi
	runurl=$(printf '%s' "$_syncurl" | sed 's#/__sync$#/__run#')
	echo "deps: manifest changed for $_subdir → POST $runurl?cmd=deps"
	code=$(curl -s -o /tmp/dev-sync-deps.out -w '%{http_code}' -X POST \
		${SYNC_TOKEN:+-H "x-sync-token: $SYNC_TOKEN"} "$runurl?cmd=deps" 2>/dev/null)
	if [ "$code" = "404" ]; then
		echo "deps: no deps command configured for this service (skip)"
	else
		sed 's/^/deps> /' /tmp/dev-sync-deps.out 2>/dev/null
		echo "deps: /__run?cmd=deps → HTTP $code"
	fi
	# Record the new baseline regardless (avoid re-installing the same change).
	printf '%s' "$newhash" >"$state"
}

# Sync one service. Reads SUBDIR/PATHS/SYNCURL/EXTRASYNC/SYNC_TOKEN from the env.
sync_one() {
	: "${SUBDIR:=.}"
	: "${PATHS:=src}"
	: "${SYNCURL:=}"
	: "${EXTRASYNC:=}"
	: "${SYNC_TOKEN:=}"
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

	# Stage extraSync sources (from rel to SUBDIR → to rel to tar root). Copy the
	# CONTENTS of `from` into `to` so `to/<...>` mirrors `from/<...>`.
	staged=""
	for pair in $EXTRASYNC; do
		efrom=${pair%%:*}
		eto=${pair#*:}
		if [ -e "$svcdir/$efrom" ] && [ -n "$eto" ]; then
			rm -rf "${svcdir:?}/$eto"
			mkdir -p "$svcdir/$eto"
			cp -a "$svcdir/$efrom/." "$svcdir/$eto/" 2>/dev/null
			staged="$staged $eto"
			echo "staged extraSync $efrom → $eto"
		fi
	done

	# Collect the paths that actually exist (sync + export both tolerate absentees,
	# but tarring a missing member fails the archive).
	syncpaths=""
	for p in $PATHS $staged; do
		[ -e "$p" ] && syncpaths="$syncpaths $p"
	done
	if [ -z "$syncpaths" ]; then
		echo "skip: nothing to sync under $svcdir ($PATHS)"
		return
	fi

	# shellcheck disable=SC2086
	tar -czf /tmp/dev-sync.tgz $syncpaths || {
		echo "tar failed for $SUBDIR"
		rc=1
		return
	}
	code=$(curl -s -o /tmp/dev-sync.out -w '%{http_code}' -X POST \
		--data-binary @/tmp/dev-sync.tgz -H 'content-type: application/gzip' \
		${SYNC_TOKEN:+-H "x-sync-token: $SYNC_TOKEN"} "$SYNCURL" 2>/dev/null)
	echo "SYNCED $SUBDIR → HTTP $code"
	if [ "$code" != "200" ]; then
		sed 's/^/sync> /' /tmp/dev-sync.out 2>/dev/null
		rc=1
	fi

	maybe_deps "$SUBDIR" "$SYNCURL"
}

# Multi-service fan-out (.syncenv.d/*) if present, else the single-service .syncenv.
if [ -d "$ENV_DIR" ] && [ -n "$(ls -A "$ENV_DIR" 2>/dev/null)" ]; then
	for cfg in "$ENV_DIR"/*; do
		[ -f "$cfg" ] || continue
		# Reset per-service so a value from a prior file never leaks forward.
		SUBDIR="" PATHS="" SYNCURL="" EXTRASYNC="" SYNC_TOKEN=""
		# shellcheck disable=SC1090
		. "$cfg"
		sync_one
	done
elif [ -f "$ENV_FILE" ]; then
	SUBDIR="" PATHS="" SYNCURL="" EXTRASYNC="" SYNC_TOKEN=""
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	sync_one
else
	echo "no sync config: neither $ENV_DIR/* nor $ENV_FILE exists"
	rc=1
fi

exit $rc
