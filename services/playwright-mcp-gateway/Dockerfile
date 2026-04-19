# Thin wrapper around @playwright/mcp, running in streamable-http transport
# mode so Nimble Tools' MCPService pattern can host it the same way it
# hosts our Activepieces piece servers. Agents reach it at
# http://playwright-mcp.workflow-builder.svc.cluster.local:3100/mcp.
#
# Why not use mcr.microsoft.com/playwright/mcp directly: that image's
# default CMD is stdio. Nimble's MCPService CRD has no `command` override,
# so we need an image whose ENTRYPOINT launches HTTP on 3100 with no args.

FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV NODE_ENV=production \
    PORT=3100 \
    HOME=/app \
    npm_config_cache=/tmp/npm-cache

WORKDIR /app

# Install the MCP server globally + Chromium. Run once at build time so the
# runtime container has zero network dependency on npm / browsers.
RUN npm install -g @playwright/mcp@latest \
 && npx --yes playwright install --with-deps chromium \
 && rm -rf /tmp/npm-cache /root/.npm \
 && chown -R 1000:1000 /app

USER 1000
EXPOSE 3100

# Resolve the installed binary directly — `npx` at runtime would re-hit the
# npm registry and fail inside restricted network namespaces. The globally
# installed shim lives at /usr/bin/mcp-server-playwright (playwright base
# image has npm's global bin symlinked there).
ENTRYPOINT ["playwright-mcp"]
CMD ["--port", "3100", "--host", "0.0.0.0", "--headless", "--isolated"]
