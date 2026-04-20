# chrome-sandbox: Chromium running on a visible X display inside an
# unprivileged container, exposing the Chrome DevTools Protocol (CDP) on
# :9222 for Playwright MCP to connect to.
#
# Inherits from openshell-sandbox so the runtime matches the rest of the
# sandbox fleet: same base user (`sandbox`), same Playwright-ready
# system deps (fonts-liberation, libnss3, libgbm1, xvfb, etc.), and
# same /opt/pw-browsers/chromium that OpenShell's browser-research
# environment already uses. Sandbox CRD admission puts this image on
# equal footing with other OpenShell sandboxes for capabilities.
#
# On top of that we add:
#   * Xtigervnc + x11-utils for a visible display on :1 (port 5901)
#   * A Go-compiled entrypoint (vendored from k8s-sigs/agent-sandbox)
#     that starts VNC -> Chromium in sequence and waits for both to be
#     ready before returning.
#   * A start-chrome script that passes --remote-debugging-port=9222 to
#     Chromium so the CDP endpoint is exposed.

# Global ARG for the runtime stage's base image. Must be declared BEFORE
# the first FROM so both stages can reference it (Docker/Buildah scoping
# rule — otherwise buildah emits "no FROM statement found").
ARG BASE_IMAGE=gitea-ryzen.tail286401.ts.net/giteaadmin/openshell-sandbox:latest

# -------- Stage 1: compile the Go entrypoint --------
FROM docker.io/library/golang:1.26.2 AS builder

WORKDIR /src
COPY go.mod go.sum ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -o /chrome-sandbox-entrypoint ./cmd/chrome-sandbox-entrypoint

# -------- Stage 2: layer VNC + our entrypoint on openshell-sandbox --------
FROM ${BASE_IMAGE}

USER root

# Display + VNC export stack:
#   xvfb      virtual X framebuffer (display :1)
#   x11vnc    VNC server that exports the framebuffer on :5901. TigerVNC
#             was rejecting bgr888 SetPixelFormat requests from noVNC,
#             closing every browser live-view connection mid-handshake.
#   x11-utils xdpyinfo for the Go entrypoint's readiness probe.
#   nginx-light rewrites Host on cross-pod CDP traffic so Chromium's
#   DNS-rebinding guard accepts requests reaching us via a Service DNS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        x11-utils \
        xdg-utils \
        nginx-light \
    && rm -rf /var/lib/apt/lists/*

# Chromium from openshell-sandbox lives at /opt/pw-browsers/chromium-*/chrome.
# Symlink it to /usr/bin/chromium so start-chrome doesn't need to know the
# exact path / version suffix.
RUN set -eux; \
    CHROME_BIN=$(find /opt/pw-browsers -maxdepth 3 -name chrome -type f | head -n1); \
    if [ -z "$CHROME_BIN" ]; then echo "chromium not found under /opt/pw-browsers" >&2; exit 1; fi; \
    ln -sf "$CHROME_BIN" /usr/bin/chromium

# X11 socket dir
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Drop in the entrypoint + start-chrome wrapper + nginx CDP proxy config.
# nginx rewrites Host: -> localhost on inbound 9223 traffic so Chromium's
# DNS-rebinding guard accepts the connection from playwright-mcp-gateway
# (which reaches us via the k8s Service's DNS name).
COPY --chmod=0755 scripts/start-chrome /start-chrome
COPY --chmod=0644 scripts/nginx-cdp.conf /etc/nginx/nginx.conf
COPY --from=builder --chmod=0755 /chrome-sandbox-entrypoint /chrome-sandbox-entrypoint

# nginx writes pid + temp + log under /var; sandbox user can't touch those.
# Redirect everything under /tmp and make the runtime dirs world-writable
# (the image already drops to the non-root sandbox user below).
RUN set -eux; \
    mkdir -p /tmp/nginx /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi /tmp/nginx/log; \
    chmod -R 0777 /tmp/nginx; \
    rm -f /var/log/nginx/* 2>/dev/null || true; \
    chmod -R 0777 /var/log/nginx /var/lib/nginx 2>/dev/null || true

# OpenShell's sandbox user owns everything at runtime.
RUN chown -R sandbox:sandbox /home/sandbox 2>/dev/null || true

USER sandbox
WORKDIR /home/sandbox

# Expose CDP + VNC.
EXPOSE 9222 5901

ENTRYPOINT ["/chrome-sandbox-entrypoint"]
