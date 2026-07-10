# Tiny, dependency-free live-sync receiver sidecar for per-run dev previews.
# node:22-alpine gives a busybox `tar` (the -o flag, leading-/ strip) — the same
# tar semantics the workflow-builder Vite /__sync plugin relies on.
# The sidecar's own code lives at /sidecar (NOT the synced workdir): in the pod
# the shared emptyDir mounts at DEV_SYNC_DEST (the service workdir, e.g. /app) and
# would MASK the sidecar's code if it lived there. Run from /sidecar so the mount
# only affects the sync destination.
FROM node:22-alpine
WORKDIR /sidecar
COPY server.mjs /sidecar/server.mjs
COPY atomic-sync.mjs /sidecar/atomic-sync.mjs
RUN addgroup -g 1001 dev-sync \
    && adduser -D -u 1001 -G dev-sync dev-sync \
    && chown -R 1001:1001 /sidecar
ENV DEV_SYNC_PORT=8001 \
    DEV_SYNC_DEST=/app
EXPOSE 8001
USER 1001:1001
CMD ["node", "/sidecar/server.mjs"]
