#!/usr/bin/env bash
# Boot the workflow-builder BFF in the lite profile: embedded PGlite (no cluster,
# no DB server), in-process. On a fresh data dir it builds the schema.ts head
# with drizzle-kit push, mints a dev RSA keypair, and seeds a user/project/
# workflow so password sign-in works end-to-end.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_DIR=".pglite-data"
KEY_DIR=".pglite-keys"
PRIV="$KEY_DIR/jwt-private.pem"
PUB="$KEY_DIR/jwt-public.pem"

# Dev signing keypair (RS256, PKCS8/SPKI) — only used to make lite sign-in work.
if [ ! -f "$PRIV" ]; then
  if command -v openssl >/dev/null 2>&1; then
    mkdir -p "$KEY_DIR"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PRIV" 2>/dev/null
    openssl pkey -in "$PRIV" -pubout -out "$PUB" 2>/dev/null
    echo "[dev:lite] minted dev JWT keypair in $KEY_DIR/"
  else
    echo "[dev:lite] openssl not found — sign-in will 302-redirect (set JWT_SIGNING_KEY to enable it)"
  fi
fi

# Build schema + seed on a fresh data dir. PGlite is single-process, so each of
# these steps opens/closes the data dir in turn, before the server does.
# push must start from a truly-empty dir (else it prompts for a TTY) — remove
# any half-built dir on failure so the next run retries clean.
if [ ! -d "$DATA_DIR" ]; then
  echo "[dev:lite] building schema (drizzle-kit push) into $DATA_DIR"
  drizzle-kit push --config drizzle.config.lite.ts --force || { rm -rf "$DATA_DIR"; exit 1; }
  echo "[dev:lite] seeding $DATA_DIR"
  if [ -f "$PUB" ]; then
    SEED_JWT_PUBLIC_KEY="$(cat "$PUB")" tsx scripts/seed-lite.ts
  else
    tsx scripts/seed-lite.ts
  fi
fi

export APP_PROFILE=lite
# Lite runs off-cluster with no OTLP collector — disable the OTEL SDK so boots
# don't spew exporter-connection-refused noise (the tracing.py-equivalent
# neutralization the in-cluster deploy does).
export OTEL_SDK_DISABLED=true
if [ -f "$PRIV" ]; then
  export JWT_SIGNING_KEY="$(cat "$PRIV")"
fi

exec vite dev "$@"
