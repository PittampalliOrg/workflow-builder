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
    npm_config_cache=/tmp/npm-cache

WORKDIR /app

# Install @playwright/mcp + Chrome channel (not Chromium). Chrome ships a
# pre-configured crashpad_handler + database directory so it launches cleanly
# without CAP_SYS_ADMIN. Chromium 1217 spawns crashpad_handler without a
# --database flag and crashes with "--database is required" regardless of
# --disable-breakpad / --no-sandbox. Using the Chrome channel is the most
# reliable fix.
RUN npm install -g @playwright/mcp@latest \
 && npx --yes playwright install --with-deps chrome \
 && rm -rf /tmp/npm-cache /root/.npm \
 && chown -R 1000:1000 /app

USER 1000
EXPOSE 3100

# Resolve the installed binary directly — `npx` at runtime would re-hit the
# npm registry and fail inside restricted network namespaces. The globally
# installed shim lives at /usr/bin/mcp-server-playwright (playwright base
# image has npm's global bin symlinked there).
ENTRYPOINT ["playwright-mcp"]
# --allowed-hosts '*' disables the built-in host header check so cluster DNS
# names (playwright-mcp-service.workflow-builder.svc.cluster.local) reach
# the server; otherwise it 403s everything except localhost.
# --browser chrome: use the stable Chrome channel — its crashpad_handler is
# pre-configured so the process launches cleanly in unprivileged containers.
# --no-sandbox: Chrome's setuid sandbox still requires CAP_SYS_ADMIN we
# don't grant.
CMD ["--port", "3100", "--host", "0.0.0.0", "--headless", "--isolated", "--allowed-hosts", "*", "--browser", "chrome", "--no-sandbox"]
