# agent-browser-mcp — Vercel agent-browser exposed as a streamable-HTTP MCP server.
#
# agent-browser (github.com/vercel-labs/agent-browser) is a Rust CLI that drives
# Chrome for Testing over CDP and speaks MCP over stdio (`agent-browser mcp`).
# Our non-CLI (dapr-agent-py) agents consume tools over HTTP, so supergateway
# bridges the stdio MCP server to a streamable-HTTP endpoint at /mcp. Chrome is
# isolated in THIS image; the agent image stays untouched.
FROM node:22-bookworm-slim

# Chrome for Testing runtime libraries (the browser binary itself is fetched by
# `agent-browser install` below, so it always matches the pinned CLI version).
RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
	libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
	libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
	libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 curl xdg-utils \
	&& rm -rf /var/lib/apt/lists/*

# Pinned so the image is reproducible and the MCP tool surface is stable.
RUN npm install -g agent-browser@0.31.2 supergateway@3.4.3

# Pre-download Chrome for Testing into the image (version-matched to the CLI).
RUN agent-browser install

ENV PORT=8000 \
	AGENT_BROWSER_TOOLS=core \
	NODE_ENV=production
EXPOSE 8000

# stateful: browser state (the open page + @refs) persists across MCP calls
# within a client session — required for open -> snapshot -> click -> screenshot.
CMD ["sh", "-c", "supergateway --stdio \"agent-browser mcp --tools ${AGENT_BROWSER_TOOLS}\" --outputTransport streamableHttp --streamableHttpPath /mcp --port ${PORT} --stateful"]
