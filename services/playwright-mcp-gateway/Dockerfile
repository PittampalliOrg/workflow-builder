# Thin wrapper around @playwright/mcp, running in streamable-http transport
# mode so Nimble Tools' MCPService pattern can host it the same way it
# hosts our Activepieces piece servers. Agents reach it at
# http://playwright-mcp.workflow-builder.svc.cluster.local:3100/mcp.
#
# Why not use mcr.microsoft.com/playwright/mcp directly: that image's
# default CMD is stdio. Nimble's MCPService CRD has no `command` override,
# so we need an image whose ENTRYPOINT launches HTTP on 3100 with no args.

FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV PW_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    PORT=3100

# Install the MCP server globally so the binary is on PATH.
RUN npm install -g @playwright/mcp@latest \
 && npx --yes playwright install --with-deps chromium \
 && rm -rf /root/.npm

WORKDIR /app
EXPOSE 3100

# --isolated gives each MCP session a fresh browser context (matches
# Nimble's stateless-per-call semantics; avoids cross-session leakage).
# --headless is required for server-side use with no X server.
ENTRYPOINT ["npx", "@playwright/mcp"]
CMD ["--port", "3100", "--host", "0.0.0.0", "--headless", "--isolated"]
