# Thin wrapper around @playwright/mcp, running in streamable-http transport
# mode so Nimble Tools' MCPService pattern can host it the same way it
# hosts our Activepieces piece servers. Agents reach it at
# http://playwright-mcp.workflow-builder.svc.cluster.local:3100/mcp.
#
# Architecture: this pod runs ONLY the MCP server — no embedded browser.
# The browser (Chromium) runs in a separate chrome-sandbox pod
# (registry.k8s.io/chrome-sandbox, from the K8s SIGs agent-sandbox
# project) which is purpose-built for unprivileged containers. Playwright
# MCP connects to that browser via its CDP debugging port (9222).
#
# This avoids the chrome_crashpad_handler: --database is required
# crash that kills @playwright/mcp's own browser launch under our
# readOnlyRootFilesystem + non-root securityContext.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3100 \
    HOME=/tmp \
    npm_config_cache=/tmp/npm-cache \
    XDG_CACHE_HOME=/tmp/cache \
    XDG_CONFIG_HOME=/tmp/config \
    XDG_DATA_HOME=/tmp/data

WORKDIR /app

# Install ONLY @playwright/mcp — no browser needed since we use an
# external Chrome via CDP.
COPY services/playwright-mcp-gateway/package.json ./
COPY services/playwright-mcp-gateway/pnpm-lock.yaml ./
RUN corepack enable \
 && pnpm install --prod --frozen-lockfile \
 && pnpm store prune \
 && rm -rf /tmp/npm-cache /root/.npm /root/.local/share/pnpm/store \
 && mkdir -p /tmp/cache /tmp/config /tmp/data \
 && chown -R 1000:1000 /app /tmp/cache /tmp/config /tmp/data

USER 1000
EXPOSE 3100

ENTRYPOINT ["node", "/app/node_modules/@playwright/mcp/cli.js"]
# --cdp-endpoint: connect to the external chrome-sandbox pod via its
# CDP URL. The agent-sandbox chrome-sandbox image exposes Chromium
# debugging on port 9222.
# --allowed-hosts '*': disables the host header check so cluster DNS
# names reach the MCP server.
CMD ["--port", "3100", \
     "--host", "0.0.0.0", \
     "--allowed-hosts", "*", \
     "--output-dir", "/tmp/playwright-mcp-output", \
     "--cdp-endpoint", "http://chrome-sandbox-service.workflow-builder.svc.cluster.local:9222"]
