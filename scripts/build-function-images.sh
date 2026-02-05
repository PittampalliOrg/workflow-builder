#!/usr/bin/env bash
# Build and optionally push all serverless function images
# Usage: ./scripts/build-function-images.sh [--push]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY="${GITEA_REGISTRY:-gitea.cnoe.localtest.me:8443}"
ORG="${GITEA_ORG:-giteaadmin}"
PUSH_IMAGES=false

# Parse arguments
if [[ "${1:-}" == "--push" ]]; then
  PUSH_IMAGES=true
fi

echo "🏗️  Building serverless function images..."
echo "   Registry: $REGISTRY"
echo "   Organization: $ORG"
echo ""

# Find all function services
FUNCTION_SERVICES=($(ls -d "$PROJECT_ROOT/services/fn-"* 2>/dev/null | xargs -n1 basename || true))

if [ ${#FUNCTION_SERVICES[@]} -eq 0 ]; then
  echo "⚠️  No function services found in services/fn-*"
  exit 0
fi

echo "Found ${#FUNCTION_SERVICES[@]} function services:"
for svc in "${FUNCTION_SERVICES[@]}"; do
  echo "  - $svc"
done
echo ""

# Build each function
SUCCESS_COUNT=0
FAIL_COUNT=0

for SERVICE in "${FUNCTION_SERVICES[@]}"; do
  IMAGE_NAME="$REGISTRY/$ORG/$SERVICE:latest"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📦 Building: $SERVICE"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if docker build \
    -f "$PROJECT_ROOT/services/$SERVICE/Dockerfile" \
    -t "$IMAGE_NAME" \
    "$PROJECT_ROOT" 2>&1 | sed 's/^/  /'; then

    echo "✅ Built: $IMAGE_NAME"
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))

    if [ "$PUSH_IMAGES" = true ]; then
      echo "⬆️  Pushing: $IMAGE_NAME"
      if docker push "$IMAGE_NAME" 2>&1 | sed 's/^/  /'; then
        echo "✅ Pushed: $IMAGE_NAME"
      else
        echo "❌ Failed to push: $IMAGE_NAME"
        FAIL_COUNT=$((FAIL_COUNT + 1))
      fi
    fi
  else
    echo "❌ Failed to build: $SERVICE"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Success: $SUCCESS_COUNT"
if [ $FAIL_COUNT -gt 0 ]; then
  echo "❌ Failed:  $FAIL_COUNT"
fi
echo ""

if [ $FAIL_COUNT -gt 0 ]; then
  exit 1
fi

exit 0
