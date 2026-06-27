# Tiny, dependency-free live-sync receiver sidecar for per-run dev previews.
# node:22-alpine gives a busybox `tar` (the -o flag, leading-/ strip) — the same
# tar semantics the workflow-builder Vite /__sync plugin relies on.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
ENV DEV_SYNC_PORT=8001 \
    DEV_SYNC_DEST=/app
EXPOSE 8001
CMD ["node", "server.mjs"]
