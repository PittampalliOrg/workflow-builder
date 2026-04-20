# Thin wrapper around @playwright/mcp, running in streamable-http transport
# mode so Nimble Tools' MCPService pattern can host it the same way it
# hosts our Activepieces piece servers. Agents reach it at
# http://playwright-mcp.workflow-builder.svc.cluster.local:3100/mcp.
#
# Why not use mcr.microsoft.com/playwright/mcp directly: that image's
# default CMD is stdio. Nimble's MCPService CRD has no `command` override,
# so we need an image whose ENTRYPOINT launches HTTP on 3100 with no args.

# Align the bundled Playwright with @playwright/mcp@latest so the browser
# argv shape matches the Chromium revision being launched.
FROM mcr.microsoft.com/playwright:v1.56.0-noble

ENV NODE_ENV=production \
    PORT=3100 \
    HOME=/app \
    npm_config_cache=/tmp/npm-cache \
    XDG_CACHE_HOME=/tmp/cache \
    XDG_CONFIG_HOME=/tmp/config \
    XDG_DATA_HOME=/tmp/data

WORKDIR /app

# Firefox has no crashpad_handler spawn — Chromium/Chrome 138+ both
# exit at launch with "chrome_crashpad_handler: --database is required"
# when running under readOnlyRootFilesystem + unprivileged + --headless,
# and neither --disable-breakpad nor --no-sandbox suppresses the spawn.
# Firefox uses its own crash-reporter that's disabled cleanly in headless
# mode.
RUN npm install -g @playwright/mcp@latest \
 && npx --yes playwright install --with-deps firefox \
 && rm -rf /tmp/npm-cache /root/.npm \
 && chown -R 1000:1000 /app

USER 1000
EXPOSE 3100

# Resolve the installed binary directly — `npx` at runtime would re-hit the
# npm registry and fail inside restricted network namespaces. The globally
# installed shim lives at /usr/bin/mcp-server-playwright (playwright base
# image has npm's global bin symlinked there).
# Pre-create crashpad database dir in the writable /tmp volume so Chrome's
# crashpad_handler has somewhere to write on every launch. Without this,
# Chrome 138+ spawns chrome_crashpad_handler without a --database arg
# (known bug — issues.chromium.org/362306373) and exits with SIGTRAP.
RUN mkdir -p /tmp/crashdumps /tmp/cache /tmp/config /tmp/data

ENTRYPOINT ["playwright-mcp"]
# --allowed-hosts '*' disables the built-in host header check so cluster DNS
# names (playwright-mcp-service.workflow-builder.svc.cluster.local) reach
# the server; otherwise it 403s everything except localhost.
# --browser chrome: stable Chrome channel (Chromium crashes identically
# in this environment; Chrome is the documented baseline).
# --no-sandbox: setuid sandbox requires CAP_SYS_ADMIN we don't grant.
CMD ["--port", "3100", "--host", "0.0.0.0", "--headless", "--isolated", "--allowed-hosts", "*", "--browser", "firefox", "--no-sandbox"]
